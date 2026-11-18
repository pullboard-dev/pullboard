/** A submit settles under pull with no dispatcher row on the board: a runner pulls the gate job and its green receipt submits the item [C7,#8172]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { headTree } from '../../../../git/index.js';
import * as store from '../../../../store/index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';

/** The kinds of every job row the board holds, sorted. */
function jobKinds(board) {
  return board.db.prepare('SELECT job_kind AS kind FROM job ORDER BY job_kind').all().map(row => row.kind);
}

test('api.gate-pull-settles.gate-offered-pull-job-settles: a gate offered as a pull job settles the submit with no dispatcher row on the board [C7,#8172]', t => {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const head = repo.commit;
  const tree = headTree(repo.root);
  const job = `gate:${item.item_id}:pull`;
  offerJob(board.db, { id: job, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
    request: { run: ['true'], input: { data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [] } } });
  assert.deepEqual(jobKinds(board), ['gate'], 'the offer adds the gate job and no dispatcher row');
  const lease = claimJob(board.db, { runner: 'r-pull', capabilities: [], now: 2 });
  assert.equal(lease?.job, job, 'the runner pulls the offered gate');
  const posted = boardJobQueueCall(board, { action: 'receipt', job, runner: 'r-pull', token: lease.token,
    receipt: { version: 1, status: 0, gate: { source: head, green: true, phases: [{ role: 'proof', status: 0 }] } } }, { mode: 'pull', now: 3 });
  assert.equal(posted.applied.outcome, 'review', JSON.stringify(posted.applied));
  const after = store.getItem(board, item.item_id);
  assert.equal(after.item_status, 'submitted');
  assert.equal(after.item_commit, head);
  assert.ok(!jobKinds(board).includes('dispatcher'), 'no dispatcher row appeared while the submit settled');
});
