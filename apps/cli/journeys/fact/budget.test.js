/** @pullboard-test-loads apps/cli/pullboard.js apps/cli/tests/fixtures/lock/hold/budget/preload.js */
/** Real policy reads must precede the actual SQLite writer lease [B2,C7,V4]. */
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { familyName } from '../../../../packages/verify/index.js';
import { seatFamily } from '../../../../packages/items/index.js';
import { assertCommandHoldBudget } from '../../tests/fixtures/lock/hold/budget/command.js';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { openBoard } from '../../../lib/index.js';
import { atomic } from '../../../../packages/store/index.js';
import { withOpenedBoard } from '../../index.js';
import { repoInfo } from '../../../../packages/git/index.js';

/** Commit real accepted-source aliases without changing any production assertion. */
function declare(box, alias) {
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, families: { openai: [alias] } }));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: fixture accepted policy');
}

/** The production opener owns this file board; the peer observes its actual writer lock. */
function setup(t) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  declare(box, 'codex');
  const directory = join(box.repo, '.git', 'policy-lock-test');
  mkdirSync(directory);
  // @pullboard-board-file locking: a separate SQLite connection must observe the actual writer lease.
  const board = openBoard(join(directory, 'board.sqlite'));
  const peer = new DatabaseSync(join(directory, 'board.sqlite'));
  peer.exec('PRAGMA busy_timeout=0');
  t.after(() => peer.close());
  const ctx = { info: repoInfo(box.repo), io: {} };
  return { box, board, peer, ctx };
}

test('accepted-policy Git reads admit a real competing writer before BEGIN [B2,C7,V4]', t => {
  const { board, peer, ctx } = setup(t);
  const original = cp.spawnSync;
  let observed = 0;
  /** Observe only actual committed policy reads; retain native arguments, receiver, result and errors. */
  function observe(...args) {
    if (args[0] === 'git' && args[1]?.some(arg => typeof arg === 'string' && arg.endsWith(':pullboard.json'))) {
      peer.exec('BEGIN IMMEDIATE');
      try { observed++; } finally { peer.exec('ROLLBACK'); }
    }
    return Reflect.apply(original, this, args);
  }
  Object.defineProperties(observe, Object.getOwnPropertyDescriptors(original));
  cp.spawnSync = observe;
  syncBuiltinESMExports();
  try {
    withOpenedBoard(ctx, opened => atomic(opened, () => {
      assert.ok(opened.familyAliases);
      assert.equal(typeof opened.quarantineEnabled(), 'boolean');
    }), board);
  } finally {
    cp.spawnSync = original;
    syncBuiltinESMExports();
  }
  assert.ok(observed > 0, 'the assertion observed real Git, not a synthetic policy provider');
  assert.equal(Object.hasOwn(board, 'prepareWritePolicy'), false, 'the scoped provider is removed');
});

test('changed accepted main retries only before work and reads the new policy [B2,C7,V4]', t => {
  const { board, ctx, box } = setup(t);
  const original = board.db.exec;
  let changed = false, work = 0;
  /** Inject one actual private ref advance immediately after admission, before the transaction callback. */
  board.db.exec = function (sql) {
    const value = Reflect.apply(original, this, [sql]);
    if (!changed && /^BEGIN IMMEDIATE/u.test(sql)) { changed = true; declare(box, 'new-codex'); }
    return value;
  };
  withOpenedBoard(ctx, opened => atomic(opened, () => {
    work++;
    assert.equal(opened.familyAliases.get('new-codex'), 'openai');
    assert.equal(opened.familyAliases.has('codex'), false);
  }), board);
  assert.equal(changed, true);
  assert.equal(work, 1, 'no arbitrary transaction callback is replayed');
});

test('explicit quarantine overrides remain authoritative and scoped descriptors restore [C7,V4]', t => {
  const { board, ctx } = setup(t);
  const original = () => 'original';
  Object.defineProperty(board, 'prepareWritePolicy', { configurable: true, enumerable: false, value: original });
  withOpenedBoard(ctx, opened => {
    opened.quarantineEnabled = () => true;
    return atomic(opened, () => assert.equal(opened.quarantineEnabled(), true));
  }, board);
  assert.equal(board.prepareWritePolicy, original);
  assert.equal(Object.getOwnPropertyDescriptor(board, 'prepareWritePolicy').enumerable, false);
});

