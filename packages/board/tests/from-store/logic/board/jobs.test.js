/** Durable gate 3/20: submit-handoff state changes shadow into job rows and steps [C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { jobView } from '../../../../../jobs/index.js';
import { completeSubmitHandoff } from '../../../../../store/index.js';
import { getItem } from '../../../../../store/index.js';
import { startSubmitHandoff } from '../../../../../store/index.js';
import { writeBoardCommand } from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { cellClaim } from '../../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../store/tests/fixtures/cell.js';

/** Build a project with a claimed item and one committed candidate, ready to queue. */
function queued(t) {
  const project = cellProject(t, { real: true, gate: 'true', config: { submit: { handoff: true } } });
  const web = join(project.dir, 'web');
  project.git(project.repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: web });
  const seat = cellSeat(board, { lane: 'web', path: web });
  const id = cellItem(board, { lane: 'web', title: 'Shadow job source', specIds: ['G1'], route: 'strong',
    criterion: 'The candidate passes.', check: 'true' }).item_id;
  cellClaim(board, id, seat, { root: web, itemFolder: true });
  mkdirSync(join(web, 'web'), { recursive: true });
  writeFileSync(join(web, 'web/shadow.txt'), 'x\n');
  project.git(web, 'add', '-A');
  assert.equal(project.tryGit(web, 'commit', '-q', '-m', 'feat(web): shadow candidate [G1]').status, 0);
  return { project, web, board, id, commit: project.git(web, 'rev-parse', 'HEAD') };
}

test('clause 1: queueing a hand-off creates a job row and every state change writes a step [C7]', (t) => {
  const { project, web, board, id, commit } = queued(t);
  const item = getItem(board, id);
  const tree = project.git(web, 'rev-parse', 'HEAD^{tree}');
  const options = { agentId: item.item_owner, job: randomUUID(), main: project.git(web, 'rev-parse', 'main'),
    commit, tree, executionCommit: commit, executionTree: tree, digest: item.item_frozen_digest,
    companionDigest: null, leaseMs: 7_200_000 };
  const queuedJob = writeBoardCommand(board, 'queueSubmitHandoff', [id, options], item.item_owner);
  let view = jobView(board.db, options.job);
  assert.equal(view.kind, 'gate');
  assert.equal(view.item, id);
  assert.equal(view.candidate, commit);
  assert.deepEqual(view.steps.map(step => step.name), ['queued']);
  const started = startSubmitHandoff(board, id, { agentId: item.item_owner, job: options.job });
  assert.equal(started.started, true);
  completeSubmitHandoff(board, id, { agentId: item.item_owner, job: queuedJob.job.id,
    result: { code: 1, error: { code: 'FIXTURE_FINISHED', message: 'The observation finished.', next: 'No worker was launched.' } } });
  view = jobView(board.db, options.job);
  assert.deepEqual(view.steps.map(step => step.name), ['queued', 'running', 'red']);
  assert.equal(view.step, 'red');
  assert.equal(view.steps[2].payload.error, 'FIXTURE_FINISHED');
});

test('clause 1: a board without the job tables refuses a hand-off it has nowhere to record [C7]', (t) => {
  const { project, web, board, id, commit } = queued(t);
  board.db.exec('DROP TABLE job_step; DROP TABLE job');
  const item = getItem(board, id);
  const tree = project.git(web, 'rev-parse', 'HEAD^{tree}');
  const options = { agentId: item.item_owner, job: randomUUID(), main: project.git(web, 'rev-parse', 'main'),
    commit, tree, executionCommit: commit, executionTree: tree, digest: item.item_frozen_digest,
    companionDigest: null, leaseMs: 7_200_000 };
  // The job row is the only copy of the record (#3476), so the queue refuses rather than lose it.
  assert.throws(() => writeBoardCommand(board, 'queueSubmitHandoff', [id, options], item.item_owner), { code: 'JOB_TABLES_MISSING' });
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM board_meta WHERE meta_key GLOB 'submit_handoff:*'").get().n, 0);
});
