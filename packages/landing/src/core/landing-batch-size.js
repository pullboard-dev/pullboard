/** Automatic landing sizes each batch from the recorded batches before it: smaller after a red, larger after a green [C7,H24]. */

/** The size the first batch gets, and the bounds the adaptive size never leaves. */
export const START_BATCH_SIZE = 4;
export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 16;

/** Whether a recorded batch ended landed (true), ended held or bisected (false), or says nothing about redness (null). */
export function batchOutcome(batch) {
  if (batch.dropped || batch.supersededByMain) return null;
  if (batch.state === 'blocked' || (Array.isArray(batch.culprits) && batch.culprits.length)) return false;
  return ['trunk', 'pushed', 'landed'].includes(batch.state) ? true : null;
}

/**
 * The most items the next landing batch holds. It starts at 4, halves after a blocked or bisected batch and doubles
 * after a landed one, never below 1 or above 16, folding every recorded batch in order, so the size never resets
 * to a recent window. A set
 * `line.landingBatchSize` overrides the adaptive size.
 *
 * Why: 4 Nov batches carried 12-23 items while main had hundreds of failing cases, so nearly every batch held a red
 * and paid a bisect before landing anything.
 *
 * @param {object[]} batches landing batches in recorded order
 * @param {number | false | undefined} [override] the line.landingBatchSize setting
 * @returns {number}
 */
export function landingBatchSize(batches, override) {
  if (typeof override === 'number' && Number.isFinite(override) && override >= MIN_BATCH_SIZE) return Math.floor(override);
  let size = START_BATCH_SIZE;
  for (const batch of batches.filter(entry => batchOutcome(entry) !== null)) {
    size = batchOutcome(batch) ? Math.min(MAX_BATCH_SIZE, size * 2) : Math.max(MIN_BATCH_SIZE, Math.floor(size / 2));
  }
  return size;
}

/**
 * The items of the latest batch that said something about redness, when that batch went red; empty after a landed one.
 * Selection puts these behind the rest for one round. Why: at a cap of 1 a red oldest item that stays verified (its
 * failure is outside its own files) was picked again and again, shutting out every later item (#2911).
 *
 * @param {object[]} batches landing batches in recorded order
 * @returns {Set<number>}
 */
export function lastRedBatchItems(batches) {
  const last = batches.filter(batch => batchOutcome(batch) !== null).at(-1);
  return new Set(last && batchOutcome(last) === false ? (last.items ?? []).map(entry => entry.id) : []);
}
