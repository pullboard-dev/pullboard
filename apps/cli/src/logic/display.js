/** Pure CLI resource labels and browser-admission diagnostics. */
/** Label the kind and item of a queued run without hiding older queue-class labels.
 * With short slots on, a holder also names the slot it holds and a waiter says it may take a short one.
 */
export function resourceRunLabel(entry, shortSlots = 0) {
  const priority = entry.landing ? 'landing' : entry.itemCheck ? 'item check' : entry.diagnostic ? 'diagnostic' : '';
  const slot = !shortSlots ? '' : entry.slot ? `${entry.slot} slot` : entry.requestedSlot === 'short-eligible' ? 'may use a short slot' : '';
  const details = [slot, entry.kind !== priority ? entry.kind : '', entry.item ? `#${entry.item}` : '', entry.leaseUntil ? `lease until ${entry.leaseUntil}` : '', entry.browser ? 'browser' : ''].filter(Boolean);
  return `${priority ? ` (${priority})` : ''}${details.length ? ` (${details.join(', ')})` : ''}`;
}

/** Print the file and reason when conservative uncertainty reserves browser capacity.
 * @param {any} io
 * @param {boolean} jsonMode
 * @returns {(decision:{file:string,reason:string})=>void}
 */
export function browserAdmissionReporter(io, jsonMode = false) {
  return ({ file, reason }) => {
    if (!jsonMode) io.stderr.write(`browser admission fallback: ${file}: ${reason}\n`);
  };
}
