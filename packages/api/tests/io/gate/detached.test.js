/** A green pulled gate whose receipt applies while the coordinator checkout is detached for a verify is submitted, not recorded as passed but not submitted [C7,#8011]. */
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
import { offerJob } from '../../../index.js';

test('a green pulled gate is submitted while the coordinator checkout is detached for review [C7,#8011]', t => {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const head = repo.commit;
  const tree = String(runFixtureGit(['rev-parse', `${head}^{tree}`], { cwd: repo.root }).stdout).trim();
  const job = `gate:${item.item_id}:detached`;
  offerJob(board.db, { id: job, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
    request: { run: ['true'], input: { data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [] } } });
  const lease = claimJob(board.db, { runner: 'r-detached', capabilities: [], now: 2 });
  // Every CLI command in the primary on its branch retains that trunk, as cli-main/run.js does before a verify detaches it.
  const branch = runFixtureGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo.root });
  runFixtureGit(['config', '--local', 'pullboard.trunk', branch], { cwd: repo.root });
  // Every verify in the primary checkout switches it to the submitted commit; another item's gate can finish meanwhile.
  runFixtureGit(['switch', '-q', '--detach', head], { cwd: repo.root });
  const posted = boardJobQueueCall(board, { action: 'receipt', job, runner: 'r-detached', token: lease.token,
    receipt: { version: 1, status: 0, gate: { source: head, green: true, phases: [{ role: 'proof', status: 0 }] } } }, { mode: 'pull', now: 3 });
  assert.equal(posted.applied.outcome, 'review', `${JSON.stringify(posted.applied)} ${store.itemThread(board, item.item_id).map(fact => fact.text).join(' | ')}`);
  const after = store.getItem(board, item.item_id);
  assert.equal(after.item_status, 'submitted');
  assert.equal(after.item_commit, head);
});
