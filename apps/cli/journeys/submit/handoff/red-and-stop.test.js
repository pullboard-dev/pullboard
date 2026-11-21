/** A queued gate's red returns to its builder with the refusal code, and an infrastructure Git read stop stays claimed [C7,V4]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { inProcessHooksOn } from '../../../tests/fixtures/hook/mode.js';
import { getItem } from '../../../../../packages/store/index.js';
import { writeBoardCommand } from '../../../../../packages/store/index.js';
import { completeSubmitHandoff } from '../../../../../packages/store/index.js';
import { fixture } from '../../../tests/fixtures/submit/handoff.js';
import { queueBoard } from '../../../tests/fixtures/submit/handoff.js';

test('cli.journeys-submit-handoff-red-and-stop.a-queued-red-returned-to-its: clause 1: a queued red returned to its builder writes submitOutcome with the refusal code and its pipelineCause on the same renew event [C7,V4]', async t => {
  const box = await fixture(t);
  assert.equal(inProcessHooksOn(box.env), true, 'the fixture uses the default in-process hooks');
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

test('cli.journeys-submit-handoff-red-and-stop.a-queued-gate-stopped-by-an: a queued gate stopped by an infrastructure Git read stays claimed and is never returned to the builder as red [C7,V4]', async t => {
  const box = await fixture(t, { inProcessHooks: false });
  assert.equal(inProcessHooksOn(box.env), false, 'the fixture uses native subprocess hooks');
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
