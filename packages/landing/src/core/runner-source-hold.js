/** A batch refused RUNNER_SOURCE retries a few times, then its items wait for a new head or main [C7]. */

/** Automatic landing retries a RUNNER_SOURCE refusal at most this many times before holding the item. */
export const RUNNER_SOURCE_RETRIES = 3;

/**
 * Count the landing batches that refused RUNNER_SOURCE on this base while carrying this exact item commit.
 * A new item head or a new main starts the count again, so the hold lifts by itself when either changes.
 *
 * @param {any[]} batches Every recorded landing batch.
 * @param {{ item_id: number, item_commit: string }} item
 * @param {string} base The trunk commit the next batch would start from.
 * @returns {number}
 */
export function runnerSourceRefusals(batches, item, base) {
  return batches.filter(batch => batch.refusal?.code === 'RUNNER_SOURCE' && batch.base === base
    && (batch.candidates ?? batch.items ?? []).some(entry => entry.id === item.item_id && entry.commit === item.item_commit)).length;
}

/**
 * The blocked-entry fields for an item that has used up its retries, or null while it may still join a batch.
 *
 * @param {any[]} batches
 * @param {{ item_id: number, item_commit: string }} item
 * @param {string} base
 * @returns {{ code: string, message: string }|null}
 */
export function runnerSourceHold(batches, item, base) {
  const refusals = runnerSourceRefusals(batches, item, base);
  if (refusals < RUNNER_SOURCE_RETRIES) return null;
  const last = batches.findLast(batch => batch.refusal?.code === 'RUNNER_SOURCE' && batch.base === base
    && (batch.candidates ?? batch.items ?? []).some(entry => entry.id === item.item_id && entry.commit === item.item_commit));
  return { code: 'LAND_RUNNER_SOURCE_HELD',
    message: `${refusals} landing batches were refused RUNNER_SOURCE (${last?.refusal?.message ?? 'no message recorded'}); #${item.item_id} waits for a new head or a new main` };
}
