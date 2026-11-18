/** The approval message says committed, or the one command left, instead of pending apply [N26,#9348]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approveMessage } from '../../src/logic/approve-message.js';
import { pageScriptPart4 } from '../../src/io/page/actions.js';

test('view.x-approve-message.clause-1-a-committed-approval-reads-approved: clause 1: a committed approval reads approved rows and committed with the short id [N26]', () => {
  assert.equal(approveMessage('G1.2', { commit: '0123456789abcdef' }), 'approved rows G1.2 and committed 0123456');
});

test('view.x-approve-message.clause-1-an-approval-left-unapplied-reads: clause 1: an approval left unapplied reads approved rows and the command to run [N26]', () => {
  assert.equal(approveMessage('G1.2', { command: 'pullboard spec apply' }), 'approved rows G1.2; run pullboard spec apply');
});

test('view.x-approve-message.clause-2-a-result-with-no-commit: clause 2: a result with no commit or command still reads pending apply [N26]', () => {
  assert.equal(approveMessage('G1.2', {}), 'approved rows G1.2 (pending apply)');
  assert.equal(approveMessage('G1.2', null), 'approved rows G1.2 (pending apply)');
  assert.equal(approveMessage('G1.2', { commit: '', command: null }), 'approved rows G1.2 (pending apply)');
});

test('view.x-approve-message.clause-1-the-page-script-builds-its: clause 1: the page script builds its approval message from approveMessage [N26]', () => {
  const script = pageScriptPart4({ approveMessage });
  const line = script.split('\n').find((text) => text.includes("move.verb === 'spec-approve') return"));
  assert.ok(line?.includes('function approveMessage('), 'the served page carries the shared message function');
});

test('view.approve-apply.commit-named: clause 1: a result carrying applied.commit names the commit id instead of pending apply [N26]', () => {
  const message = approveMessage('G1.2', { applied: { committed: true, commit: '0123456789abcdef' } });
  assert.equal(message, 'approved rows G1.2 and committed 0123456');
  assert.ok(!message.includes('pending apply'));
});

test('view.approve-apply.left-named: clause 2: a result carrying applied.left shows that one command left [N26]', () => {
  assert.equal(approveMessage('G1.2', { applied: { left: 'pullboard spec apply' } }), 'approved rows G1.2; one command left: pullboard spec apply');
});

test('view.approve-apply.absent-keeps-pending: clause 2: a result with no applied field keeps the pending apply text [N26]', () => {
  assert.equal(approveMessage('G1.2', {}), 'approved rows G1.2 (pending apply)');
  assert.equal(approveMessage('G1.2', { applied: {} }), 'approved rows G1.2 (pending apply)');
});
