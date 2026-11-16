/** Shipped seat runtime profiles: a known runtime's cache setting and a safe default for any other [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeProfile } from '../../index.js';

test('clause 1: the shipped profiles load, giving a known runtime its cache setting and an unknown one a safe default [C7]', () => {
  assert.equal(runtimeProfile('claude').cache, '1h');
  assert.deepEqual(runtimeProfile('claude').cachedPrefix, ['instructions', 'skills', 'brief']);
  for (const unknown of ['self-hosted-llm', 'toString', '__proto__', '', undefined]) {
    assert.equal(runtimeProfile(unknown).cache, 'off');
    assert.equal(runtimeProfile(unknown).toolLoading, 'per-lane');
  }
});
