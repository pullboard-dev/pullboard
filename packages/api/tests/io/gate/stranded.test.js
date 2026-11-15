/** A gate receipt the board recorded but never applied is applied on a later claim, so its item never stays claimed for good [C7,P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';
import * as store from '../../../../store/index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { jobQueueCall } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { STRANDED_RECEIPT_AGE_MS } from '../../../src/io/gate/stranded.js';

/** A pulled submit whose receipt was recorded with no apply, as a post whose apply threw leaves it. */
function strandedSubmit(t, receipt) {
  const repo = cellRepo(t);
  const board = cellBoard(t, repo.boardFile, undefined, { gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const head = repo.commit;
  const tree = String(runFixtureGit(['rev-parse', `${head}^{tree}`], { cwd: repo.root }).stdout).trim();
  const job = `gate:${item.item_id}:stranded`;
  offerJob(board.db, { id: job, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
    request: { run: ['true'], input: { data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [] } } });
  const lease = claimJob(board.db, { runner: 'r-stranded', capabilities: [], now: 2 });
  const posted = jobQueueCall(board.db, { action: 'receipt', job, runner: 'r-stranded', token: lease.token, receipt: receipt(head) }, { mode: 'pull', now: 3 });
  assert.equal(posted.recorded, true);
  const claim = now => boardJobQueueCall(board, { action: 'claim', runner: 'r-next', capabilities: [] }, { mode: 'pull', now });
  return { board, id: item.item_id, head, job, claim };
}

const green = head => ({ version: 1, status: 0, gate: { source: head, green: true, phases: [{ role: 'proof', status: 0 }] } });
const red = head => ({ version: 1, status: 1, gate: { source: head, green: false, phases: [{ role: 'proof', status: 1, failures: [{ file: 'web/page.test.js', name: 'the page renders' }] }] } });

test('a green receipt recorded without its apply submits the item on the next claim once it is old enough [C7,P7]', t => {
  const { board, id, head, job, claim } = strandedSubmit(t, green);
  assert.equal(board.db.prepare('SELECT job_step FROM job WHERE job_id = ?').get(job).job_step, 'done');
  claim(3 + STRANDED_RECEIPT_AGE_MS - 1);
  assert.equal(store.getItem(board, id).item_status, 'claimed', 'a receipt that may still be mid-apply is left to its own request');
  claim(3 + STRANDED_RECEIPT_AGE_MS + 1);
  const item = store.getItem(board, id);
  assert.equal(item.item_status, 'submitted', 'the recorded receipt reached its item');
  assert.equal(item.item_commit, head);
});

test('a red receipt recorded without its apply records its failing parts once, however many claims follow [C7,P7]', t => {
  const { board, id, job, claim } = strandedSubmit(t, red);
  for (const now of [40_000, 50_000, 60_000]) claim(now);
  assert.equal(store.getItem(board, id).item_status, 'claimed', 'a red gate keeps the item with its builder');
  const reds = store.itemThread(board, id).filter(fact => fact.text?.startsWith(`Gate job ${job} red at `));
  assert.equal(reds.length, 1, 'the red is recorded once');
});
