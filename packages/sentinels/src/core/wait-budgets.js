/**
 * The wait audit's budgets and verdicts: every hold, wait, queue and process the machine runs has a budget, and a row
 * past it is a breach [C7]. Pure: the shell reads the surfaces, this decides.
 *
 * Why: on 9 Nov a checkout lease sat 27 minutes, runner jobs hung for hours and gates sat 50 minutes after admission,
 * each found by hand. A budget per surface makes every one of those a filed item within a minute.
 */
import { Refused } from '../../../kernel/index.js';

/** One setting per behaviour, in milliseconds unless boolean; `waits.<name>` in pullboard.json or machine settings. */
const WAIT_BUDGET_DEFAULTS = Object.freeze({
  sentinel: true,
  reclaim: true,
  file: true,
  leaseMs: 120_000,
  waiterMs: 120_000,
  gateProgressMs: 300_000,
  runnerJobMs: 1_200_000,
  orphanMs: 300_000,
  landingRunMs: 900_000,
  databaseMs: 2_000,
  heartbeatClaimMs: 900_000,
});

/** Which budget each surface answers to, so the table can name it. */
const SURFACE_BUDGET = Object.freeze({
  pool: 'leaseMs',
  'checkout-lease': 'leaseMs',
  'checkout-writer': 'leaseMs',
  'runner-unavailable': 'waiterMs',
  'handoff-queue': 'waiterMs',
  'board-write': 'databaseMs',
  'resource-write': 'databaseMs',
  gate: 'gateProgressMs',
  'landing-run': 'landingRunMs',
  'runner-job': 'runnerJobMs',
  orphan: 'orphanMs',
  'heartbeat-loop': 'orphanMs',
  'heartbeat-claim': 'heartbeatClaimMs',
});

/**
 * Merge the board's and the machine's `waits` settings over the defaults; the machine wins, as with health.sentinel.
 * A malformed value refuses rather than silently widening a budget.
 */
export function waitBudgets(config = {}, machine = {}) {
  const merged = { ...WAIT_BUDGET_DEFAULTS };
  for (const [source, value] of [['pullboard.json', config?.waits], ['machine settings', machine?.waits]]) {
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Refused('BAD_CONFIG', `waits in ${source} must be an object of budgets`);
    for (const [key, setting] of Object.entries(value)) {
      if (!(key in WAIT_BUDGET_DEFAULTS)) throw new Refused('BAD_CONFIG', `waits.${key} in ${source} is not a wait budget; use one of ${Object.keys(WAIT_BUDGET_DEFAULTS).join(', ')}`);
      const boolean = typeof WAIT_BUDGET_DEFAULTS[key] === 'boolean';
      if (boolean ? typeof setting !== 'boolean' : !(Number.isSafeInteger(setting) && setting >= 1)) {
        throw new Refused('BAD_CONFIG', `waits.${key} in ${source} must be ${boolean ? 'true or false' : 'a whole number of milliseconds of 1 or more'}`);
      }
      merged[key] = setting;
    }
  }
  return merged;
}

/** Parse ps's elapsed time, `[[dd-]hh:]mm:ss`, into milliseconds; null when it is not one. */
export function elapsedMs(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(String(text).trim());
  if (!match) return null;
  const [, days = 0, hours = 0, minutes, seconds] = match.map(value => value === undefined ? undefined : Number(value));
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/** Say a duration the way a person reads it. */
export function sayAge(ms) {
  if (!Number.isFinite(ms)) return '?';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 120_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 7_200_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/**
 * Decide each row's breach against its surface's budget. A pool or lease breaches only while someone waits on it: a
 * long holder nobody waits for costs nothing. Every other surface breaches on its own age.
 *
 * @param {object[]} rows - Rows from the surface readers: { surface, holder, ageMs, waiters: [{ ageMs }] }.
 * @param {object} budgets - From waitBudgets.
 * @returns {object[]} The rows with budgetName, budgetMs, oldestWaiterMs and breach.
 */
export function judgeWaits(rows, budgets) {
  return rows.map(row => {
    const budgetName = SURFACE_BUDGET[row.surface];
    const budgetMs = budgets[budgetName];
    const waiters = row.waiters ?? [];
    const oldestWaiterMs = waiters.reduce((most, waiter) => Math.max(most, waiter.ageMs ?? 0), 0);
    let breach = false;
    if (['pool', 'checkout-lease', 'checkout-writer'].includes(row.surface)) {
      breach = waiters.length > 0 && (row.ageMs > budgetMs || oldestWaiterMs > budgets.waiterMs);
    } else if (['board-write', 'resource-write'].includes(row.surface)) {
      breach = row.ageMs > budgetMs || oldestWaiterMs > budgetMs;
    } else breach = row.ageMs > budgetMs;
    return { ...row, waiters, budgetName, budgetMs, oldestWaiterMs, breach };
  });
}

/** The deduplication key of a breach: its surface and holder, never a pid, so a recurring cause files one item. */
export function waitKey(row) {
  return `${row.surface}:${row.key ?? row.holder}`.replace(/\s+/gu, ' ').slice(0, 200);
}

/**
 * The item a Sonnet fixes the cause from: who held, who waited, how long, and where the evidence lies. At most three
 * numbered clauses, each with its evidence tag.
 */
export function waitItemDraft(row) {
  const key = waitKey(row);
  const waiters = row.waiters.length
    ? row.waiters.slice(0, 12).map(waiter => `- ${waiter.label}${waiter.pid ? ` (pid ${waiter.pid})` : ''}: waited ${sayAge(waiter.ageMs)}`).join('\n')
    : '- none recorded';
  const title = `waits: ${row.surface} ${row.holder} held ${sayAge(row.ageMs)} past its ${sayAge(row.budgetMs)} budget`.slice(0, 120);
  const brief = [
    `The wait audit (\`pullboard waits\`) found ${row.surface} over its ${row.budgetName} budget of ${sayAge(row.budgetMs)}.`,
    '',
    `Holder: ${row.holder}${row.pid ? ` (pid ${row.pid})` : ''}, ${sayAge(row.ageMs)}.`,
    row.context ? `Doing: ${row.context}` : null,
    row.detail ? `Detail: ${row.detail}` : null,
    `Evidence: ${row.evidence}`,
    'Waiters:',
    waiters,
    '',
    'Find why this holder holds this long, and fix that cause; never raise the budget or kill on a timer instead.',
    `Wait key: ${key}`,
  ].filter(line => line !== null).join('\n');
  const criterion = `1. The cause that kept ${row.surface} ${row.holder} held past ${sayAge(row.budgetMs)} is fixed, so that wait now ends within its ${row.budgetName} budget. [test]`
    + ` 2. A node:test reproduces the hold from the evidence and proves it ends within budget. [test]`;
  return { key, title, brief, criterion };
}
