/** Phone reads current state and selected history without restoring the native board's complete tables [H15,H17]. */
import { openPagedSnapshot } from '../../../../../packages/pages/light.js';
import {
  PAGE_CIPHER_BYTES,
  pageDigest,
  pageReference,
} from '../../../../../packages/pages/light.js';
import { Refused } from '../../../../../packages/kernel/browser.js';

/** Decode canonical bounded ciphertext without including a response value in refusal guidance. */
function cipher(value) {
  if (typeof value !== 'string' || value.length > 600_000 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Refused('RELAY_RESPONSE', 'This sealed history page is invalid. Refresh the board.');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
  if (!binary.length || binary.length > PAGE_CIPHER_BYTES) throw new Refused('RELAY_RESPONSE', 'This sealed history page is too large. Refresh the board.');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** Authenticate a fresh read pin and expose only individually bounded current/detail/search reads to the cockpit. */
export async function phoneSnapshotPages(row, { boardId, key, maxEngine, read, bound, cache = new Map() }) {
  if (row?.apiVersion !== 2 || !Number.isSafeInteger(row.sequence) || row.sequence < 0 || typeof read !== 'function' || typeof bound !== 'function' ||
      !/^[A-Za-z0-9-]{1,128}$/u.test(row.read?.id ?? '')) throw new Refused('RELAY_RESPONSE', 'This paged board response is invalid. Refresh the board.');
  const root = pageReference(row.root);
  if (root.sequence !== row.sequence) throw new Refused('RELAY_RESPONSE', 'This board checkpoint has inconsistent coverage. Refresh the board.');
  const seen = new Set();
  const context = { boardId, key, sequence: row.sequence, bound,
    /** Every fetched object is authorized again under this read pin's authenticated parent path. */
    async get(id, parents) {
      seen.add(id);
      if (cache.has(id)) return cache.get(id);
      const document = await read('/api/v2/boards/' + boardId + '/objects/' + id + '?pin=' + encodeURIComponent(row.read.id) + '&via=' + parents.join(','));
      if (document.apiVersion !== 2 || document.page?.id !== id) throw new Refused('RELAY_RESPONSE', 'The relay returned another history page. Refresh the board.');
      const bytes = cipher(document.page.sealed);
      if (await pageDigest(bytes) !== id) throw new Refused('RELAY_RESPONSE', 'This sealed history page failed its content check. Refresh the board.');
      cache.set(id, bytes);
      return bytes;
    },
  };
  const page = await bound(() => openPagedSnapshot(root, context, { maxEngine }));
  return {
    id: root.id,
    total: page.historyTotal,
    /** Read only the current board projection, never the complete historical tables. */
    presentation: () => bound(() => page.presentation()),
    /** The selected item opens its own sealed detail pages. */
    item: id => bound(() => page.item(id)),
    /** An addressed old message reads its numeric ranges and answer, not every earlier message. */
    shout: id => bound(() => page.shout(id)),
    /** Criteria are inspected only after the person searches. */
    searchItems: query => bound(() => page.searchItems(query)),
    /** The board has no total background deadline: each underlying object I/O and crypto operation is independently bounded. */
    history: () => page.history(),
    /** A fully streamed current root no longer needs cipher objects from superseded checkpoints. */
    prune() { for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id); },
  };
}
