/** @pullboard-test-input source-cell runners */
/** Keep the fleet round-trip cases apart from the plain reporter cases so each file's time is its own [C7]. */
import { test } from 'node:test';
import { fleetTestResultReuse } from '../../fixtures/fleet.js';

test('runners.reporter-fleet.the-runner-fleet-reuses-exact-receipts: the runner fleet reuses exact receipts across machines and gate stages [C7]', {
  timeout: 120_000, // budget: seven real worker-capsule round trips, committed checkouts and verified cleanup.
}, fleetTestResultReuse);
