/**
 * The history board seeds the live board's job, step, test-result, event and board_meta history at 1:4, so a speed
 * budget that runs on it measures the slow paths of `next` [C7,#12578].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { HISTORY_BOARD } from './large.js';
import { largeBoard } from './large.js';

/** One count from a board file. */
function count(db, sql) {
  return Number(db.prepare(sql).get().n);
}

test('cli.fixtures-board-large.history-board-counts: clause 2: [C7] a board seeded with HISTORY_BOARD holds each live count at 1:4', (t) => {
  const started = performance.now();
  const { board } = largeBoard(t, { scale: HISTORY_BOARD });
  const seconds = (performance.now() - started) / 1000;
  console.log(`history board project and seed took ${seconds.toFixed(1)} s`);
  const db = new DatabaseSync(board, { readOnly: true });
  t.after(() => db.close());
  assert.equal(HISTORY_BOARD.ratio, '1:4');
  assert.equal(count(db, "SELECT count(*) AS n FROM item WHERE item_title LIKE 'Seeded item %'"), 3_142);
  assert.equal(count(db, "SELECT count(*) AS n FROM event WHERE event_at < '2026-11-01'"), 169_453);
  assert.equal(count(db, "SELECT count(*) AS n FROM event WHERE event_by = 'coordinator' AND event_at < '2026-11-01'"), 45_469);
  assert.equal(count(db, 'SELECT count(*) AS n FROM shout'), 27_966);
  assert.equal(count(db, "SELECT count(*) AS n FROM agent WHERE agent_path LIKE '/gone/%'"), 2_670);
  assert.equal(count(db, 'SELECT count(*) AS n FROM job_step'), 219_374);
  assert.equal(count(db, 'SELECT count(*) AS n FROM test_result'), 186_337);
  assert.equal(count(db, "SELECT count(*) AS n FROM job WHERE job_kind = 'test-run' AND job_step = 'done'"), 7_764);
  assert.equal(count(db, "SELECT count(*) AS n FROM board_meta WHERE meta_key LIKE 'local:seed:%'"), 203_897);
});
