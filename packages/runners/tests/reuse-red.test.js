/** A red receipt never supplies a cached pass [C7,V4]. */
import { test } from 'node:test';
import { fleetTestResultReuse } from './fixtures/fleet.js';

test('a red receipt never supplies a cached passing execution on either machine [C7,V4]', { timeout: 180_000 }, async t => {
  await fleetTestResultReuse(t, { composition: true, scenario: 'red' });
});
