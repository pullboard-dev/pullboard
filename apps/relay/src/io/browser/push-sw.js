/** Service worker: show a one-line notice from a sealed wake-up, and never from plaintext [C7]. */
import { PUSH_STATE_CACHE } from './push-client.js';
import { PUSH_STATE_URL } from './push-client.js';
import { openWakeupNotice } from './push-client.js';

/** Read the device key and chosen kinds the page left in the cache; null when the person never opted in. */
async function savedState() {
  const hit = await (await caches.open(PUSH_STATE_CACHE)).match(PUSH_STATE_URL);
  if (!hit) return null;
  const { key, kinds } = await hit.json();
  return { key: Uint8Array.from(key), kinds };
}

/** Open the pushed bytes and show their notice when the kind was chosen; anything unopenable shows nothing. */
async function show(event) {
  const state = await savedState();
  if (!state || !event.data) return;
  const opened = await openWakeupNotice(new Uint8Array(event.data.arrayBuffer ? await event.data.arrayBuffer() : event.data), state.key);
  if (!opened || !state.kinds.includes(opened.kind) || !opened.notice) return;
  await self.registration.showNotification(opened.notice, { tag: opened.kind });
}

self.addEventListener('push', event => event.waitUntil(show(event)));
