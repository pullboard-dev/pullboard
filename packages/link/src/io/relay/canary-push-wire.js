/** Wire the canary's direct push sender (canary.directPush) and its relay wake-up (relay.push) into the canary alert path [C7]. */
import { sendCanaryPush } from './canary-push.js';

/** Notices already pushed by this process, so a notice the relay keeps pending is not pushed again each minute. */
const pushed = new Set();

/** Notices already announced to the relay's push/wake by this process, for the same reason. */
const woken = new Set();

/**
 * Push one canary alert straight to every stored subscription when canary.directPush is on.
 * Why: the alert must reach the phone when the relay is the thing that is down (#9472); with the setting off, or
 * with no stored subscription, nothing is sent and the alert path is exactly today's.
 * @param {{ enabled: () => boolean, subscriptions: () => Array<object>|Promise<Array<object>>,
 *   seal: Function, sign: Function, post: Function }} ports every effect is passed in, so link never imports an app
 * @param {{ id: string|number, kind: string, at: string, step: string, code: string }} notice
 * @returns {Promise<{ sent: string[], failed: object[] }|null>} null when nothing was sent
 */
export async function pushCanaryAlert(ports, notice) {
  if (!ports || ports.enabled() !== true || pushed.has(notice.id)) return null;
  const subscriptions = await ports.subscriptions();
  if (!subscriptions.length) return null;
  pushed.add(notice.id);
  const payload = JSON.stringify({ title: `Relay canary ${notice.kind}`, body: `${notice.step} (${notice.code}) at ${notice.at}` });
  return sendCanaryPush({ subscriptions, payload, seal: ports.seal, sign: ports.sign, post: ports.post });
}

/**
 * Seal one canary alert on this board machine and post only its kind and the sealed blob to the relay's push/wake, when relay.push is on.
 * Why: the relay only wakes the phone (#9473); it never sees alert text, and with the setting off the alert path is exactly today's and nothing is posted.
 * @param {{ enabled: () => boolean, seal: (text: string) => string|Promise<string>, post: (wake: { kind: string, sealed: string }) => Promise<unknown> }} ports every effect is passed in, so link never imports an app
 * @param {{ id: string|number, kind: string, at: string, step: string, code: string }} notice
 * @returns {Promise<{ kind: string, sealed: string }|null>} the posted wake-up, or null when nothing was posted
 */
export async function wakeRelayOfCanaryAlert(ports, notice) {
  if (!ports || ports.enabled() !== true || woken.has(notice.id)) return null;
  const wake = { kind: 'alerts', sealed: await ports.seal(`Relay canary ${notice.kind}: ${notice.step} (${notice.code}) at ${notice.at}`) };
  await ports.post(wake);
  woken.add(notice.id);
  return wake;
}