test('a policy change during work refuses without replaying work or hiding the new source [B2,C7,V4]', t => {
  const { board, ctx, box, peer } = setup(t);
  let work = 0;
  assert.throws(() => withOpenedBoard(ctx, opened => atomic(opened, () => {
    work++;
    board.db.prepare('INSERT INTO agent(agent_id,agent_lane,agent_path,agent_created_at) VALUES(?,?,?,?)').run('rolled-back-seat', 'core', '/fixture/rolled-back', '2026-10-28T00:00:00Z');
    declare(box, 'changed-during-work');
    return opened.familyAliases;
  }), board), error => error.code === 'POLICY_SNAPSHOT_STALE');
  assert.equal(work, 1);
  assert.equal(peer.prepare('SELECT agent_id FROM agent WHERE agent_id=?').get('rolled-back-seat'), undefined, 'the actual SQL mutation rolls back');
  assert.equal(Object.hasOwn(board, 'prepareWritePolicy'), false);
});

test('unavailable preparation preserves earlier refusal and diagnoses actual lazy evaluation [C7,V4]', t => {
  const { board, ctx, box } = setup(t);
  // A detached primary is a real unavailable main-policy state, while every committed config stays valid.
  box.git(box.repo, 'checkout', '-q', '--detach', 'HEAD');
  const lines = [];
  ctx.io.err = line => lines.push(line);
  const first = new Error('original earlier guard');
  withOpenedBoard(ctx, opened => {
    assert.throws(() => atomic(opened, () => { throw first; }), error => error === first);
    assert.deepEqual(lines, [], 'preparation failure is not a consuming guard');
    assert.throws(() => atomic(opened, () => opened.quarantineEnabled()), error => error.code === 'NO_POLICY');
    assert.deepEqual(lines, ['PULLBOARD_WRITE_POLICY_FALLBACK input=quarantine']);
    // Recovery in the same opened command must not replay a previously captured refusal.
    atomic(opened, () => {
      box.git(box.repo, 'checkout', '-q', 'main');
      assert.equal(typeof opened.quarantineEnabled(), 'boolean');
    });
    assert.deepEqual(lines, ['PULLBOARD_WRITE_POLICY_FALLBACK input=quarantine', 'PULLBOARD_WRITE_POLICY_FALLBACK input=quarantine']);
  }, board);
});


test('800 historical seats use two policy witnesses per real writer, with median hold under one second [B2,C7,V4]', t => {
  const { board, ctx } = setup(t);
  // Private historical rows exercise live production family SQL; these are not proof or registration receipts.
  const add = board.db.prepare('INSERT INTO agent(agent_id,agent_lane,agent_path,agent_family,agent_created_at) VALUES(?,?,?,?,?)');
  for (let n = 0; n < 800; n++) add.run(`historical-${n}`, 'core', `/fixture/${n}`, n % 2 ? 'Claude' : 'codex', '2026-10-28T00:00:00Z');
  const seats = board.db.prepare('SELECT agent_id FROM agent ORDER BY agent_id').all();
  const originalRead = fs.readFileSync;
  const originalExec = board.db.exec;
  const packed = join(ctx.info.commonDir, 'packed-refs');
  let held = false, started = 0, scans = 0;
  const holds = [];
  /** Count exact packed-ref byte scans only while the real SQLite writer is held. */
  function observe(...args) {
    if (held && args[0] === packed) scans++;
    return Reflect.apply(originalRead, this, args);
  }
  Object.defineProperties(observe, Object.getOwnPropertyDescriptors(originalRead));
  /** Measure successful BEGIN acquisition through actual COMMIT completion, excluding admission wait. */
  board.db.exec = function (sql) {
    const result = Reflect.apply(originalExec, this, [sql]);
    if (/^BEGIN IMMEDIATE/u.test(sql)) { held = true; started = performance.now(); }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') { if (held) holds.push(performance.now() - started); held = false; }
    return result;
  };
  fs.readFileSync = observe;
  syncBuiltinESMExports();
  try {
    withOpenedBoard(ctx, opened => {
      for (let cycle = 0; cycle < 3; cycle++) atomic(opened, () => {
        let openai = 0;
        for (const seat of seats) {
          if (familyName(seatFamily(opened, seat.agent_id), opened.familyAliases) === 'openai') openai++;
          opened.quarantineEnabled();
        }
        assert.equal(openai, 400, 'all mutable seat facts use the production SQL reader');
      });
    }, board);
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
  }
  assert.equal(scans, 6, 'three writes each check after BEGIN and before COMMIT, independent of 800 getter reads');
  assert.equal(holds.length, 3);
  const median = [...holds].sort((a, b) => a - b)[1];
  assert.ok(median < 1000, `median real writer hold ${median.toFixed(3)}ms exceeds 1000ms; samples=${JSON.stringify(holds)}`);
});


test('actual claim release submit verify medians stay under one second and API reads acquire no writer [B2,C7,V4]', async t => {
  await assertCommandHoldBudget(t);
});
