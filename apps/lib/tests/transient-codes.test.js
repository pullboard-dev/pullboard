import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSIENT_CODES } from '../../../packages/kernel/index.js';
import { LANDING_FAULT_CODES } from '../../../packages/landing/index.js';
import { retryableLandingRefusal } from '../../../packages/landing/index.js';
import { INFRASTRUCTURE_CODES } from '../../../packages/store/index.js';

test('clause 1: every retry site reads the one transient set, so a code in it is retried by all of them [C7,#3779]', () => {
  assert.ok(TRANSIENT_CODES.size > 0);
  for (const code of TRANSIENT_CODES) {
    assert.ok(LANDING_FAULT_CODES.includes(code), `the landing steps retry ${code}`);
    assert.ok(retryableLandingRefusal(code), `a landing batch blocked on ${code} is retired by a new main`);
    assert.ok(INFRASTRUCTURE_CODES.has(code), `the gate requeues ${code} as infrastructure`);
  }
  assert.equal(LANDING_FAULT_CODES.length, TRANSIENT_CODES.size, 'the landing list holds no code outside the shared set');
});

test('clause 1: the shared set carries BAD_RESOURCE_CAPACITY, the code that killed every dispatcher on 6 Nov [C7,#3779]', () => {
  assert.ok(TRANSIENT_CODES.has('BAD_RESOURCE_CAPACITY'));
  assert.ok(INFRASTRUCTURE_CODES.has('BAD_RESOURCE_CAPACITY'));
});
