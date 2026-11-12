/** Durable A1: the jobs cell owns the submit hand-off record and submitHandoff() reads it from the gate job [C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { openBoard } from '../../../lib/index.js';
import { submitHandoffRecord } from '../../../lib/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { writeBoardCommand } from '../../../../packages/store/index.js';
import { completeSubmitHandoff } from '../../../../packages/store/index.js';
import { startSubmitHandoff } from '../../../../packages/store/index.js';
import { submitHandoff } from '../../../../packages/store/index.js';
import { endedSubmitHandoff } from '../../../../packages/store/index.js';
import { adoptLegacyHandoffs } from '../../../../packages/store/index.js';
import { missingJobTables } from '../../../../packages/store/index.js';
import { jobView } from '../../../../packages/jobs/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

/** Build a project with a claimed item and one committed candidate, ready to queue. */
function claimed(t) {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true', helpers.sandbox());
  // The kit wrote exactly its shared CONFIG with this gate, so the hand-off setting is added to that, not reread.
  const configFile = join(box.repo, 'pullboard.json');
  writeFileSync(configFile, JSON.stringify({ ...helpers.CONFIG, gate: 'true', submit: { handoff: true } }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure native submit handoff [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Hand-off record source', '--specs', 'G1',
    '--criterion', 'The candidate passes.', '--check', 'true', '--wait', '--json');
  assert.equal(added.code, 0, `${added.err}\n${added.out}`);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(box.web, 'claim', String(id), '--json').code, 0);
  assert.equal(helpers.commitFile(box, box.web, 'web/record.txt', 'x\n', 'feat(web): record candidate [G1]').status, 0);
  return { box, id, commit: box.git(box.web, 'rev-parse', 'HEAD') };
}

/** Queue the item's candidate as its claimed owner and return the queue options. */
function queue(box, board, id, commit) {
  const item = getItem(board, id);
  const tree = box.git(box.web, 'rev-parse', 'HEAD^{tree}');
  const options = { agentId: item.item_owner, job: randomUUID(), main: box.git(box.web, 'rev-parse', 'main'),
    commit, tree, executionCommit: commit, executionTree: tree, digest: item.item_frozen_digest,
    companionDigest: null, leaseMs: 7_200_000 };
  writeBoardCommand(board, 'queueSubmitHandoff', [id, options], item.item_owner);
  return options;
}

/** The record on the newest step of the item's gate jobs, read straight from the job tables. */
function stepRecord(board, id) {
  const row = board.db.prepare(`SELECT s.job_step_payload AS payload FROM job_step s JOIN job j ON j.job_id = s.job_step_job
    WHERE j.job_kind = 'gate' AND j.job_item = ? ORDER BY s.job_step_id DESC LIMIT 1`).get(id);
  return row ? JSON.parse(row.payload).record : null;
}

/** Whether board_meta holds any hand-off record under the keys older releases wrote. */
function metaHandoffs(board) {
  return board.db.prepare("SELECT COUNT(*) AS n FROM board_meta WHERE meta_key GLOB 'submit_handoff:*' OR meta_key GLOB 'submit_handoff_ended:*'").get().n;
}

test('clause 1: submitHandoff reads the record from the job [C7]', (t) => {
  const { box, id, commit } = claimed(t);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(box.boardFile, undefined, { gitRoot: box.web });
  try {
    const options = queue(box, board, id, commit);
    const agentId = options.agentId;
    for (const step of ['queued', 'running', 'red']) {
      if (step === 'running') assert.equal(startSubmitHandoff(board, id, { agentId, job: options.job }).started, true);
      if (step === 'red') completeSubmitHandoff(board, id, { agentId, job: options.job,
        result: { code: 1, error: { code: 'FIXTURE_FINISHED', message: 'The record finished.', next: 'No worker was launched.' } } });
      const today = stepRecord(board, id);
      assert.equal(today.state, step);
      // The same record as today, and it is the record on the gate job's latest step.
      assert.deepEqual(submitHandoff(board, id), today);
      assert.deepEqual(submitHandoffRecord(board.db, id), today);
      const view = jobView(board.db, options.job);
      assert.equal(view.kind, 'gate');
      assert.equal(view.step, step);
      assert.deepEqual(view.steps.at(-1).payload.record, today);
    }
    // The job row is the only copy: board_meta holds no hand-off record at all (#3476).
    assert.equal(metaHandoffs(board), 0);
  } finally { board.db.close(); }
});

test('clause 1: a retried job is the record submitHandoff reads, not the job it replaced [C7]', (t) => {
  const { box, id, commit } = claimed(t);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(box.boardFile, undefined, { gitRoot: box.web });
  try {
    const first = queue(box, board, id, commit);
    const agentId = first.agentId;
    assert.equal(startSubmitHandoff(board, id, { agentId, job: first.job }).started, true);
    completeSubmitHandoff(board, id, { agentId, job: first.job,
      result: { code: 1, error: { code: 'GATE_INFRA_EXHAUSTED', message: 'Runners failed.', next: 'Requeue.' } } });
    const stopped = submitHandoff(board, id);
    assert.equal(stopped.state, 'infrastructure');
    const retryJob = randomUUID();
    startSubmitHandoff(board, id, { agentId, job: first.job, retryJob });
    const current = submitHandoff(board, id);
    assert.deepEqual(current, stepRecord(board, id));
    assert.equal(current.id, retryJob);
    assert.equal(current.retryOf, first.job);
    assert.equal(current.state, 'queued');
    assert.deepEqual(jobView(board.db, retryJob).steps.at(-1).payload.record, current);
  } finally { board.db.close(); }
});

test('clause 1: a hand-off record an older release left in board_meta moves onto its gate job [C7]', (t) => {
  const { box, id } = claimed(t);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(box.boardFile, undefined, { gitRoot: box.web });
  try {
    const older = { id: randomUUID(), commit: 'a'.repeat(40), agentId: getItem(board, id).item_owner, state: 'green' };
    const ended = { ...older, id: randomUUID(), state: 'infrastructure' };
    board.db.prepare('INSERT INTO board_meta(meta_key, meta_value) VALUES (?, ?)').run(`submit_handoff:${id}`, JSON.stringify(older));
    board.db.prepare('INSERT INTO board_meta(meta_key, meta_value) VALUES (?, ?)').run(`submit_handoff_ended:${ended.id}`, JSON.stringify(ended));
    // Readers never look in board_meta: until the move, the item has no record.
    assert.equal(submitHandoffRecord(board.db, id), undefined);
    assert.equal(missingJobTables(board.db), true, 'a waiting legacy record makes the owning open upgrade the board');
    assert.equal(adoptLegacyHandoffs(board.db), 2);
    assert.deepEqual(submitHandoff(board, id), older);
    assert.deepEqual(endedSubmitHandoff(board, ended.id), ended);
    assert.equal(metaHandoffs(board), 0);
    assert.equal(missingJobTables(board.db), false);
  } finally { board.db.close(); }
});
