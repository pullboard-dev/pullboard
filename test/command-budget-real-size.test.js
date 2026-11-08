/** next, next --take, next --verify, claim and release each have p50 under one second at real board size [C7,#3019]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createE2eHelpers } from './e2e-helpers.js';
import { fileFixtureItem, joinFixtureSeat } from './testkit-fixture.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
/** The bars: a command is slow at a p50 of one second or more; 200 ms is the goal each run prints against [#3019]. */
const MAX_P50_MS = 1000;
const GOAL_MS = 200;
const ROUNDS = 5;

/** Seed the real tables at roughly the production population, so scans and per-seat reads show up. */
function seed(file) {
  const db = new DatabaseSync(file);
  const at = '2026-10-23T00:00:00.000Z';
  db.exec('BEGIN');
  const agent = db.prepare('INSERT INTO agent (agent_id, agent_lane, agent_path, agent_created_at) VALUES (?, ?, ?, ?)');
  for (let n = 1; n <= 800; n++) agent.run(`api-${n}`, 'api', `/seats/${n}`, at);
  const item = db.prepare(`INSERT INTO item (item_lane, item_title, item_criterion, item_status,
    item_created_by, item_created_at, item_updated_at) VALUES ('api', ?, 'The work is done.', 'open', 'coordinator', ?, ?)`);
  for (let n = 1; n <= 1000; n++) item.run(`Item ${n}`, at, at);
  const event = db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  for (let n = 0; n < 45000; n++) event.run(at, `api-${1 + n % 800}`, n % 40 === 0 ? 'join' : n % 2 ? 'claim' : 'edit', 1 + n % 1000, '{}');
  const meta = db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)');
  for (let n = 0; n < 150000; n++) meta.run(`local:note-${n}`, `value ${n}`);
  const shout = db.prepare('INSERT INTO shout (shout_from, shout_to, shout_text, shout_at) VALUES (?, ?, ?, ?)');
  for (let n = 0; n < 23000; n++) shout.run(`api-${1 + n % 800}`, 'all', `Board activity ${n}`, at);
  db.exec('COMMIT');
  db.close();
}

/** Run one real CLI process through the resident board and return its wall time and output; the command must not crash. */
function timed(box, cwd, ...args) {
  const started = performance.now();
  const result = box.run(cwd, ...args);
  const ms = performance.now() - started;
  assert.equal(typeof result.code, 'number', `${args.join(' ')} did not finish: ${result.err}`);
  return { ms, out: result.out, code: result.code, err: result.err };
}

/** The middle of a sample, by rank. */
const p50 = values => [...values].sort((a, b) => a - b)[values.length >> 1];

/** Measure the five commands on a real-size board and return each command's samples in ms. */
function measureCommands(box) {
  seed(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const dir = join(box.dir, 'web-budget');
  box.git(box.repo, 'worktree', 'add', '-q', dir, '-b', 'web/budget');
  assert.equal(joinFixtureSeat(box, dir, 'web').code, 0, 'the seat joins');
  const samples = { next: [], 'next --take': [], 'next --verify': [], claim: [], release: [] };
  for (let round = 0; round < ROUNDS; round++) {
    const ids = [0, 1].map(n => fileFixtureItem(box, box.repo, { lane: 'web', title: `Budget work ${round}.${n}` }).item_id);
    samples.next.push(timed(box, dir, 'next').ms);
    const taken = timed(box, dir, 'next', '--take');
    samples['next --take'].push(taken.ms);
    assert.equal(taken.code, 0, `next --take: ${taken.err}${taken.out}`);
    const held = ids.find(id => new RegExp(`#${id}\\b`).test(taken.out));
    assert.ok(held, `next --take names the item it claimed: ${taken.out}`);
    samples['next --verify'].push(timed(box, dir, 'next', '--verify').ms);
    const other = ids.find(id => id !== held);
    const claim = timed(box, dir, 'claim', String(other));
    samples.claim.push(claim.ms);
    assert.equal(claim.code, 0, `claim: ${claim.err}${claim.out}`);
    const release = timed(box, dir, 'release', String(held), '--reason', 'OTHER', '--note', 'measured the release', '--no-next');
    samples.release.push(release.ms);
    assert.equal(release.code, 0, `release: ${release.err}${release.out}`);
    assert.equal(box.run(dir, 'release', String(other), '--reason', 'OTHER', '--note', 'round done', '--no-next').code, 0);
  }
  return samples;
}

test('clause 1: next, next --take, next --verify, claim and release each have p50 under 1 s on the real-size board, printed against a 200 ms goal [C7,#3019]', t => {
  const samples = measureCommands(helpers.project('true'));
  const slow = [];
  for (const [name, values] of Object.entries(samples)) {
    const middle = p50(values);
    t.diagnostic(`${name}: p50 ${middle.toFixed(0)} ms against the ${GOAL_MS} ms goal and the ${MAX_P50_MS} ms bar (${middle < GOAL_MS ? 'meets' : 'misses'} the goal); samples ${values.map(ms => ms.toFixed(0)).join(' ')}`);
    if (!(middle < MAX_P50_MS)) slow.push(`${name} p50 ${middle.toFixed(0)} ms is not under ${MAX_P50_MS} ms`);
  }
  assert.deepEqual(slow, [], 'every command has a p50 under 1 s');
});

test('clause 2: the budget fails when any command has a p50 of 1 s or more [C7,#3019]', () => {
  const slow = { next: [50, 60, 70], 'next --take': [900, 1000, 1100], claim: [10, 20, 30] };
  const over = Object.entries(slow).filter(([, values]) => !(p50(values) < MAX_P50_MS)).map(([name]) => name);
  assert.deepEqual(over, ['next --take'], 'only the command at 1 s or more fails the bar');
  assert.equal(p50([999, 1000, 1001]) < MAX_P50_MS, false, 'a p50 of exactly one second fails');
});
