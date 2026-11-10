/** Long-lived board processes run current main tooling, and a refused runner request requeues, never runs locally [C7]. */
import assert from 'node:assert/strict';
import {
  cli,
  git,
  test,
} from '../../tests/fixtures/scenarios/runners.js';
import { runnersOnlyRefusalStaysOnRunner } from '../../tests/fixtures/runner/browser/free.js';
import { INFRASTRUCTURE_CODES } from '../../../../packages/store/index.js';

test('clause 2: no gate run falls back to the coordinator when a runner refuses its request; the refusal ends it and it requeues [C7]', { timeout: 180_000 }, async t => { // budget: one runner round trip.
  for (const code of ['RUNNER_REQUEST_LIMIT', 'RUNNER_SCAN_LIMIT', 'RUNNER_BROWSER_SLOT_REQUIRED']) {
    assert.equal(INFRASTRUCTURE_CODES.has(code), true, `${code} stops the gate as infrastructure, so it requeues`);
  }
  await runnersOnlyRefusalStaysOnRunner(t, { cli, git });
});
