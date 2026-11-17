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
  queueBoard,
  state,
} from '../../tests/fixtures/submit/handoff.js';

test('queue preparation retries a real peer commit and still bounds continuous changes [B2,V4,H16,E18]', t => {
  const box = fixture(t);
  // @pullboard-board-file locking: a second native connection commits while source sealing is outside BEGIN.
  const board = openBoard(box.boardFile, undefined, { gitRoot: box.web });
  // @pullboard-board-file journey: a second native connection to the fixture board file the real CLI wrote
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
