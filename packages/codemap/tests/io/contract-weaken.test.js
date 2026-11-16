/** @pullboard-test-loads packages/codemap/src/io/contracts/weaken.js */
/** A change that weakens a contract is refused without the owner's approval [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkContractWeakening } from '../../src/io/contracts/weaken.js';

const before = [{ name: 'seal', params: ['key', 'text'], returns: 'string' }];
const narrower = [{ name: 'seal', params: ['key'], returns: 'string' }];
const change = extra => ({ owner: 'packages/kernel', before, after: narrower, beforeFingerprint: 'a', afterFingerprint: 'b', ...extra });

test('clause 1: with the setting on, a narrower shape refuses CONTRACT_WEAKENED naming the owner [C7]', () => {
  assert.throws(() => checkContractWeakening(change({ enabled: true })), error => {
    assert.equal(error.code ?? error.rule, 'CONTRACT_WEAKENED');
    assert.match(String(error.message), /packages\/kernel/u);
    assert.match(String(error.message), /retry/u);
    return true;
  });
  const removed = change({ enabled: true, after: [] });
  assert.throws(() => checkContractWeakening(removed), /CONTRACT_WEAKENED|removed/u);
});

test('clause 2: the owner\'s recorded approval lets the same change pass [C7]', () => {
  const result = checkContractWeakening(change({ enabled: true, approvedBy: ['packages/kernel'] }));
  assert.equal(result.weakened.length, 1);
  assert.throws(() => checkContractWeakening(change({ enabled: true, approvedBy: ['someone-else'] })), /CONTRACT_WEAKENED/u);
});

test('clause 2: with the setting off (default) nothing is refused [C7]', () => {
  assert.deepEqual(checkContractWeakening(change({})), { weakened: [] });
  assert.deepEqual(checkContractWeakening(change({ enabled: false })), { weakened: [] });
});

test('clause 1: an unchanged fingerprint or a wider shape is never refused [C7]', () => {
  assert.deepEqual(checkContractWeakening(change({ enabled: true, afterFingerprint: 'a' })), { weakened: [] });
  const wider = [{ name: 'seal', params: ['key', 'text', 'extra'], returns: 'string' }, { name: 'open', params: [], returns: 'string' }];
  assert.deepEqual(checkContractWeakening(change({ enabled: true, after: wider })), { weakened: [] });
});
