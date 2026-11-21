/** A passing gate receipt with a proof plan offers its shards at the candidate rebuilt on the trunk head, through the board's job queue call [C7,#12165]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { git } from '../../../../git/index.js';
import { headTree } from '../../../../git/index.js';
import * as store from '../../../../store/index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { offeredStep } from '../../../src/io/gate.js';

/**
 * A claimed item whose gate job a runner holds, over a repository whose candidate and trunk both moved on from the claim base.
 * With `trunkHasCandidate`, the trunk head is the candidate itself, so there is nothing to rebuild.
 */
function gateAt(t, { trunkHasCandidate, conflict = false }) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const base = repo.commit;
  git(repo.root, ['config', 'user.name', 'Gate Test']);
  git(repo.root, ['config', 'user.email', 'gate@example.invalid']);
  git(repo.root, ['checkout', '-q', '-b', 'candidate', base]);
  repo.put('candidate-only.txt', 'candidate\n');
  if (conflict) { repo.put('b-shared.txt', 'candidate\n'); repo.put('a-shared.txt', 'candidate\n'); }
  const candidate = repo.commitAll();
  const tree = headTree(repo.root);
  git(repo.root, ['checkout', '-q', '-b', 'trunk', trunkHasCandidate ? candidate : base]);
  if (!trunkHasCandidate) repo.put('trunk-only.txt', 'trunk\n');
  if (conflict) { repo.put('b-shared.txt', 'trunk\n'); repo.put('a-shared.txt', 'trunk\n'); }
  const trunk = trunkHasCandidate ? candidate : repo.commitAll();
  const job = `gate:${item.item_id}:rebase`;
  offerJob(board.db, { id: job, kind: 'gate', needs: [], item: item.item_id, candidate, base, now: 1,
    request: { run: ['true'], input: { entry: 'gate.js', data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [] } } });
  const lease = claimJob(board.db, { runner: 'r-gate', capabilities: [], now: 2 });
  assert.equal(lease?.job, job, 'the runner pulls the offered gate');
  const gate = { version: 1, source: candidate, green: false, deferred: true, phases: [{ role: 'check', status: 0 }],
    proofPlan: { runner: 'node --test', cores: 2, files: ['web/a.test.js', 'web/b.test.js', 'web/c.test.js', 'web/d.test.js'] } };
  /** Post the receipt through the board's job queue call, with the trunk port main.js passes unless `port` is false. */
  const post = ({ port = true } = {}) => boardJobQueueCall(board, { action: 'receipt', job, runner: 'r-gate', token: lease.token, receipt: { version: 1, status: 0, gate } },
    { mode: 'pull', now: 3, ...(port ? { trunk: () => repo.root } : {}) });
  return { repo, board, base, candidate, trunk, job, post };
}

/** Each shard job the board offered for a gate job: the job row's candidate and base, and the request's source and main. */
function shardRows(board, job) {
  return board.db.prepare('SELECT job_id, job_candidate, job_base FROM job WHERE job_id LIKE ? ORDER BY job_id').all(`${job}:shard:%`).map(row => {
    const { request } = offeredStep(board.db, row.job_id);
    return { candidate: row.job_candidate, base: row.job_base, source: request.input.data.source, main: request.input.data.main, inputMain: request.input.main };
  });
}

test('api.gate.rebase-before-shards.rebuilt-on-main: clause 1: a passing gate receipt with a proof plan, posted through boardJobQueueCall when the trunk head is not in the candidate, offers every shard at the candidate rebuilt on the trunk head, with the head as base [C7,#12165]', t => {
  const { repo, board, candidate, trunk, job, post } = gateAt(t, { trunkHasCandidate: false });
  const posted = post();
  assert.equal(posted.applied.outcome, 'sharded', JSON.stringify(posted.applied));
  const rows = shardRows(board, job);
  assert.equal(rows.length, 2, 'both shard jobs were offered');
  const [rebuilt] = [...new Set(rows.map(row => row.candidate))];
  assert.notEqual(rebuilt, candidate, 'the shards carry a rebuilt commit, not the candidate the gate judged');
  for (const row of rows) assert.deepEqual(row, { candidate: rebuilt, base: trunk, source: rebuilt, main: trunk, inputMain: trunk });
  assert.deepEqual(git(repo.root, ['rev-list', '--parents', '-n', '1', rebuilt]).split(' '), [rebuilt, candidate, trunk], 'the rebuilt commit has the candidate and the trunk head as parents');
  assert.equal(git(repo.root, ['show', `${rebuilt}:trunk-only.txt`]), 'trunk', 'trunk\'s change is in the rebuilt tree');
  assert.equal(git(repo.root, ['show', `${rebuilt}:candidate-only.txt`]), 'candidate', 'the candidate\'s change is still there');
});

test('api.gate.rebase-before-shards.current-unchanged: clause 2: when the trunk head is already in the candidate, or the call has no trunk port, the shards are offered at the unchanged candidate and base [C7,#12165]', t => {
  const current = gateAt(t, { trunkHasCandidate: true });
  assert.equal(current.post().applied.outcome, 'sharded');
  for (const row of shardRows(current.board, current.job)) assert.deepEqual(row, { candidate: current.candidate, base: current.base, source: current.candidate, main: current.base, inputMain: current.base });
  const bare = gateAt(t, { trunkHasCandidate: false });
  const posted = bare.post({ port: false });
  assert.equal(posted.applied.outcome, 'sharded', JSON.stringify(posted.applied));
  for (const row of shardRows(bare.board, bare.job)) assert.equal(row.candidate, bare.candidate, 'with no trunk port nothing is rebuilt');
});

test('api.gate.rebase-before-shards.conflict-returns: clause 1: when rebuildOnTrunk reports conflicts for the gate candidate, the receipt offers no shard, the item returns to its builder with a fact naming each conflicting file, and the gate job offers nothing further [C7,#12411]', t => {
  const { board, job, candidate, trunk, post } = gateAt(t, { trunkHasCandidate: false, conflict: true });
  const item = board.db.prepare('SELECT job_item FROM job WHERE job_id = ?').get(job).job_item;
  const posted = post();
  assert.equal(posted.applied.outcome, 'conflict', JSON.stringify(posted.applied));
  assert.deepEqual(posted.applied.conflicts, ['a-shared.txt', 'b-shared.txt']);
  assert.equal(shardRows(board, job).length, 0, 'no shard job was offered');
  const note = board.db.prepare("SELECT event_detail FROM event WHERE item_id = ? AND event_kind = 'fact'").all(item).map(row => JSON.parse(row.event_detail).text ?? '').find(text => text.includes('could not merge'));
  assert.ok(note, 'the item carries a fact about the conflict');
  assert.ok(note.includes('a-shared.txt') && note.includes('b-shared.txt'), note);
  assert.ok(note.includes(candidate.slice(0, 12)) && note.includes(trunk.slice(0, 12)), note);
  assert.ok(note.includes('merge current main, resolve the conflict, commit and resubmit'), note);
  assert.equal(store.getItem(board, item).item_status, 'claimed', 'the item stays with its builder');
});
