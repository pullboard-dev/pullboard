/** A batch refused RUNNER_SOURCE retries a few times, then its items wait for a new head or main [C7]. */
import { LANDING_FAULT_CODES } from './automatic-landing-retry.js';

/** Automatic landing retries a RUNNER_SOURCE refusal at most this many times before holding the item. */
export const RUNNER_SOURCE_RETRIES = 3;

/** Prefix for automatic holds created after the same landing cause blocks two batches. */
export const REPEATED_LANDING_HOLD = 'landing-repeat-v1:';

/** Landing faults never count as a repeated cause: the machinery failed, not the item [C7,#3693]. */
const FAULTS = new Set(LANDING_FAULT_CODES);

/** Decode only a well-formed automatic repeat hold; other coordinator holds retain their own lifetime. */
export function repeatedLandingHold(reason) {
  if (typeof reason !== 'string' || !reason.startsWith(REPEATED_LANDING_HOLD)) return null;
  const end = reason.indexOf(' ', REPEATED_LANDING_HOLD.length);
  if (end < 0) return null;
  try {
    const value = JSON.parse(reason.slice(REPEATED_LANDING_HOLD.length, end));
    if (!['case', 'refusal'].includes(value.kind) || typeof value.key !== 'string'
      || !/^[0-9a-f]{40}$/u.test(value.base ?? '') || !/^[0-9a-f]{40}$/u.test(value.commit ?? '')
      || (value.root !== undefined && typeof value.root !== 'string')) return null;
    return value;
  } catch { return null; }
}

/**
 * Whether a refusal's own condition still holds, or null when no probe exists for its code.
 * Why: a LAND_DIRTY hold stays while its landing worktree is dirty even if main moved, and lifts once it is clean [C7].
 */
export function refusalConditionHolds(hold, facts) {
  if (hold.key === 'LAND_DIRTY' && facts && typeof facts.worktreeDirty === 'boolean') return facts.worktreeDirty;
  return null;
}

/**
 * Decide whether an automatic repeat hold's recorded cause has cleared.
 * Why: the cause is evaluated first; a moved main base or a new item commit alone lifts nothing. A refusal code
 * with no probe has no readable cause, so its hold stays until the coordinator releases it.
 */
export function repeatedLandingHoldCleared(hold, item, base, comparison, facts = null) {
  if (hold.kind === 'refusal') {
    const holds = refusalConditionHolds(hold, facts);
    return holds === null ? false : !holds;
  }
  if (hold.kind !== 'case') return false;
  const [file, ...rest] = hold.key.split('::');
  const name = rest.join('::');
  if (!file || !name) return false;
  const row = comparison?.main === base && !comparison.unavailable
    ? comparison.files?.find(entry => entry.file === file) : null;
  return row?.result === 'green' || Array.isArray(row?.failures)
    && !row.failures.some(failure => `${failure.file}::${failure.name}` === hold.key);
}

/** Format the one coordinator notice for an automatic repeated-cause hold. */
export function repeatedLandingNotice(id, cause) {
  const label = cause.kind === 'case' ? 'failing case' : 'refusal';
  return `Landing parked #${id} after two blocked batches with ${label} ${cause.detail}; it will rejoin when the cause clears.`;
}

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

/** Find the cause repeated by an item's two latest blocked batches, bound to its exact accepted commit. */
export function repeatedBlockedCause(batches, item) {
  const relevant = batches.filter(batch => batch.state === 'blocked'
    && (batch.candidates ?? batch.items ?? []).some(entry => entry.id === item.item_id && entry.commit === item.item_commit));
  if (relevant.length < 2) return null;
  const previous = relevant.at(-2), latest = relevant.at(-1);
  /** Extract only recorded refusal codes and named culprit cases for this item's exact accepted head. */
  const causes = batch => {
    const found = [];
    // Why: #2550 was parked after two batches whose only reds were runner refusals; a fault is retried, never held.
    if (batch.refusal?.code && !FAULTS.has(batch.refusal.code)) found.push({ kind: 'refusal', key: batch.refusal.code, detail: batch.refusal.message ?? batch.refusal.code });
    for (const culprit of batch.culprits ?? []) {
      if (culprit.id !== item.item_id || culprit.commit !== item.item_commit) continue;
      for (const test of culprit.tests ?? []) if (test.file && test.name) {
        found.push({ kind: 'case', key: `${test.file}::${test.name}`, detail: `${test.file} :: ${test.name}` });
      }
    }
    return found;
  };
  const prior = causes(previous);
  const repeated = causes(latest).find(cause => prior.some(earlier => earlier.kind === cause.kind && earlier.key === cause.key));
  return repeated ? { ...repeated, base: latest.base, commit: item.item_commit, batch: latest.id } : null;
}
