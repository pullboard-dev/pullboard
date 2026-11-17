/** Wire the canary's direct push sender into the canary alert path behind canary.directPush [C7]. */
import { sendCanaryPush } from './canary-push.js';

/** Notices already pushed by this process, so a notice the relay keeps pending is not pushed again each minute. */
const pushed = new Set();

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
