/** Send the canary's push notification straight to each stored subscription endpoint, with no relay request [C7]. */

/**
 * Post one sealed payload to every stored push subscription, in order, and report each endpoint's outcome.
 * Why: the canary host sends Web Push itself (#9472); the sealing, signing and posting are passed in so this package
 * never imports an app, and a failing endpoint must not stop the others.
 * @param {{ subscriptions: Array<{ endpoint: string, keys: { p256dh: string, auth: string } }>, payload: string|Buffer,
 *   seal: (payload: string|Buffer, keys: object) => Buffer, sign: (endpoint: string) => string,
 *   post: (endpoint: string, request: { headers: object, body: Buffer }) => Promise<unknown> }} input
 * @returns {Promise<{ sent: string[], failed: Array<{ endpoint: string, reason: string }> }>}
 */
export async function sendCanaryPush({ subscriptions, payload, seal, sign, post }) {
  const sent = [];
  const failed = [];
  for (const subscription of subscriptions) {
    try {
      const body = seal(payload, subscription.keys);
      const headers = { authorization: sign(subscription.endpoint), 'content-encoding': 'aes128gcm', ttl: '60' };
      await post(subscription.endpoint, { headers, body });
      sent.push(subscription.endpoint);
    } catch (error) {
      failed.push({ endpoint: subscription.endpoint, reason: error?.message ?? String(error) });
    }
  }
  return { sent, failed };
}
