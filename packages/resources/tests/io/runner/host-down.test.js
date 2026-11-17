/** A gate's confirming probe outlasts the kernel's 20 s host-down window before its last retry [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFIRM_HOST_DOWN_MS } from '../../../index.js';
import { CONFIRM_PROBE_RETRIES } from '../../../index.js';
import { confirmRunnerProbe } from '../../../index.js';

const RUNNER = { host: 'blipped-runner', slots: 4, browser: 0 };

/** A probe failing at once on every call, and the pauses the retry loop asked for. */
function failing(extra = {}) {
  const waits = [];
  return { waits, probe: async () => ({ healthy: false, ...extra }), wait: async pause => { waits.push(pause); } };
}

test('resources.host-down.after-only-sub-second-failures-the: clause 1: after only sub-second failures the last attempt waits past the 20 s host-down window [C7]', async () => {
  assert.ok(CONFIRM_HOST_DOWN_MS > 20_000, 'the pause outlasts net.link.ether.inet.host_down_time (20 s)');
  const { waits, probe, wait } = failing();
  const health = await confirmRunnerProbe(probe, RUNNER, { wait });
  assert.equal(health.healthy, false);
  assert.equal(health.attempts.length, CONFIRM_PROBE_RETRIES + 1);
  assert.deepEqual(waits, [1_000, 1_000, CONFIRM_HOST_DOWN_MS], 'only the last retry waits out the host-down window');
  // A recovery pass passes hostDownMs 0 and keeps its short pauses inside its row reservation.
  const recovery = failing();
  await confirmRunnerProbe(recovery.probe, RUNNER, { retries: 1, hostDownMs: 0, wait: recovery.wait });
  assert.deepEqual(recovery.waits, [1_000]);
});

test('resources.host-down.an-attempt-that-timed-out-or: clause 2: an attempt that timed out or failed slowly keeps the 1 s pause [C7]', async t => {
  const timedOut = failing({ timedOut: true });
  await confirmRunnerProbe(timedOut.probe, RUNNER, { wait: timedOut.wait });
  assert.deepEqual(timedOut.waits, [1_000, 1_000, 1_000], 'a timed-out attempt reached the network; no host-down wait');
  const slowWaits = [];
  // The injected clock advances 1.2 s per reading, so each attempt measures as a slow failure.
  let now = 0;
  t.mock.method(Date, 'now', () => (now += 1_200));
  await confirmRunnerProbe(failing().probe, RUNNER, { retries: 1, wait: async pause => { slowWaits.push(pause); } });
  assert.deepEqual(slowWaits, [1_000], 'a slow failure keeps the 1 s pause');
});
