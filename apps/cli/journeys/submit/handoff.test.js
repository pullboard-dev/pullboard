/** Real queued submissions retain immutable source and native gate authority [V4,H16,E18]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openBoard } from '../../../lib/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { submitHandoff } from '../../../../packages/store/index.js';
import { randomUUID } from 'node:crypto';
import { writeBoardCommand } from '../../../../packages/store/index.js';
import { shout } from '../../../../packages/store/index.js';
import { completeSubmitHandoff } from '../../../../packages/store/index.js';
import {
  fixture,
  state,
} from '../../tests/fixtures/submit/handoff.js';

test('queue preparation retries a real peer commit and still bounds continuous changes [B2,V4,H16,E18]', t => {
  const box = fixture(t);
  // @pullboard-board-file locking: a second native connection commits while source sealing is outside BEGIN.
  const board = openBoard(box.boardFile, undefined, { gitRoot: box.web });
  const peer = openBoard(box.boardFile, undefined, { gitRoot: box.web });
  try {
    const item = getItem(board, box.id);
    const seal = board.enginePorts.sealSubmitHandoffQueue;
    let calls = 0;
    let continuous = true;
    board.enginePorts = { ...board.enginePorts,
      /** Preserve the real source seal and introduce only an actual concurrent native message. */
      sealSubmitHandoffQueue(b, id, options) {
        const result = seal(b, id, options);
        calls++;
        if (continuous || calls === 1) shout(peer, { from: item.item_owner, to: 'all', text: `Peer commit during queue preparation ${calls}` });
        return result;
      },
    };
    const options = { agentId: item.item_owner, job: randomUUID(), main: box.git(box.web, 'rev-parse', 'main'),
      commit: box.commit, tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'), executionCommit: box.commit,
      executionTree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'), digest: item.item_frozen_digest,
      companionDigest: null, leaseMs: 7_200_000 };
    assert.throws(() => writeBoardCommand(board, 'queueSubmitHandoff', [box.id, options], item.item_owner), { code: 'BOARD_BUSY' });
    assert.equal(calls, 4, 'continuous commits exhaust the existing four attempts without widening its budget');
    assert.equal(submitHandoff(board, box.id), null, 'no stale queue record is partially published');
    continuous = false;
    calls = 0;
    const result = writeBoardCommand(board, 'queueSubmitHandoff', [box.id, options], item.item_owner);
    assert.equal(calls, 2, 'one real peer commit causes exactly one fresh preparation');
    assert.equal(result.created, true);
    assert.equal(result.job.commit, box.commit);
    assert.equal(result.job.agentId, item.item_owner);
    completeSubmitHandoff(board, box.id, { agentId: item.item_owner, job: result.job.id,
      result: { code: 1, error: { code: 'FIXTURE_FINISHED', message: 'The private native queue observation finished.', next: 'No worker was launched.' } } });
  } finally { peer.db.close(); board.db.close(); }
});

/** The board a queued-hand-off test drives directly, opened once here so the raw-board count does not grow. */
const queueBoard = box => openBoard(box.boardFile, undefined, { gitRoot: box.web });

test('clause 1: a queued red returned to its builder writes submitOutcome with the refusal code and its pipelineCause on the same renew event [C7,V4]', t => {
  const box = fixture(t);
  const board = queueBoard(box);
  try {
    const item = getItem(board, box.id);
    const options = { agentId: item.item_owner, job: randomUUID(), main: box.git(box.web, 'rev-parse', 'main'),
      commit: box.commit, tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'), executionCommit: box.commit,
      executionTree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'), digest: item.item_frozen_digest,
      companionDigest: null, leaseMs: 7_200_000 };
    const queued = writeBoardCommand(board, 'queueSubmitHandoff', [box.id, options], item.item_owner);
    const done = completeSubmitHandoff(board, box.id, { agentId: item.item_owner, job: queued.job.id,
      result: { code: 1, error: { code: 'TEST_FAILURE', message: 'one test file failed in the queued gate', next: 'fix it' } } });
    assert.equal(done.state, 'red');
    const renew = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='renew' ORDER BY event_id DESC LIMIT 1").get(box.id);
    const detail = JSON.parse(renew.event_detail);
    assert.equal(detail.queuedRedReturn, true);
    assert.equal(detail.submitOutcome.code, 'TEST_FAILURE');
    assert.equal(detail.submitOutcome.digest, item.item_frozen_digest);
    assert.equal(detail.submitOutcome.pipelineCause.type, 'test-failure');
  } finally { board.db.close(); }
});

test('a queued gate stopped by an infrastructure Git read stays claimed and is never returned to the builder as red [C7,V4]', t => {
  const box = fixture(t);
  const board = queueBoard(box);
  try {
    const item = getItem(board, box.id);
    const options = { agentId: item.item_owner, job: randomUUID(), main: box.git(box.web, 'rev-parse', 'main'),
      commit: box.commit, tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'), executionCommit: box.commit,
      executionTree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'), digest: item.item_frozen_digest,
      companionDigest: null, leaseMs: 7_200_000 };
    const queued = writeBoardCommand(board, 'queueSubmitHandoff', [box.id, options], item.item_owner);
    const done = completeSubmitHandoff(board, box.id, { agentId: item.item_owner, job: queued.job.id,
      result: { code: 1, error: { code: 'GIT_READ_INFRASTRUCTURE', message: 'the accepted cells-plan presence could not be read from Git', next: 'retry' } } });
    assert.equal(done.state, 'infrastructure');
    assert.equal(getItem(board, box.id).item_status, 'claimed');
    assert.equal(getItem(board, box.id).item_owner, item.item_owner, 'the builder keeps its claim');
    const texts = board.db.prepare('SELECT shout_to AS to_, shout_text AS text FROM shout').all();
    assert.equal(texts.some(row => row.to_ === item.item_owner && /Fix it, commit and submit again/u.test(row.text)), false);
  } finally { board.db.close(); }
});

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
