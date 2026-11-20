/** Submit, review and companion composition retain original completed per-file proof [C7,V4]. */
import assert from 'node:assert/strict';
import { completedTestResult } from '../../gate/heavy.js';
import { test } from 'node:test';
import { fleetTestResultReuse } from './fixtures/fleet.js';

test('runners.reuse.same-tree-review-reuses-submit-receipts: clause 2: same-tree review reuses submit receipts on another machine, and a changed environment reruns [C7,V4]', { timeout: 180_000 }, async t => {
  await fleetTestResultReuse(t, { composition: true });
});

test('runners.reuse.pending-failed-and-interrupted-worker-requests: pending, failed and interrupted worker requests are not completed green proof [C7,V4]', () => {
  const request = '11111111-1111-4111-8111-111111111111';
  const commit = 'a'.repeat(40);
  const completion = { id: request, commit, tree: 'b'.repeat(40), code: 0, signal: null,
    outputSha256: 'c'.repeat(64), runtimeSha256: 'd'.repeat(64), toolingSha256: 'e'.repeat(64) };
  assert.ok(!completedTestResult({ commit, origin: { request } }));
  assert.ok(completedTestResult({ commit, origin: { request, completion } }));
  for (const change of [{ code: 1 }, { signal: 'SIGKILL' }, { id: '22222222-2222-4222-8222-222222222222' }, { commit: 'f'.repeat(40) }]) {
    assert.ok(!completedTestResult({ commit, origin: { request, completion: { ...completion, ...change } } }));
  }
});
