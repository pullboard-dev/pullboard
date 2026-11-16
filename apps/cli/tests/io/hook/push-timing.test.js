/** With push.recordTiming on, a finished pre-push gate records its wall clock and per-shard times on the board, behind a default-off setting [C7,U151,#9371]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBoardMeta } from '../../../../../packages/store/index.js';
import { listBoardMetaWithPrefix } from '../../../../../packages/store/index.js';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { PUSH_TIMING_KEPT } from '../../../src/io/hook/push.js';
import { pushTimingRow } from '../../../src/io/hook/push.js';
import { recordPushTiming } from '../../../src/io/hook/push.js';

const plan = { shards: [{ files: ['a.test.js', 'b.test.js'] }, { files: ['c.test.js'] }] };
const posted = new Map([[0, { runner: 'r1', wallMs: 90_000 }], [1, { runner: 'r2', wallMs: 30_000 }]]);
const WALL = posted.get(0).wallMs + 5_000;
const rowAt = (source, at = '2026-11-16T10:00:00.000Z', timing = posted) => pushTimingRow({ source, at, wallMs: WALL, plan, timing });

/** A board and the write seam recordPushTiming takes. */
function board(t) {
  const { db } = cellBoard(t, ':memory:');
  return { db, write: work => work({ db }) };
}

test('clause 1: with push.recordTiming on, a finished gate writes one push.timing.<source> row with shards, files, runners, wallMs and each shard\'s time and runner [C7,U151,#9371]', t => {
  const { db, write } = board(t);
  assert.equal(recordPushTiming({}, rowAt('abc123def456'), { enabled: true, write }), true);
  const row = JSON.parse(readBoardMeta(db, 'push.timing.abc123def456'));
  assert.equal(row.shards, 2);
  assert.equal(row.files, 3);
  assert.equal(row.runners, 2);
  assert.equal(row.wallMs, WALL, 'the gate wall clock is kept');
  assert.deepEqual(row.parts, [{ files: 2, runner: 'r1', wallMs: 90_000 }, { files: 1, runner: 'r2', wallMs: 30_000 }]);
  assert.equal(listBoardMetaWithPrefix(db, 'push.timing.').length, 1, 'one row');
});

test('clause 1: with push.recordTiming off nothing is written [C7,U151,#9371]', t => {
  const { db, write } = board(t);
  assert.equal(recordPushTiming({}, rowAt('abc123def456'), { enabled: false, write }), false);
  assert.equal(listBoardMetaWithPrefix(db, 'push.timing.').length, 0);
});

test('clause 1: only the newest 20 rows are kept [C7,U151,#9371]', t => {
  const { db, write } = board(t);
  for (let at = 0; at < PUSH_TIMING_KEPT + 3; at += 1) {
    recordPushTiming({}, rowAt(`src${String(at).padStart(9, '0')}`, new Date(Date.UTC(2026, 10, 16, 10, at)).toISOString()), { enabled: true, write });
  }
  const keys = listBoardMetaWithPrefix(db, 'push.timing.').map(entry => entry.key);
  assert.equal(keys.length, PUSH_TIMING_KEPT);
  assert.ok(!keys.includes('push.timing.src000000000'), 'the oldest is gone');
  assert.ok(keys.includes(`push.timing.src${String(PUSH_TIMING_KEPT + 2).padStart(9, '0')}`), 'the newest stays');
});

test('clause 2: a red or unknown finish records a row too, with no time for a shard that posted nothing [C7,U151,#9371]', t => {
  const { db, write } = board(t);
  const unknown = rowAt('deadbeef0000', undefined, new Map([[0, { runner: 'r1', wallMs: 90_000 }]]));
  assert.equal(recordPushTiming({}, unknown, { enabled: true, write }), true);
  const row = JSON.parse(readBoardMeta(db, 'push.timing.deadbeef0000'));
  assert.deepEqual(row.parts[1], { files: 1, runner: null, wallMs: null });
  assert.equal(row.runners, 1);
});

test('clause 2: a write fault never changes the gate\'s answer, it only records nothing [C7,U151,#9371]', () => {
  const write = () => { throw new Error('database is locked'); };
  assert.equal(recordPushTiming({}, rowAt('abc123def456'), { enabled: true, write }), false);
});
