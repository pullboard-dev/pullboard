/** With runs_store on, the open-landing reader and applyLandingReceipt see the same landing state as with it off, for a queued, a landed and a trunk-busy landing [B2,P7,#9114]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { cellSandbox } from '../../../store/tests/fixtures/cell.js';
import { RUNS_STORE_KEY } from '../../../store/index.js';
import { applyLandingReceipt } from '../../src/io/gate.js';
import { offerLandingJob } from '../../index.js';
import { openLandingJob } from '../../index.js';
import { queueFor } from '../../index.js';

const STAMP = '2026-11-16T12:00:00.000Z';
const MAIN = 'a'.repeat(40);
const TRUNK = 'b'.repeat(40);
const CONFIG = { trunk: { remote: '/trunk.git' } };

/** A file board with item 7 accepted, the runs_store flag as asked, and one landing offered for item 7 (through the queue when on). */
function landing(t, flag) {
  const board = cellBoard(t, join(cellSandbox(t).dir, 'board.sqlite'), undefined, { real: true });
  board.db.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'landed', 'strong', 'open', 'coordinator', ?, ?)`).run(STAMP, STAMP);
  board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
    VALUES (7, 'core-2', 'ACCEPT', 'CRITERION_MET', 'fixture', ?, ?, ?, ?)`).run(MAIN, 'd'.repeat(64), MAIN, STAMP);
  board.db.exec('INSERT INTO temp.moving VALUES (1)');
  board.db.prepare(`UPDATE item SET item_status='verified', item_commit=?, item_owner='core-1', item_lease_until='2099-01-01T00:00:00.000Z', item_frozen_digest=?, item_built_by='core-1', item_verified_by='core-2', item_verdict='ACCEPT' WHERE item_id=7`)
    .run(MAIN, 'd'.repeat(64));
  board.db.exec('DELETE FROM temp.moving');
  if (flag) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(RUNS_STORE_KEY, '1');
  const queue = queueFor(board, 'coordinator');
  t.after(() => queue?.runs.db.close());
  const job = offerLandingJob(board.db, { items: [{ id: 7, commit: MAIN, ref: 'refs/pullboard/land/7' }], expect: MAIN, config: CONFIG, ...(queue ? { queue } : {}) });
  return { board, queue, job };
}

/** The state both flag settings must agree on: the open job (by whether it is the offered one), then the receipt's answer and the item. */
function afterReceipt(t, flag, receipt) {
  const { board, queue, job } = landing(t, flag);
  const open = openLandingJob(board.db) === job.id;
  const answer = applyLandingReceipt(board, { job: job.id, receipt }, queue ? { queue } : {});
  const item = board.db.prepare('SELECT item_status, item_merged_commit FROM item WHERE item_id = 7').get();
  return { open, answer, item: { ...item } };
}

test('api.landing-runs.queued-landing-open-landing-runs: clause 1: a queued landing is the open landing with runs_store on and off [B2,P7,#9114]', t => {
  for (const flag of [false, true]) {
    const { board, job } = landing(t, flag);
    assert.equal(openLandingJob(board.db), job.id, `runs_store ${flag ? 'on' : 'off'}: the offered landing is the open one`);
  }
});

test('api.landing-runs.landed-receipt-merges-same-items: clause 1: a landed receipt merges the same items with runs_store on and off [B2,P7,#9114]', t => {
  const receipt = { outcome: 'landed', trunk: TRUNK, landed: [7], already: [] };
  const off = afterReceipt(t, false, receipt);
  const on = afterReceipt(t, true, receipt);
  assert.deepEqual(on, off);
  assert.deepEqual(on.answer.merged, [7]);
  assert.equal(on.item.item_merged_commit, TRUNK);
});

test('api.landing-runs.trunk-busy-receipt-changes-item: clause 1: a trunk-busy receipt changes no item with runs_store on and off [B2,P7,#9114]', t => {
  const receipt = { outcome: 'trunk-busy' };
  const off = afterReceipt(t, false, receipt);
  const on = afterReceipt(t, true, receipt);
  assert.deepEqual(on, off);
  assert.equal(on.answer.applied, false);
  assert.equal(on.item.item_status, 'verified');
});
