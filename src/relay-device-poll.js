/** Bounded cancellation-aware device polling keeps relay orchestration within its module cap [C9,E12]. */
import { Refused } from './refused.js';

/** Throw a named refusal when the caller has cancelled the in-progress device sign-in. */
export function cancellationOutcome(signal) {
  if (signal?.aborted) throw new Refused('OAUTH_CANCELLED', 'GitHub device sign-in was cancelled; no board was linked');
}

/** Wait for one bounded device-flow poll interval and wake promptly on caller cancellation. */
export function waitForDevicePoll(seconds, signal) {
  cancellationOutcome(signal);
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve();
    };
    const cancel = () => finish(new Refused('OAUTH_CANCELLED', 'GitHub device sign-in was cancelled; no board was linked'));
    const timer = setTimeout(() => finish(), Math.max(1, seconds) * 1000);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

