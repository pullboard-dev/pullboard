/** Wait for a private child handshake without treating continuing work as a speed failure [C7]. */
import { performance } from 'node:perf_hooks';
import { setTimeout as pauseFor } from 'node:timers/promises';

/**
 * Fail when the child exits or stops advancing, not after an absolute elapsed deadline.
 * progress returns a monotonically growing count of observed output or fixture marker bytes.
 */
export async function waitForFixtureProgress({ child, ready, progress, description,
  quietMs = 20_000, now = () => performance.now(), pause = pauseFor }) {
  let observedProgress = progress();
  let advancedAt = now();
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${description}: child exited (code ${child.exitCode}, signal ${child.signalCode})`);
    }
    if (ready()) return;
    const currentProgress = progress();
    const at = now();
    if (currentProgress > observedProgress) {
      observedProgress = currentProgress;
      advancedAt = at;
    } else if (at - advancedAt >= quietMs) {
      throw new Error(`${description}: child made no progress for ${quietMs} ms`);
    }
    await pause(25);
  }
}
