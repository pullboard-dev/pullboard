/**
 * The history board seeds the live board's job, step, test-result, event and board_meta history at 1:4, so a speed
 * budget that runs on it measures the slow paths of `next` [C7,#12578].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../../../../../packages/store/index.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { HISTORY_BOARD, seedLargeBoard } from './large.js';

/** One count from a board file. */
function count(db, sql) {
  return Number(db.prepare(sql).get().n);
}

test('cli.fixtures-board-large.history-board-counts: clause 2: [C7] a board seeded with HISTORY_BOARD holds each live count at 1:4', (t) => {
  const { root } = privateFixtureFiles('history-board-');
  const file = join(root, 'board.sqlite');
  const setup = new DatabaseSync(file);
  setup.exec(SCHEMA);
  setup.close();
  const started = performance.now();
  seedLargeBoard(file, HISTORY_BOARD);
  const seconds = (performance.now() - started) / 1000;
  console.log(`history board seeded in ${seconds.toFixed(1)} s`);
  const db = new DatabaseSync(file, { readOnly: true });
  t.after(() => db.close());
  assert.equal(HISTORY_BOARD.ratio, '1:4');
  assert.equal(count(db, 'SELECT count(*) AS n FROM item'), 3_142);
  assert.equal(count(db, 'SELECT count(*) AS n FROM event'), 169_453);
  assert.equal(count(db, "SELECT count(*) AS n FROM event WHERE event_by = 'coordinator'"), 45_469);
  assert.equal(count(db, 'SELECT count(*) AS n FROM shout'), 27_966);
  assert.equal(count(db, 'SELECT count(*) AS n FROM agent'), 2_670);
  assert.equal(count(db, 'SELECT count(*) AS n FROM job_step'), 219_374);
  assert.equal(count(db, 'SELECT count(*) AS n FROM test_result'), 186_337);
  assert.equal(count(db, "SELECT count(*) AS n FROM job WHERE job_kind = 'test-run' AND job_step = 'done'"), 7_764);
  assert.equal(count(db, 'SELECT count(*) AS n FROM board_meta'), 203_897);
});
