/** Durable gate 3/20: submit-handoff state changes shadow into job rows and steps [C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { openBoard } from '../apps/lib/index.js';
import { getItem } from '../packages/store/index.js';
import { writeBoardCommand } from '../packages/store/index.js';
import { completeSubmitHandoff } from '../packages/store/index.js';
import { startSubmitHandoff } from '../packages/store/index.js';
import { jobView } from '../packages/jobs/index.js';
import { fixtureAdd } from './testkit-fixture.js';

/** Build a project with a claimed item and one committed candidate, ready to queue. */
function queued(t) {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true', helpers.sandbox());
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, submit: { handoff: true } }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure native submit handoff [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Shadow job source', '--specs', 'G1',
    '--criterion', 'The candidate passes.', '--check', 'true', '--wait', '--json');
  assert.equal(added.code, 0, `${added.err}\n${added.out}`);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(box.web, 'claim', String(id), '--json').code, 0);
  assert.equal(helpers.commitFile(box, box.web, 'web/shadow.txt', 'x\n', 'feat(web): shadow candidate [G1]').status, 0);
  return { box, id, commit: box.git(box.web, 'rev-parse', 'HEAD') };
}

test('clause 1: queueing a hand-off creates a job row and every state change writes a step [C7]', (t) => {
  const { box, id, commit } = queued(t);
  const board = openBoard(box.boardFile, undefined, { gitRoot: box.web });
  try {
    const item = getItem(board, id);
    const tree = box.git(box.web, 'rev-parse', 'HEAD^{tree}');
    const options = { agentId: item.item_owner, job: randomUUID(), main: box.git(box.web, 'rev-parse', 'main'),
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
  } finally { board.db.close(); }
});

test('clause 1: a board without the job tables refuses a hand-off it has nowhere to record [C7]', (t) => {
  const { box, id, commit } = queued(t);
  const board = openBoard(box.boardFile, undefined, { gitRoot: box.web });
  try {
    board.db.exec('DROP TABLE job_step; DROP TABLE job');
    const item = getItem(board, id);
    const tree = box.git(box.web, 'rev-parse', 'HEAD^{tree}');
    const options = { agentId: item.item_owner, job: randomUUID(), main: box.git(box.web, 'rev-parse', 'main'),
      commit, tree, executionCommit: commit, executionTree: tree, digest: item.item_frozen_digest,
      companionDigest: null, leaseMs: 7_200_000 };
    // The job row is the only copy of the record (#3476), so the queue refuses rather than lose it.
    assert.throws(() => writeBoardCommand(board, 'queueSubmitHandoff', [id, options], item.item_owner), { code: 'JOB_TABLES_MISSING' });
    assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM board_meta WHERE meta_key GLOB 'submit_handoff:*'").get().n, 0);
  } finally { board.db.close(); }
});
