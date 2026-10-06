/**
 * The gate's digest (V10): what an agent reads of a red run.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digestOf } from '../src/gate.js';

test('a digest keeps the failures and the end within its cap, however long one line is [V10]', () => {
  const digest = digestOf(`not ok 1 - ${'x'.repeat(3500)}\n${'ok\n'.repeat(50)}# fail 1\nsummary: 1 failed`);
  assert.ok(digest.length <= 3000, `${digest.length} characters`);
  assert.match(digest, /^not ok 1 - x+…\n/);
  assert.match(digest, /# fail 1\nsummary: 1 failed$/);
});

test('a digest of many failures stays within its cap and still ends with the summary [V10]', () => {
  const failures = Array.from({ length: 200 }, (_, n) => `not ok ${n} - ${'y'.repeat(250)}`).join('\n');
  const digest = digestOf(`${failures}\n# tests 200\n# fail 200`);
  assert.ok(digest.length <= 3000, `${digest.length} characters`);
  assert.match(digest, /^not ok 0 - /);
  assert.match(digest, /# tests 200\n# fail 200$/);
});
