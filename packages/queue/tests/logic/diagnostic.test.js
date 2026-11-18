/** Diagnostic priority is safe when old queue clients share a machine [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderedWaiters } from '../../src/logic/order.js';

test('queue.diagnostic.waiters-know-ordering: diagnostics pass background work only when every waiter knows the ordering [C7]', () => {
  const rows = [
    { ticket: 1, diagnosticAware: 1, agent: 'background' },
    { ticket: 2, diagnosticAware: 1, diagnostic: 1, agent: 'diagnose' },
    { ticket: 3, diagnosticAware: 1, landing: 1, agent: 'landing' },
  ];
  const order = { reviewsFirst: false, ageMs: 1_800_000 };
  assert.deepEqual(orderedWaiters(rows, Date.now(), order).map(row => row.agent), ['landing', 'diagnose', 'background']);
  rows[0].diagnosticAware = 0;
  assert.deepEqual(orderedWaiters(rows, Date.now(), order).map(row => row.agent), ['landing', 'background', 'diagnose']);
});
