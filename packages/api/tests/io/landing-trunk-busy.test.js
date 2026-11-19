/** landing.reofferTrunkBusy: a trunk-busy land receipt offers the landing again after a backoff; off, it applies as before [C7,#9102]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { boardJobQueueCall } from '../../index.js';
import { claimJob } from '../../index.js';
import { offerJob } from '../../index.js';

const STAMP = '2026-11-16T12:00:00.000Z';
const MAIN = 'a'.repeat(40);
const BUSY = { kind: 'land', outcome: 'trunk-busy', landed: [], already: [], attempts: 5, detail: 'trunk moved under each of 5 attempts; offer the landing again' };

/** A board with item 7 verified and one claimed land job offered for it; post sends the land receipt with the setting given. */
function landing(t) {
  const board = cellBoard(t, ':memory:');
  board.db.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'busy', 'strong', 'open', 'coordinator', ?, ?)`).run(STAMP, STAMP);
  board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
    VALUES (7, 'core-2', 'ACCEPT', 'CRITERION_MET', 'fixture', ?, ?, ?, ?)`).run(MAIN, 'd'.repeat(64), MAIN, STAMP);
  board.db.exec('INSERT INTO temp.moving VALUES (1)');
  board.db.prepare(`UPDATE item SET item_status='verified', item_commit=?, item_owner='core-1', item_lease_until='2099-01-01T00:00:00.000Z', item_frozen_digest=?, item_built_by='core-1', item_verified_by='core-2', item_verdict='ACCEPT' WHERE item_id=7`)
    .run(MAIN, 'd'.repeat(64));
  board.db.exec('DELETE FROM temp.moving');
  offerJob(board.db, { id: 'land:1:k', kind: 'land', base: MAIN, needs: [], payload: { items: [{ id: 7 }] }, now: 1 });
  const held = claimJob(board.db, { runner: 'r-land', capabilities: [], now: 2 });
  const post = (receipt, options = {}) => boardJobQueueCall(board, { action: 'receipt', job: 'land:1:k', runner: 'r-land', token: held.token, receipt }, { mode: 'pull', now: 3, ...options });
  return { board, post };
}

const status = board => board.db.prepare('SELECT item_status, item_merged_commit FROM item WHERE item_id = 7').get();
const jobs = board => board.db.prepare('SELECT job_id FROM job ORDER BY job_id').all().map(row => row.job_id);
const notes = board => board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id = 7 AND event_kind = 'fact'").get().n;

test('api.landing-trunk-busy.landing-reoffertrunkbusy-trunk-busy-receipt: clause 1: with landing.reofferTrunkBusy on, a trunk-busy receipt offers the landing again after a backoff and leaves the item verified [C7,#9102]', t => {
  const { board, post } = landing(t);
  post(BUSY, { reofferTrunkBusy: true });
  assert.deepEqual(jobs(board), ['land:1:k', 'land:1:k~r1'], 'the landing is offered again as its first retry');
  assert.deepEqual({ ...status(board) }, { item_status: 'verified', item_merged_commit: null });
  assert.ok(!claimJob(board.db, { runner: 'r-other', capabilities: [], now: 4 }), 'no runner takes the retry during the backoff');
  const later = claimJob(board.db, { runner: 'r-other', capabilities: [], now: 3 + 30_001 });
  assert.equal(later?.job, 'land:1:k~r1', 'the retry is claimable once the backoff has passed');
  assert.deepEqual(later.payload, { items: [{ id: 7 }] }, 'with the same landing payload');
});

test('api.landing-trunk-busy.landing-reoffertrunkbusy-off-default-trunk: clause 2: with landing.reofferTrunkBusy off (the default), a trunk-busy receipt is applied as on main: no new job, the item stays verified [C7,#9102]', t => {
  const off = landing(t);
  const before = notes(off.board);
  off.post(BUSY);
  assert.deepEqual(jobs(off.board), ['land:1:k'], 'nothing offers the landing again');
  assert.deepEqual({ ...status(off.board) }, { item_status: 'verified', item_merged_commit: null });
  assert.equal(notes(off.board), before, 'no note is added to the item');
  const explicit = landing(t);
  explicit.post(BUSY, { reofferTrunkBusy: false });
  assert.deepEqual(jobs(explicit.board), ['land:1:k']);
});
