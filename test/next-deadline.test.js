/** Native routing retries stay finite, yield and retain real board custody at production scale [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import * as store from '../src/board.js';
import { nextProgress } from '../src/next-take.js';
import { fixture } from './next-take-fixture.js';
import { runFixtureChild } from './fixture-child.js';

/** Capture only progress stderr; the actual JSON result channel remains separate. */
function observer(options) {
  let stderr = '';
  const progress = nextProgress({ stderr: { write: text => { stderr += text; } } }, options);
  return { progress, stderr: () => stderr };
}

/** Turn an actual native claim refusal into the same retry metadata the CLI retains. */
function claimAttempt(box, item) {
  try { box.claim(item, box.seats.actor); return { item: store.getItem(box.board, item) }; }
  catch (error) {
    return { retry: true, retryDetail: { phase: 'claim', item, code: error.code, message: error.message } };
  }
}

test('an unchanged native claim refusal stops finitely and yields without losing the held claim [C7]', async t => {
  const box = await fixture(t);
  const held = box.add('Actual existing claim');
  const target = box.add('The selector and native guard disagree');
  box.claim(held, box.seats.actor);
  const { progress } = observer();
  t.after(progress.stop);
  let attempts = 0, yielded = false;
  setImmediate(() => { yielded = true; });
  await assert.rejects(async () => {
    for (;;) {
      attempts++;
      const found = await progress.run('claim', target, () => claimAttempt(box, target));
      assert.equal(found.retryDetail.code, 'ONE_CLAIM', 'the refusal comes from the unchanged native guard');
      await progress.retry(found);
    }
  }, error => error.code === 'NEXT_TIMEOUT' && error.message.includes(`#${target}`)
    && error.message.includes('ONE_CLAIM') && error.message.includes(`#${held}`));
  assert.equal(attempts, 3, 'unchanged eligibility cannot spin through resolved promises forever');
  assert.equal(yielded, true, 'a macrotask runs between real refused native attempts');
  assert.equal(store.getItem(box.board, held).item_owner, box.seats.actor.id);
  assert.equal(store.getItem(box.board, target).item_status, 'open');
});

test('a real peer claim race still retries and claims the next item once [C7]', async t => {
  const box = await fixture(t);
  const raced = box.add('A peer takes this after selection');
  const remaining = box.add('The next selection is still claimable');
  const { progress } = observer();
  t.after(progress.stop);
  box.claim(raced, box.seats.builder);
  const first = await progress.run('claim', raced, () => claimAttempt(box, raced));
  assert.equal(first.retryDetail.code, 'HELD');
  await progress.retry(first);
  const second = await progress.run('claim', remaining, () => claimAttempt(box, remaining));
  assert.equal(second.item.item_owner, box.seats.actor.id);
  assert.equal(store.getItem(box.board, raced).item_owner, box.seats.builder.id);
  const claims = box.board.db.prepare("SELECT item_id FROM event WHERE event_kind='claim' AND item_id=?").all(remaining);
  assert.equal(claims.length, 1, 'a retry never replays an already committed native claim');
});

