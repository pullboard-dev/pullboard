/** Browser side of OS notifications: opt in per kind, and open a sealed wake-up into a one-line notice [C7]. */

/** The kinds a person can choose; the wake-up's first byte is the kind's place in this list. */
export const PUSH_KINDS = Object.freeze(['decisions', 'alerts', 'landings']);

/** Cache name and key under which the page leaves the worker its device key and chosen kinds. */
export const PUSH_STATE_CACHE = 'pullboard-push';
export const PUSH_STATE_URL = '/push-state.json';

/** Decode base64url to bytes. */
function fromBase64Url(text) {
  const padded = String(text).replace(/-/gu, '+').replace(/_/gu, '/');
  return Uint8Array.from(atob(padded + '='.repeat((4 - padded.length % 4) % 4)), char => char.charCodeAt(0));
}

/**
 * Open a sealed wake-up (kind byte, then iv, tag and ciphertext of AES-256-GCM) into its kind and one-line notice.
 * Returns null for anything that does not open, so a failure shows nothing rather than raw bytes.
 * Why: the push service and relay only ever hold sealed bytes; only this device's key turns them into words.
 * @param {Uint8Array} bytes
 * @param {Uint8Array} key - The device's 32-byte key.
 * @returns {Promise<{ kind: string, notice: string } | null>}
 */
export async function openWakeupNotice(bytes, key) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 30 || key?.length !== 32) return null;
  const kind = PUSH_KINDS[bytes[0]];
  if (!kind) return null;
  const iv = bytes.subarray(1, 13);
  const tag = bytes.subarray(13, 29);
  const body = bytes.subarray(29);
  try {
    const imported = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, imported, Uint8Array.from([...body, ...tag]));
    return { kind, notice: new TextDecoder().decode(plain).split(/\r?\n/u)[0].trim() };
  } catch { return null; }
}

/**
 * Opt this browser in to notifications for the chosen kinds.
 * Registers the service worker, subscribes with the relay's public key, leaves the worker its key and kinds,
 * and hands the subscription and kinds to `post` for the relay to store.
 * @param {{ kinds: string[], publicKey: string, deviceKey: Uint8Array, post: (body: object) => Promise<unknown>,
 *   workerUrl?: string, pushManager?: { subscribe: Function } }} options - `pushManager` stands in for the registration's own when a browser has no push service.
 * @returns {Promise<{ kinds: string[], endpoint: string }>}
 */
export async function optInToPush({ kinds, publicKey, deviceKey, post, workerUrl = '/push-sw.js', pushManager }) {
  const chosen = PUSH_KINDS.filter(kind => kinds?.includes(kind));
  if (chosen.length === 0) throw new TypeError(`Choose at least one of ${PUSH_KINDS.join(', ')}.`);
  await navigator.serviceWorker.register(workerUrl, { type: 'module' });
  const registration = await navigator.serviceWorker.ready;
  const subscription = await (pushManager ?? registration.pushManager).subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(publicKey) });
  const cache = await caches.open(PUSH_STATE_CACHE);
  await cache.put(PUSH_STATE_URL, new Response(JSON.stringify({ key: Array.from(deviceKey), kinds: chosen })));
  const json = subscription.toJSON();
  await post({ subscription: json, kinds: chosen });
  return { kinds: chosen, endpoint: json.endpoint };
}
