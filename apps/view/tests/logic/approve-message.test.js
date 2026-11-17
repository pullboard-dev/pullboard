/** The approval message says committed, or the one command left, instead of pending apply [N26,#9348]. */
/** @pullboard-test-input source-cell apps/view */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approveMessage } from '../../src/logic/approve-message.js';
import { pageScriptPart4 } from '../../src/io/page/actions.js';

test('clause 1: a committed approval reads approved rows and committed with the short id [N26]', () => {
  assert.equal(approveMessage('G1.2', { commit: '0123456789abcdef' }), 'approved rows G1.2 and committed 0123456');
});

test('clause 1: an approval left unapplied reads approved rows and the command to run [N26]', () => {
  assert.equal(approveMessage('G1.2', { command: 'pullboard spec apply' }), 'approved rows G1.2; run pullboard spec apply');
});

test('clause 2: a result with no commit or command still reads pending apply [N26]', () => {
  assert.equal(approveMessage('G1.2', {}), 'approved rows G1.2 (pending apply)');
  assert.equal(approveMessage('G1.2', null), 'approved rows G1.2 (pending apply)');
  assert.equal(approveMessage('G1.2', { commit: '', command: null }), 'approved rows G1.2 (pending apply)');
});

test('clause 1: the page script builds its approval message from approveMessage [N26]', () => {
  const script = pageScriptPart4({ approveMessage });
  const line = script.split('\n').find((text) => text.includes("move.verb === 'spec-approve') return"));
  assert.ok(line?.includes('function approveMessage('), 'the served page carries the shared message function');
});
