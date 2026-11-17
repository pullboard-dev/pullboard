/** A queued gate's machine stops end infrastructure and keep the claim; a red still returns to the builder [C7,V4]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { getItem } from '../../../../../packages/store/index.js';
import { writeBoardCommand } from '../../../../../packages/store/index.js';
import { completeSubmitHandoff } from '../../../../../packages/store/index.js';
import { fixture } from '../../../tests/fixtures/submit/handoff.js';
import { queueBoard } from '../../../tests/fixtures/submit/handoff.js';

/**
 * Queue a fresh gate for the fixture's claimed item and complete it with one refusal, as the worker records it.
 *
 * @returns {{ done: object, item: object, owner: string, shouts: Array<{ to_: string, text: string }> }}
 */
function completeQueued(box, board, error) {
  const item = getItem(board, box.id);
  const queued = writeBoardCommand(board, 'queueSubmitHandoff', [box.id, { agentId: item.item_owner, job: randomUUID(),
    main: box.git(box.web, 'rev-parse', 'main'), commit: box.commit, tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'),
    executionCommit: box.commit, executionTree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'), digest: item.item_frozen_digest,
    companionDigest: null, leaseMs: 7_200_000 }], item.item_owner);
  const done = completeSubmitHandoff(board, box.id, { agentId: item.item_owner, job: queued.job.id, result: { code: 1, error } });
  return { done, item: getItem(board, box.id), owner: item.item_owner,
    shouts: board.db.prepare('SELECT shout_to AS to_, shout_text AS text FROM shout').all() };
}

/** Assert a machine stop: state infrastructure, the builder keeps its claim and gets no red, and the coordinator hears of it. */
function assertMachineStop(box, board, error) {
  const before = board.db.prepare('SELECT COUNT(*) AS n FROM shout').get().n;
  const { done, item, owner, shouts } = completeQueued(box, board, error);
  assert.equal(done.state, 'infrastructure', `${error.code} ends in state infrastructure`);
  assert.equal(item.item_status, 'claimed', `${error.code} leaves the item claimed`);
  assert.equal(item.item_owner, owner, `${error.code} leaves the claim with its builder`);
  const added = shouts.slice(before);
  assert.equal(added.some(row => row.to_ === owner), false, `${error.code} sends the builder no red`);
  assert.ok(added.some(row => row.to_ === 'coordinator' && row.text.includes(error.code)), `${error.code} shouts the coordinator: ${JSON.stringify(added)}`);
}

test('machine refusals RUNNER_RESULT_INVALID, RESOURCE_LEASE_LOST, GIT_SYNC_LOCK_BUSY and GIT_SYNC_REMOTE end infrastructure, stay claimed and shout the coordinator, clause 1 of #3111 [C7]', t => {
  const box = fixture(t);
  const board = queueBoard(box);
  try {
    for (const code of ['RUNNER_RESULT_INVALID', 'RESOURCE_LEASE_LOST', 'GIT_SYNC_LOCK_BUSY', 'GIT_SYNC_REMOTE']) {
      assertMachineStop(box, board, { code, message: `the machine refused with ${code}`, next: 'retry once the machine recovers' });
    }
  } finally { board.db.close(); }
});

test('a worker that exits on a signal without a terminal result ends the same way, clause 2 of #3111 [C7]', t => {
  const box = fixture(t);
  const board = queueBoard(box);
  try {
    assertMachineStop(box, board, { code: 'SUBMIT_HANDOFF_EXIT', message: 'the queued gate worker exited on SIGTERM before it recorded a result', next: 'retry' });
  } finally { board.db.close(); }
});

test('GATE_RED and MERGE_CONFLICT still return a red to the builder, clause 3 of #3111 [C7]', t => {
  for (const code of ['GATE_RED', 'MERGE_CONFLICT']) {
    const box = fixture(t);
    const board = queueBoard(box);
    try {
      const { done } = completeQueued(box, board, { code, message: `the source is red: ${code}`, next: 'fix it and submit again' });
      assert.equal(done.state, 'red', `${code} is a red`);
    } finally { board.db.close(); }
  }
});
