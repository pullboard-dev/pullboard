/** An item's tier pin, read from its thread [C7,#2178,#9840]. */

const PIN = /^tier-pin:(?: (\S+))?$/u;

/**
 * The tier an item's thread pins: the last note fact whose text is exactly `tier-pin: <tier>`; an empty `tier-pin:` clears it.
 * Why the thread: a pin recorded as a note fact needs no schema or engine change, and the thread keeps every earlier pin in order.
 *
 * @param {Array<{ type?: string, kind?: string, text?: string }>} thread The entries itemThread returns.
 * @returns {string | null} The pinned tier, or null when none is pinned.
 */
export function itemTierPin(thread) {
  let pinned = null;
  for (const entry of thread ?? []) {
    if (entry?.type !== 'fact' || entry.kind !== 'note' || typeof entry.text !== 'string') continue;
    const match = PIN.exec(entry.text);
    if (match) pinned = match[1] ?? null;
  }
  return pinned;
}
