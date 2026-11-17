/** An item's bounces at the tier it is routed to now [C7,#2178,#9841]. */
const PIN = /^tier-pin:(?: (\S+))?$/u;
const DEFAULT_TIER = 'routine';

/**
 * The rejects and returned reviews an item had while routed at `tier`, counted since it was last routed to a different tier.
 * A tier-pin note that names the tier the item is already at changes nothing; a pin that moves it restarts the count, and a cleared pin
 * puts it back on the default routine tier. Why: routeByTier takes item.bounces, and bounces earned at another tier say nothing about this one.
 *
 * @param {Array<{ type?: string, kind?: string, text?: string }>} thread The entries itemThread returns.
 * @param {string} tier The tier asked about.
 * @param {{ pin?: string | null }} [options] `pin` is the tier the item is routed at now when the caller already read it (null for none); default: the thread's last tier-pin.
 * @returns {number} Bounces at `tier` since the last tier change; 0 when the item is routed at another tier now.
 */
export function bouncesAtTier(thread, tier, options = {}) {
  let current = DEFAULT_TIER;
  let count = 0;
  for (const entry of thread ?? []) {
    if (entry?.type === 'fact' && entry.kind === 'note' && typeof entry.text === 'string') {
      const match = PIN.exec(entry.text);
      if (match) {
        const next = match[1] ?? DEFAULT_TIER;
        if (next !== current) { current = next; count = 0; }
      }
    } else if (entry?.type === 'move' && (entry.kind === 'reject' || entry.kind === 'reopen')) count += 1;
  }
  const now = options.pin === undefined ? current : options.pin ?? DEFAULT_TIER;
  return now === tier ? count : 0;
}