test('a stalled phase prints its actual name and item once on stderr [C7]', async t => {
  // Budget: exercise the production timer mechanism on a bounded private component, without a ten-second sleep.
  const { progress, stderr } = observer({ phaseMs: 20, timeoutMs: 2_000 });
  t.after(progress.stop);
  const value = await progress.run('review merge check', 73, async () => { await pause(60); return 'completed'; });
  assert.equal(value, 'completed');
  assert.match(stderr(), /^next phase review merge check; item #73; \d+ ms\n$/u);
  assert.equal(stderr().split('\n').filter(Boolean).length, 1);
});

test('explicit idle waiting retains its duration and reports its reason without spending active budget [C7]', async t => {
  let clock = 0;
  const { progress, stderr } = observer({ now: () => clock });
  t.after(progress.stop);
  await progress.run('selection', null, () => { clock += 5; return null; });
  await progress.idle(['review #73 is held by a peer'], () => { clock += 120_000; });
  assert.equal(clock, 120_005, 'the deliberate wait keeps its requested wall-clock duration');
  await progress.run('selection', null, () => { clock += 5; return null; });
  await progress.idle(['review #73 is held by a peer'], () => { clock += 120_000; });
  assert.equal(stderr().split('next waiting for review #73 is held by a peer').length - 1, 2);
  await assert.rejects(progress.run('claim', 74, () => { clock += 60_000; }),
    error => error.code === 'NEXT_TIMEOUT' && error.message.includes('#74'));
});

/** Generate only private synthetic rows at the public table cardinalities observed on 28 Oct; copy no board history. */
function seedCurrentScale(box) {
  const db = box.board.db, at = box.clock.now().toISOString();
  db.exec('BEGIN');
  try {
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1900)
      INSERT INTO item(item_lane,item_title,item_criterion,item_created_by,item_created_at,item_updated_at)
      SELECT 'web','Generated scale item '||i,'Native routing retains custody.','coordinator',?,? FROM n`).run(at, at);
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1200)
      INSERT INTO agent(agent_id,agent_lane,agent_path,agent_created_at)
      SELECT 'scale-agent-'||i,'web',?||'/unregistered-scale-path-'||i,? FROM n`).run(box.root, at);
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<92000)
      INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail)
      SELECT ?,'coordinator','note',1+i%1900,'{}' FROM n`).run(at);
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<44000)
      INSERT INTO shout(shout_from,shout_to,shout_text,shout_at)
      SELECT 'coordinator','all','Generated activity '||i,? FROM n`).run(at);
    // Historical synthetic rejections add read volume, never ACCEPTs, execution receipts or active authority.
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2400)
      INSERT INTO verdict(item_id,verdict_by,verdict_decision,verdict_reason,verdict_commit,verdict_digest,verdict_head,verdict_at)
      SELECT 1+i%1900,'scale-agent-1','REJECT','TEST_FAILURE',?,?,?,? FROM n`).run('a'.repeat(40), 'b'.repeat(64), 'a'.repeat(40), at);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

test('next answers within sixty seconds on a generated private SQLite board of current size [C7]', async t => {
  const box = await fixture(t);
  seedCurrentScale(box);
  const counts = Object.fromEntries(['item', 'agent', 'event', 'verdict', 'shout'].map(name =>
    [name, box.board.db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n]));
  assert.ok(counts.item >= 1900 && counts.agent >= 1200 && counts.event >= 92000 && counts.shout >= 44000);
  const bin = fileURLToPath(new URL('../bin/pullboard.js', import.meta.url));
  const started = performance.now();
  // Budget: #1811 requires the real command to answer or refuse within sixty seconds, excluding fixture setup.
  const result = runFixtureChild(process.execPath, [bin, 'next', '--build', '--json'], {
    cwd: box.seats.actor.path, env: process.env, encoding: 'utf8', timeout: 60_000,
  });
  const elapsed = performance.now() - started;
  t.diagnostic(JSON.stringify({ generated: true, copiedPrivateHistory: false, counts, elapsedMs: elapsed,
    status: result.status, signal: result.signal, stderr: result.stderr }));
  assert.equal(result.signal, null, 'the fixture timeout must not stand in for a named native result');
  assert.ok(elapsed < 60_000, `next took ${elapsed} ms`); // budget: declared #1811 response bound is sixty seconds, excluding fixture setup.
  const document = JSON.parse(result.stdout);
  if (result.status === 0) {
    assert.equal(document.item.item_owner, box.seats.actor.id);
    assert.equal(store.getItem(box.board, document.item.item_id).item_owner, box.seats.actor.id);
  } else {
    assert.equal(result.status, 1, result.stderr);
    assert.ok(document.error?.code, 'a refusal must name the actual rule');
    assert.notEqual(document.error.code, 'USAGE', 'the real seeded routing command must run');
  }
});
