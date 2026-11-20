/**
 * Gate receipts (#836): where a gated run's time went. Every run that takes a gate slot (submit, a named check, a
 * doctrine hold) reports separate phases and the kind of slot it got, and appends one line to the board's receipt log
 * so `pullboard stats` can show a day of waits beside run times. Native proof runs add proofReceiptIds linking that
 * same timing receipt to their immutable gate receipts and board-stamped show chain. Measuring only; no slot behaviour lives here.
 */
import { fileSystemAdapter } from '../../../fs/index.js';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { repoInfo } from '../../../git/index.js';
import { runnerPhaseLine } from './timing.js';

import { testTimeBudget } from '../logic/test/budget/time.js';
import { testTimeBudgetLines } from '../logic/test/budget/time.js';

const fs = fileSystemAdapter();

const DAY_MS = 24 * 60 * 60 * 1000;

/** The board's receipt log, shared by every worktree of the repo. */
export function receiptLog(root) {
  return join(repoInfo(root).commonDir, 'pullboard', 'gate-receipts.jsonl');
}

/**
 * Start timing one gated run when it asks for a slot. The run marks its own phases on the returned tracker; a run
 * that never marks them (a doctrine hold) counts its whole action as running.
 */
export function startReceipt() {
  const marks = { requestedAt: Date.now() };
  return { marks, mark(name) { marks[name] ??= Date.now(); } };
}

/**
 * Which kind of slot a lease is, and why the run got it.
 *
 * @param {{ runner?: { host: string }, slotClass?: string, browser?: boolean, inherited?: boolean }} lease
 * @param {{ browserFree: boolean }} admission - Whether browser-free checks are on for this machine.
 * @returns {{ kind: string, reason: string }}
 */
export function slotOf(lease, { browserFree }) {
  if (lease.inherited) return { kind: 'inherited', reason: 'it ran inside a slot its caller already held' };
  if (lease.runner) return { kind: 'runner', reason: `registered runner ${lease.runner.host} had a free slot` };
  if (lease.slotClass === 'short') return { kind: 'short', reason: 'every ordinary slot was held and the run names its test files' };
  if (lease.browser) {
    return { kind: 'browser', reason: browserFree ? 'its files may launch a browser' : 'browser-free checks are off, so every run takes a browser-capable slot' };
  }
  return { kind: 'ordinary', reason: 'it launches no browser' };
}

/**
 * Split a run's time at its marks: waiting for a slot, admission (deciding and queueing, then handing over), setup,
 * running and evidence (reading the result and writing its record).
 *
 * @param {{ requestedAt: number, queuedAt?: number, admittedAt?: number, actionAt?: number, runAt?: number, ranAt?: number }} marks
 * @param {number} endAt
 */
export function phasesOf(marks, endAt) {
  const queuedAt = marks.queuedAt ?? marks.requestedAt;
  const admittedAt = marks.admittedAt ?? queuedAt;
  const actionAt = marks.actionAt ?? admittedAt;
  const runAt = marks.runAt ?? actionAt;
  const ranAt = marks.ranAt ?? endAt;
  const span = (from, to) => Math.max(0, Math.round(to - from));
  return {
    waitMs: span(queuedAt, admittedAt),
    admissionMs: span(marks.requestedAt, queuedAt) + span(admittedAt, actionAt),
    setupMs: span(actionAt, runAt),
    runMs: span(runAt, ranAt),
    evidenceMs: span(ranAt, endAt),
  };
}

/**
 * Seconds a runner trip spent outside running tests, in milliseconds: admission, setup, the executor's own
 * non-command time and evidence, never the wait for a slot (that is queueing, not trip cost).
 * Null when the receipt is not a runner trip or its executor reported no phases, since nothing then separates test time [C7].
 * Why: Corey's runner-worker design guards speed with a per-trip overhead budget; the same number feeds U151 capacity.
 */
export function tripOverheadMs(receipt) {
  const command = receipt?.executionPhases?.commandMs;
  if (receipt?.slot?.kind !== 'runner' || !Number.isSafeInteger(command)) return null;
  const parts = [receipt.admissionMs, receipt.setupMs, receipt.runMs, receipt.evidenceMs];
  if (!parts.every(Number.isFinite)) return null;
  return Math.max(0, parts.reduce((sum, ms) => sum + ms, 0) - command);
}

/**
 * Report-only lines for receipts whose recorded trip overhead is above the budget, each naming the runner and the trip.
 * Why never a refusal: a slow trip is a number to watch and feed capacity, not a reason to stop work [C7].
 *
 * @param {object[]} receipts - Receipt rows as the log holds them.
 * @param {number} budgetMs
 * @returns {string[]}
 */
export function tripOverheadReport(receipts, budgetMs) {
  return receipts.flatMap(receipt => {
    const ms = receipt?.tripOverheadMs;
    if (!Number.isFinite(ms) || ms <= budgetMs) return [];
    return [`# TRIP_OVERHEAD_OVER_BUDGET runner ${receipt.runner?.id ?? 'unknown'} trip ${receipt.kind ?? 'gate'} ending ${receipt.at}: ${seconds(ms)} outside tests, ${seconds(ms - budgetMs)} over the ${seconds(budgetMs)} budget (report only)`];
  });
}

