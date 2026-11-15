/** A companion reruns only its changed closure and its result crosses back [C7,V4]. */
import { test } from 'node:test';
import { fleetTestResultReuse } from './fixtures/fleet.js';

test('a companion reruns only its changed closure, and the result crosses back to the first machine [C7,V4]', { timeout: 180_000 }, async t => {
  await fleetTestResultReuse(t, { composition: true, scenario: 'closure' });
});
