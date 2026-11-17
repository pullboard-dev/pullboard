/** A synchronous runner bridge that hears nothing ends as a deadline refusal instead of holding its slot (#8557) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeDeadlineMs } from '../../../src/io/dispatch.js';
import { bridgeResult } from '../../../src/io/dispatch.js';

const PLAIN_NODE_TEST = 'node --test apps/cli/journeys/cells/seals.test.js';

test('runners.bridge-deadline.a-verify-check-that-is-plain: clause 1: a verify check that is plain node --test gets a bridge deadline and ends as RUNNER_BRIDGE_DEADLINE [C7]', () => {
  const now = 5_000_000;
  const options = { runner: { host: 'runner-52' }, privateCheck: { check: PLAIN_NODE_TEST, timeoutMs: 600_000 }, runnerWaitDeadline: now + 30_000 };
  const deadline = bridgeDeadlineMs(options, now);
  assert.ok(deadline >= 630_000 && deadline <= 630_000 + 120_000, `startup window plus the check's own timeout plus a grace bounds the bridge, got ${deadline}`);
  // Node reports a spawnSync timeout as ETIMEDOUT with no stdout: the run printed nothing within its deadline.
  assert.throws(() => bridgeResult({ options }, { status: null, signal: 'SIGKILL', error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' }, 'sync-bridge'),
    error => error.code === 'RUNNER_BRIDGE_DEADLINE' && /released/u.test(error.message) && /Rerun/u.test(error.message),
    'a bridge past its deadline refuses with its code and next step, so withGateSlot frees the runner slot');
});

test('runners.bridge-deadline.a-request-with-no-timeout-of: clause 1: a request with no timeout of its own keeps its existing unbounded bridge [C7]', () => {
  assert.equal(bridgeDeadlineMs({ runner: { host: 'runner-52' } }, 1), null);
  assert.equal(bridgeDeadlineMs({ timeoutMs: 0 }, 1), null);
});
