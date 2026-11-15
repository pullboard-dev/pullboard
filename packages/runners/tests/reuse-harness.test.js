/** A caller reporter or a changed harness never reuses a receipt [C7,V4]. */
import { test } from 'node:test';
import { fleetTestResultReuse } from './fixtures/fleet.js';

test('a caller-selected reporter and a changed harness invalidate reuse [C7,V4]', { timeout: 180_000 }, async t => {
  await fleetTestResultReuse(t, { composition: true, scenario: 'harness' });
});
