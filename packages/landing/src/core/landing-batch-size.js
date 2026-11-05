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
 * to a recent window. A set `line.landingBatchSize` overrides the adaptive size.
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
  return foldBatchSize(batches);
}

/** The last fold over a settled prefix, so each selection folds only the batches recorded since it. */
let settled = { length: 0, last: null, size: START_BATCH_SIZE };

/** Whether a batch can no longer change its outcome: it landed or ended blocked. */
function final(batch) { return batch.state === 'landed' || batch.state === 'blocked'; }

/**
 * Fold outcomes into the size, resuming from the cached fold of the leading settled batches when its last batch still
 * sits at the same place; a check of one entry, so a selection never re-folds the whole history.
 */
function foldBatchSize(batches) {
  const anchor = settled.length ? batches[settled.length - 1] : null;
  const resume = settled.length <= batches.length && (!settled.length || anchor?.id === settled.last.id && anchor?.state === settled.last.state);
  let size = resume ? settled.size : START_BATCH_SIZE, index = resume ? settled.length : 0;
  const step = batch => {
    const result = batchOutcome(batch);
    if (result !== null) size = result ? Math.min(MAX_BATCH_SIZE, size * 2) : Math.max(MIN_BATCH_SIZE, Math.floor(size / 2));
  };
  for (; index < batches.length && final(batches[index]); index += 1) step(batches[index]);
  settled = { length: index, last: index ? { id: batches[index - 1].id, state: batches[index - 1].state } : null, size };
  for (; index < batches.length; index += 1) step(batches[index]);
  return size;
}

/**
 * The order in which items failed in the current queue round: each red batch adds its items, a landed batch starts a new
 * round, and so does a round in which every waiting item has failed. Selection puts these behind every untried item,
 * oldest failure first. Why: at a cap of 1 two red oldest items that stay verified (their failures are outside their
 * own files) alternated forever and shut out every later item (#2911).
 *
 * @param {object[]} batches landing batches in recorded order
 * @param {Iterable<number>} waiting the verified item ids that can be selected now
 * @returns {Map<number, number>} item id to the position of its failure in this round
 */
export function roundFailures(batches, waiting) {
  const pending = new Set(waiting);
  let tried = new Map();
  for (const batch of batches) {
    const result = batchOutcome(batch);
    if (result === true) { tried = new Map(); continue; }
    if (result !== false) continue;
    for (const entry of batch.items ?? []) { tried.delete(entry.id); tried.set(entry.id, tried.size); }
    if (pending.size && [...pending].every(id => tried.has(id))) tried = new Map();
  }
  return tried;
}