/** One receipt: the run's kind, its phases and its slot. */
export function receiptOf(tracker, { kind, slot, endAt = Date.now() }) {
  return { at: new Date(endAt).toISOString(), kind: kind || 'gate', ...phasesOf(tracker.marks, endAt), slot };
}

/** Append a receipt to the board's log. A log that cannot be written never fails the run it describes. */
export function recordReceipt(root, receipt) {
  try {
    const file = receiptLog(root);
    fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFile(file, JSON.stringify(receipt) + '\n', { mode: 0o600 });
  } catch { /* The receipt is diagnostic; the run's own verdict stands without it. */ }
}

/** The receipts of the last day, skipping any line that is not a whole receipt. */
export function recentReceipts(root, now = Date.now()) {
  const file = receiptLog(root);
  if (!fs.exists(file)) return [];
  return fs.readFile(file, 'utf8').split('\n').flatMap((line) => {
    try {
      const receipt = JSON.parse(line);
      return now - Date.parse(receipt.at) <= DAY_MS && Number.isFinite(receipt.waitMs) && Number.isFinite(receipt.runMs) ? [receipt] : [];
    } catch { return []; }
  });
}

/** Read receipts relevant to a requested half-open window without the display's last-day limit. */
export function retainedReceipts(root, { from, to }) {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const file = receiptLog(root);
  if (!fs.exists(file)) return [];
  return fs.readFile(file, 'utf8').split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const receipt = JSON.parse(line);
      const at = Date.parse(receipt?.at);
      const admitted = Date.parse(receipt?.admittedAt);
      const finished = Date.parse(receipt?.finishedAt);
      const relevant = Number.isFinite(at) && at >= start && at < end
        || Number.isFinite(admitted) && Number.isFinite(finished) && finished > start && admitted < end;
      if (!relevant) return Number.isFinite(at) || Number.isFinite(admitted) || Number.isFinite(finished)
        ? [] : [{ at: from, malformed: true }];
      if (!Number.isFinite(receipt.waitMs) || receipt.waitMs < 0
        || !Number.isFinite(receipt.runMs) || receipt.runMs < 0) {
        // Keep the row so runnerStage marks legacy/incomplete evidence unmeasured.
        return [receipt];
      }
      return [receipt];
    } catch { return [{ at: from, malformed: true }]; }
  });
}

/** The middle value of a list of durations. */
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** Each check kind's runs, median and slowest wait, and median run time. */
export function receiptStats(receipts) {
  const kinds = new Map();
  for (const receipt of receipts) kinds.set(receipt.kind, [...(kinds.get(receipt.kind) ?? []), receipt]);
  return [...kinds].sort(([left], [right]) => left.localeCompare(right)).map(([kind, rows]) => ({
    kind, runs: rows.length,
    medianWaitMs: median(rows.map((row) => row.waitMs)),
    slowestWaitMs: Math.max(...rows.map((row) => row.waitMs)),
    medianRunMs: median(rows.map((row) => row.runMs)),
  }));
}

/** Seconds with two decimals, as the timing lines print them. */
function seconds(ms) { return `${(ms / 1000).toFixed(2)}s`; }

/** The stats lines for a day of receipts. */
export function receiptStatsLines(stats) {
  if (!stats.length) return ['gate waits, last day: no gated runs recorded'];
  return ['gate waits, last day:', ...stats.map((row) => `  ${row.kind}: ${row.runs} run${row.runs === 1 ? '' : 's'}; wait median ${seconds(row.medianWaitMs)}, slowest ${seconds(row.slowestWaitMs)}; run median ${seconds(row.medianRunMs)}`)];
}

/** One line of a receipt's phases and slot, for a timing digest. */
export function receiptLine(receipt) {
  if (!receipt) return '';
  const executor = runnerPhaseLine(receipt.executionPhases);
  return `phases: wait ${seconds(receipt.waitMs)}, admission ${seconds(receipt.admissionMs)}, setup ${seconds(receipt.setupMs)}, run ${seconds(receipt.runMs)}, evidence ${seconds(receipt.evidenceMs)}; slot: ${receipt.slot.kind} (${receipt.slot.reason})${executor ? '; ' + executor : ''}`;
}

/** The last day's gate waits for `pullboard stats`: the numbers for --json and the lines to print. */
export function gateWaitStats(root, now = Date.now()) {
  const stats = receiptStats(recentReceipts(root, now));
  const file = receiptLog(root);
  const receipts = !fs.exists(file) ? [] : fs.readFile(file, 'utf8').split('\n').filter(line => line.trim()).map(line => {
    try { const row = JSON.parse(line); return row && typeof row.kind === 'string' ? row : { malformed: true }; }
    catch { return { malformed: true }; }
  });
  const testWallBudgets = testTimeBudget(receipts, now);
  return { stats, testWallBudgets, lines: [...receiptStatsLines(stats), ...testTimeBudgetLines(testWallBudgets)] };
}
