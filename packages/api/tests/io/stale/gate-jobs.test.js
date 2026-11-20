/** With gate.endStaleJobs on, a landed item's open gate-shard jobs end with its gate jobs, and the board landing reaches them; off, nothing ends [C7,#11817]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { endStaleGateJobs } from '../../../index.js';
import { jobViews } from '../../../index.js';
import { offerJob } from '../../../index.js';

const STAMP = '2026-11-16T12:00:00.000Z';
const MAIN = 'a'.repeat(40), TRUNK = 'b'.repeat(40), CANDIDATE = 'c'.repeat(40);
const SHARDS = ['gate:7:x:shard:1', 'gate:7:x:shard:2', 'gate:7:x:shard:3'];
const OTHER = 'gate:8:y:shard:1';

/** A board with item 7 verified, one open gate job and three open shards for it, one shard of item 8, and one claimed land job offered for item 7 before the rest. */
function landing(t) {
  const board = cellBoard(t, ':memory:');
  board.db.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'landed', 'strong', 'open', 'coordinator', ?, ?)`).run(STAMP, STAMP);
  board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
    VALUES (7, 'core-2', 'ACCEPT', 'CRITERION_MET', 'fixture', ?, ?, ?, ?)`).run(MAIN, 'd'.repeat(64), MAIN, STAMP);
  board.db.exec('INSERT INTO temp.moving VALUES (1)');
  board.db.prepare(`UPDATE item SET item_status='verified', item_commit=?, item_owner='core-1', item_lease_until='2099-01-01T00:00:00.000Z', item_frozen_digest=?, item_built_by='core-1', item_verified_by='core-2', item_verdict='ACCEPT' WHERE item_id=7`)
    .run(MAIN, 'd'.repeat(64));
  board.db.exec('DELETE FROM temp.moving');
  offerJob(board.db, { id: 'land:1:k', kind: 'land', base: MAIN, needs: [], payload: { items: [{ id: 7 }] }, now: 1 });
  const held = claimJob(board.db, { runner: 'r-land', capabilities: [], now: 2 });
  offerJob(board.db, { id: 'gate:7:x', kind: 'gate', needs: [], item: 7, candidate: CANDIDATE, now: 3 });
  for (const id of SHARDS) offerJob(board.db, { id, kind: 'gate-shard', needs: [], item: 7, candidate: CANDIDATE, now: 3 });
  offerJob(board.db, { id: OTHER, kind: 'gate-shard', needs: [], item: 8, candidate: CANDIDATE, now: 3 });
  const post = options => boardJobQueueCall(board, { action: 'receipt', job: 'land:1:k', runner: 'r-land', token: held.token, receipt: { kind: 'land', outcome: 'landed', trunk: TRUNK, landed: [7], already: [] } }, { mode: 'pull', now: 4, ...options });
  return { board, post };
}

/** The step of each named job. */
const steps = (board, ids) => jobViews(board.db, ids).map(view => view.step);

test('api.io-stale-gate-jobs.ends-the-items-open-shards: clause 1: endStaleGateJobs ends a landed item\'s 3 open gate-shard jobs with its gate job, as withdrawn, and ends them once [C7,#11817]', t => {
  const { board } = landing(t);
  const ended = endStaleGateJobs(board.db, { item: 7, enabled: true, now: 10 });
  assert.deepEqual(ended.sort(), ['gate:7:x', ...SHARDS].sort());
  assert.deepEqual(steps(board, SHARDS), ['done', 'done', 'done']);
  assert.ok(jobViews(board.db, SHARDS).every(view => view.steps.some(step => step.name === 'withdrawn')), 'each shard records a withdrawal');
  assert.deepEqual(endStaleGateJobs(board.db, { item: 7, enabled: true, now: 11 }), [], 'ended jobs end only once');
});

test('api.io-stale-gate-jobs.leaves-other-items-shards: clause 1: a shard of another item stays open, and with gate.endStaleJobs off nothing ends [C7,#11817]', t => {
  const { board } = landing(t);
  assert.deepEqual(endStaleGateJobs(board.db, { item: 7, now: 10 }), [], 'off by default');
  assert.deepEqual(steps(board, SHARDS), ['offered', 'offered', 'offered']);
  endStaleGateJobs(board.db, { item: 7, enabled: true, now: 10 });
  assert.deepEqual(steps(board, [OTHER]), ['offered'], 'the other item\'s shard is untouched');
});

test('api.io-stale-gate-jobs.board-landing-ends-shards: clause 2: the board landing with gate.endStaleJobs on ends the landed item\'s gate job and its shards, and with it off all stay open [C7,#11817]', t => {
  const on = landing(t);
  on.post({ endStale: true });
  assert.equal(on.board.db.prepare('SELECT item_merged_commit FROM item WHERE item_id = 7').get().item_merged_commit, TRUNK, 'the item landed');
  assert.deepEqual(steps(on.board, ['gate:7:x', ...SHARDS]), ['done', 'done', 'done', 'done']);
  assert.deepEqual(steps(on.board, [OTHER]), ['offered']);
  const off = landing(t);
  off.post({});
  assert.deepEqual(steps(off.board, ['gate:7:x', ...SHARDS]), ['offered', 'offered', 'offered', 'offered']);
});
