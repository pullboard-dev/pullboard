/** The gate_settled event a settled gate job leaves once [C7,#12155]. */
import * as store from '../../../../store/index.js';

/**
 * The outcome and class a settled result records, or null when it records nothing.
 * Why: the settle already decided each result; this only names it, with no new comparison [C7,#12155].
 * @param {{ applied: boolean, outcome: string, mainOwned?: unknown }} applied - applyGateReceiptReads' answer.
 * @param {Record<string, any>|undefined} receipt - the posted receipt, read for gate.error and gate.analysis.infra.
 * @returns {{ outcome: string, class: string }|null}
 */
function settledOf(applied, receipt) {
  if (applied.outcome === 'stale') return { outcome: 'stale', class: 'stale-base' };
  if (!applied.applied) return null;
  if (applied.outcome === 'review') return 'mainOwned' in applied ? { outcome: 'red', class: 'main-red' } : { outcome: 'green', class: 'item' };
  const infra = Boolean(receipt?.gate?.error || receipt?.gate?.analysis?.infra);
  // An infrastructure receipt never reaches the compare-with-main step, so the settle answers red for it; the receipt says it is not the item's [C7].
  if (applied.outcome === 'red') return infra ? { outcome: 'unknown', class: 'infra' } : { outcome: 'red', class: 'item' };
  if (applied.outcome === 'unknown') return { outcome: 'unknown', class: infra ? 'infra' : 'main-red' };
  return null;
}

/**
 * Append one gate_settled event for a settled gate job, with the outcome and class the settle decided.
 * Why: every settle path reaches applyGateReceipt, so one event here gives the timeline reader a settle per job [C7,#12155].
 * Green and item-red are class item; a main-owned review is red, main-red; a stale gate is stale, stale-base; an unknown is unknown,
 * infra when the receipt names an error or infrastructure, else unknown, main-red (main's receipts are not recorded yet). A not-gate
 * result appends nothing. A job that already has its event appends nothing, so a receipt posted twice, or a sharded gate re-seen by
 * settleWaitingGates, leaves one. The kind is not an engine-declared kind.
 *
 * @param {any} board
 * @param {string} job
 * @param {{ applied: boolean, outcome: string, mainOwned?: unknown }} applied - applyGateReceiptReads' answer.
 * @param {Record<string, any>} [receipt] - the posted receipt.
 * @returns {typeof applied} the same answer.
 */
export function recordGateSettled(board, job, applied, receipt) {
  const settled = settledOf(applied ?? {}, receipt);
  if (!settled || typeof job !== 'string') return applied;
  store.atomic(board, () => {
    const item = board.db.prepare("SELECT job_item FROM job WHERE job_id = ? AND job_kind = 'gate'").get(job)?.job_item;
    if (!Number.isSafeInteger(item)) return;
    const seen = board.db.prepare("SELECT 1 FROM event WHERE event_kind = 'gate_settled' AND item_id = ? AND json_extract(event_detail, '$.job') = ?").get(item, job);
    if (!seen) store.logEvent(board, 'coordinator', 'gate_settled', item, { job, outcome: settled.outcome, class: settled.class });
  });
  return applied;
}

/** The shortest gap between two settle walks on one board (#12480). */
export const SETTLE_WINDOW_MS = 8000;
const lastWalk = new WeakMap();

/**
 * How often a board's done sharded gates are walked: at most once per SETTLE_WINDOW_MS from pull claims, or on the first
 * claim after a receipt. The stamp lives in memory per board, so a restart walks on its first claim [C7,#12480].
 */
export const settleWindow = {
  /** Run `walk` when the board's window is open, stamping it; skip it otherwise. */
  run(board, now = Date.now(), walk) {
    const last = lastWalk.get(board);
    if (last !== undefined && now >= last && now - last < SETTLE_WINDOW_MS) return;
    lastWalk.set(board, now);
    walk();
  },
  /** A posted receipt opens the window at once. */
  reopen(board) { lastWalk.delete(board); },
};
