/** Automatic landing sizes each batch from the recorded batches before it: smaller after a red, larger after a green [C7,H24]. */
import { itemRefusalText } from '../refusal.js';

/** The size the first batch gets, and the bounds the adaptive size never leaves. */
export const START_BATCH_SIZE = 4;
/** Landed batches in a row before the size doubles. */
export const GREENS_TO_GROW = 3;
export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 16;

/**
 * How long the lander's own board connections wait for a busy board, in milliseconds. Why: seats hold the write lock
 * for 10-12 s at times, and the board's default 10 s ended two landings in a row with a bare database-is-locked [C7].
 */
export const LANDING_BOARD_BUSY_MS = 60_000;

/** Whether a recorded batch ended landed (true), ended held or bisected (false), or says nothing about redness (null). */
export function batchOutcome(batch) {
  if (batch.dropped || batch.supersededByMain) return null;
  // A batch stopped by a refusal that names no failing test (a locked database, a lost worktree) says nothing about
  // whether its items are red, so it never shrinks the next batch [C7].
  const culprits = Array.isArray(batch.culprits) && batch.culprits.length > 0;
  const testRed = (batch.failures ?? []).some(failure => failure?.file);
  // A refusal of one item's own content is a failure of the batch: the next batch halves, and at one item the
  // return step sends that item back. A locked database or a lost worktree still says nothing [C7].
  if (batch.state === 'blocked' && !culprits && !testRed && batch.refusal) {
    return itemRefusalText(batch.refusal.code, batch.refusal.message) ? false : null;
  }
  if (batch.state === 'blocked' || culprits) return false;
  return ['trunk', 'pushed', 'landed'].includes(batch.state) ? true : null;
}

/**
 * The most items the next landing batch holds. It starts at 4, halves after a blocked or bisected batch and doubles
 * after three landed ones in a row, never below 1 or above 16, folding every recorded batch in order, so the size never resets
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
let settled = { revisions: [], size: START_BATCH_SIZE, greens: 0 };

/** Whether a batch can no longer change its outcome: it landed or ended blocked. */
function final(batch) { return batch.state === 'landed' || batch.state === 'blocked'; }

/**
 * A batch's revision: every field either fold reads. A blocked batch stays revisable (a later drop, culprit or item
 * change rewrites it under the same id), so a cache keyed on one id and state would keep a stale result (#2911).
 */
function revision(batch) {
  const ids = list => (Array.isArray(list) ? list : []).map(entry => entry?.id ?? entry).join(',');
  // Whether a refusal was recorded and whether any failure names a file both decide the outcome, so both key it too.
  const namedRed = (Array.isArray(batch.failures) ? batch.failures : []).some(failure => failure?.file);
  return JSON.stringify([batch.id, batch.state, batch.dropped ?? null, batch.supersededByMain ?? null, ids(batch.culprits), ids(batch.items),
    Boolean(batch.refusal), namedRed]);
}

/**
 * How many leading batches still match a cache's recorded revisions: all of them, or zero when any cached batch
 * changed or went missing, so an earlier revised batch refolds the whole history instead of resuming from it.
 */
function resumable(batches, revisions) {
  if (revisions.length > batches.length) return 0;
  for (let index = 0; index < revisions.length; index += 1) if (revision(batches[index]) !== revisions[index]) return 0;
  return revisions.length;
}

/** The revisions of the leading settled batches from `from`, appended to the kept ones, and where the prefix ends. */
function settle(batches, kept, from, step) {
  const revisions = kept.slice(0, from);
  let index = from;
  for (; index < batches.length && final(batches[index]); index += 1) { step(batches[index]); revisions.push(revision(batches[index])); }
  return { revisions, index };
}

/**
 * Fold outcomes into the size, resuming from the cached fold of the leading settled batches only while every one of
 * them still has its cached revision, so a revised earlier batch never leaves a stale size.
 */
function foldBatchSize(batches) {
  const from = resumable(batches, settled.revisions);
  let size = from ? settled.size : START_BATCH_SIZE;
  let greens = from ? settled.greens : 0;
  // Step down on the first red; step up only after GREENS_TO_GROW landed batches in a row at the current size. Why:
  // one green after a red said little about main, and the cap climbed straight back into the next red pair [C7].
  const step = batch => {
    const result = batchOutcome(batch);
    if (result === null) return;
    if (!result) { size = Math.max(MIN_BATCH_SIZE, Math.floor(size / 2)); greens = 0; return; }
    greens += 1;
    if (greens >= GREENS_TO_GROW) { size = Math.min(MAX_BATCH_SIZE, size * 2); greens = 0; }
  };
  const { revisions, index } = settle(batches, settled.revisions, from, step);
  settled = { revisions, size, greens };
  for (let rest = index; rest < batches.length; rest += 1) step(batches[rest]);
  return size;
}

/** The failure fold over the settled prefix, so a selection folds only batches recorded since it. */
let failureCache = { revisions: [], tried: new Map(), clock: 0 };

/**
 * When each item last failed: every red batch stamps its items with a rising clock. Selection puts failed items behind
 * every untried item and orders them least recently failed first, so items that stay red take turns and never shut out
 * the rest, and an item that turns green gets its turn. Why: at a cap of 1 red oldest items that stay verified (their
 * failures are outside their own files) were picked again and again and starved later items (#2911).
 *
 * @param {object[]} batches landing batches in recorded order
 * @returns {Map<number, number>} item id to the clock of its latest failure
 */
export function roundFailures(batches) {
  const from = resumable(batches, failureCache.revisions);
  const tried = new Map(from ? failureCache.tried : []);
  let clock = from ? failureCache.clock : 0;
  const step = batch => { if (batchOutcome(batch) === false) for (const entry of batch.items ?? []) tried.set(entry.id, ++clock); };
  const { revisions, index } = settle(batches, failureCache.revisions, from, step);
  failureCache = { revisions, tried: new Map(tried), clock };
  for (let rest = index; rest < batches.length; rest += 1) step(batches[rest]);
  return tried;
}
