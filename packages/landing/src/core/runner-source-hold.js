/** A batch refused RUNNER_SOURCE retries a few times, then its items wait for a new head or main [C7]. */

/** Automatic landing retries a RUNNER_SOURCE refusal at most this many times before holding the item. */
export const RUNNER_SOURCE_RETRIES = 3;

/**
 * Every RUNNER_SOURCE refusal one batch recorded, oldest first.
 * Why: an adopted batch resumes the same record and clears its current refusal, so only the kept history counts
 * attempts; a record from before the history existed counts its one current refusal.
 *
 * @param {any} batch
 * @returns {{ code: string, message?: string, at?: string }[]}
 */
export function runnerSourceAttempts(batch) {
  const history = batch.refusals ?? (batch.refusal ? [batch.refusal] : []);
  return history.filter(refusal => refusal?.code === 'RUNNER_SOURCE');
}

/**
 * The batch fields that record a refusal while keeping every earlier one, so attempts survive an adopted resume.
 *
 * @param {any} batch
 * @param {{ code?: string, message?: string }} error
 * @param {string} at ISO time of the refusal.
 * @returns {{ refusal: { code: string, message: string, at: string }, refusals: any[] }}
 */
export function refusalRecord(batch, error, at) {
  const refusal = { code: error.code ?? 'LAND_BATCH_REFUSED', message: String(error.message ?? '').replace(/^\[[A-Z_]+\]\s*/u, '').replace(/\s+/gu, ' ').slice(0, 400), at };
  return { refusal, refusals: [...(batch.refusals ?? []), refusal] };
}

/**
 * Whether a batch started from this base while carrying this exact item commit.
 *
 * @param {any} batch
 * @param {{ item_id: number, item_commit: string }} item
 * @param {string} base
 * @returns {boolean}
 */
function carries(batch, item, base) {
  return batch.base === base && (batch.candidates ?? batch.items ?? []).some(entry => entry.id === item.item_id && entry.commit === item.item_commit);
}

/**
 * Count the RUNNER_SOURCE landing attempts on this base that carried this exact item commit, across every batch
 * and every adopted resume of one batch. A new item head or a new main starts the count again, so the hold lifts
 * by itself when either changes.
 *
 * @param {any[]} batches Every recorded landing batch.
 * @param {{ item_id: number, item_commit: string }} item
 * @param {string} base The trunk commit the next batch would start from.
 * @returns {number}
 */
export function runnerSourceRefusals(batches, item, base) {
  return batches.filter(batch => carries(batch, item, base)).reduce((sum, batch) => sum + runnerSourceAttempts(batch).length, 0);
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
  const last = batches.filter(batch => carries(batch, item, base)).flatMap(runnerSourceAttempts).at(-1);
  return { code: 'LAND_RUNNER_SOURCE_HELD',
    message: `${refusals} landing attempts were refused RUNNER_SOURCE (${last?.message ?? 'no message recorded'}); #${item.item_id} waits for a new head or a new main` };
}

/**
 * The held entries for a batch's items: a coordinator hold on the item, or RUNNER_SOURCE retries used up on this base.
 * Why: an adopted batch resumes its own recorded items and skips selection, so the same checks must run on it.
 *
 * @param {any[]} batches Every recorded landing batch, with the current one at its latest revision.
 * @param {any} batch
 * @param {(id: number) => any} getItem
 * @returns {{ id: number, code: string, message: string }[]}
 */
export function heldBatchEntries(batches, batch, getItem) {
  const held = [];
  for (const entry of batch.candidates ?? batch.items ?? []) {
    const item = getItem(entry.id);
    if (item?.item_hold_at) { held.push({ id: entry.id, code: 'ITEM_HELD', message: item.item_hold_reason ?? 'held' }); continue; }
    const retried = runnerSourceHold(batches, { item_id: entry.id, item_commit: entry.commit }, batch.base);
    if (retried) held.push({ id: entry.id, ...retried });
  }
  return held;
}
