/** Submission verdict delivery and deterministic rejected-work return [V2,V4,B5,B13,A6]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import * as nativeBoard from '../../../../lib/index.js';
import { context } from '../../../index.js';
import { waitForSubmissionVerdict } from '../../../../../packages/items/index.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

import { waitKit } from '../../../tests/fixtures/submit/wait.js';

const { helpers, onBoard, waitingVerdict, waitPorts } = waitKit(store);
after(helpers.cleanup);

/** A withdrawn acceptance must never turn an old attached submission into a successful result. */
test('clause 1: a withdrawn verdict does not finish a submission wait successfully [V2,V6]', async t => {
  const box = await waitingVerdict(t, 'ACCEPT');
  const { item_id: id, item_commit: commit } = onBoard(box, board => store.getItem(board, 1));
  const receipt = onBoard(box, board => store.events(board, { itemId: 1 }).findLast(event => event.event_kind === 'submit'));
  onBoard(box, board => store.reopen(board, 1, { agentId: 'coordinator', withdrawVerdict: true,
    note: 'The reviewer withdrew this acceptance after a concrete gap was found.' }));
  const io = { cwd: box.repo, nativeBoard, nativeBoardPorts: nativeBoard.nativeBoardPorts, say: () => {}, err: () => {} };
  await assert.rejects(waitForSubmissionVerdict(context(io), id, { id, commit }, receipt, waitPorts),
    error => error.code === 'SUBMISSION_CHANGED');
});

/** Refreezing permits the same SHA again; an older wait must not inherit the newer attempt's verdict. */
test('clause 1: a wait keeps its original receipt across a same-SHA refrozen resubmission [V2,V6]', async t => {
  const box = helpers.project('true');
  assert.equal((await fixtureAdd(box.runLocal, box.repo, 'web', 'Same commit, new attempt', '--specs', 'G1', '--route', 'mid',
    '--brief', 'Files:\n- web/retry.txt\nChange:\n- add the submitted fixture file\nTest:\n- the fixture check accepts the submitted source\n',
    '--criterion', 'The fixture check passes.', '--check', 'true')).code, 0);
  assert.equal((await box.runLocal(box.web, 'claim', '1')).code, 0);
  assert.equal(helpers.commitFile(box, box.web, 'web/retry.txt', 'same source\n', 'feat(web): pin the attempt [G1]').status, 0);
  const sent = await box.runLocal(box.web, 'submit', '1', '--json');
  assert.equal(sent.code, 0, sent.out + sent.err);
  const submission = JSON.parse(sent.out);
  const receipt = onBoard(box, board => store.events(board, { itemId: 1 }).findLast(event => event.event_kind === 'submit'));
  onBoard(box, board => store.reopen(board, 1, { agentId: 'coordinator', note: 'Refreeze the review bar before reviewing this source.' }));
  const refrozen = await box.runLocal(box.repo, 'refreeze', '1');
  assert.equal(refrozen.code, 0, refrozen.out + refrozen.err);
  assert.equal((await box.runLocal(box.web, 'claim', '1')).code, 0);
  const resent = await box.runLocal(box.web, 'submit', '1', '--json');
  assert.equal(resent.code, 0, resent.out + resent.err);
  assert.equal(JSON.parse(resent.out).commit, submission.commit, 'the regression really resubmits the same SHA');
  /** End the later attempt through its real verifier, including cleanup if the old wait stalls. */
  const rejectLaterAttempt = () => onBoard(box, board => store.verify(board, 1, { agentId: 'coordinator', decision: 'REJECT',
    reason: 'BEHAVIOR_MISMATCH', note: 'This verdict belongs only to the later attempt.', policy: 'any', clause: 'The fixture check passes.',
    digest: store.getItem(board, 1).item_frozen_digest, head: submission.commit }));
  const io = { cwd: box.repo, nativeBoard, nativeBoardPorts: nativeBoard.nativeBoardPorts, say: () => {}, err: () => {} };
  let superseded;
  const originalWait = waitForSubmissionVerdict(context(io), submission.id, submission, receipt, waitPorts)
    .catch(error => { superseded = error; });
  t.after(async () => {
    if (!superseded) rejectLaterAttempt();
    await originalWait;
  });
  await helpers.waitFor(() => superseded, 'the original wait to refuse a later pending same-SHA submission');
  assert.equal(superseded.code, 'SUBMISSION_CHANGED', 'a later pending attempt cannot keep the old wait attached');
  rejectLaterAttempt();
  await assert.rejects(waitForSubmissionVerdict(context(io), submission.id, submission, receipt, waitPorts),
    error => error.code === 'SUBMISSION_CHANGED');
});

