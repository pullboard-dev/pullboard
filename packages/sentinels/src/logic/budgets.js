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
  // Board writes answer to the two second database budget again: the native move was made fast enough (#8147), and the
  // measured p99 is held under it by the scale test. Ratchet-only; it may tighten and never loosen.
  boardWriteMs: 2_000,
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
  'board-write': 'boardWriteMs',
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

/** An absolute path cut to its repo-relative tail: from its `.git` folder when it has one, else its last two parts. */
function relativeTail(path) {
  const parts = path.split('/').filter(Boolean);
  const git = parts.indexOf('.git');
  return parts.slice(git >= 0 ? git : Math.max(0, parts.length - 2)).join('/');
}

/**
 * The deduplication key of a breach: its surface and holder, never a pid, so a recurring cause files one item.
 * Paths are repo-relative so the key survives a checkout under a folder with a space, which a bar cannot carry [C7,#6763].
 */
export function waitKey(row) {
  return `${row.surface}:${row.key ?? row.holder}`.replace(/(?<![\w.])(?:\/[^/:]+){2,}/gu, relativeTail).replace(/\bpid[- ]?\d+(?:-[a-z0-9]+)*/giu, 'pid').replace(/\s+/gu, ' ').slice(0, 200);
}

/** The code behind each surface: where a builder starts reading when the holder's own source is not known. */
const SURFACE_FILE = Object.freeze({
  pool: 'packages/resources/src/io/main.js',
  'checkout-lease': 'packages/seats/src/io/agent/session.js',
  'checkout-writer': 'packages/seats/src/io/agent/session.js',
  'runner-unavailable': 'packages/resources/src/io/recovery.js',
  'handoff-queue': 'packages/resources/src/io/handoff/worker/cap.js',
  'board-write': 'packages/store/src/io/board/write/lock.js',
  'resource-write': 'packages/resources/src/io/write/queue.js',
  gate: 'apps/cli/src/io/submit/pull.js',
  'landing-run': 'apps/cli/src/io/landing/automatic.js',
  'runner-job': 'apps/runner/src/io/scripts/worker.js',
  orphan: 'packages/sentinels/src/io/surfaces.js',
  'heartbeat-loop': 'apps/cli/src/io/commands/heartbeat.js',
  'heartbeat-claim': 'apps/cli/src/io/commands/heartbeat.js',
});

/**
 * The repository source files a holder's command line names: `apps/cli/pullboard.js <command>` is that command's module,
 * and any other repository script is itself, wherever its copy ran from.
 */
function holderSourceFiles(command) {
  const files = [];
  const text = String(command ?? '');
  const cli = /\bbin\/pullboard\.js\s+([a-z][a-z-]*)/u.exec(text);
  if (cli) files.push(`apps/cli/src/io/commands/${cli[1]}.js`);
  for (const match of text.matchAll(/(?:^|[\s/])((?:bin|apps|packages|src)\/[\w./-]+\.m?js)(?=\s|$)/gu)) {
    if (!['apps/cli/pullboard.js', 'bin/pullboard.js'].includes(match[1]) && !match[1].includes('/tests/')) files.push(match[1]);
  }
  return [...new Set(files)];
}

/** Quote one shell word with single quotes. */
function shellWord(text) {
  return `'${String(text).replace(/'/gu, `'\\''`)}'`;
}

/** The add fields of a drafted wait item, the same for the CLI's ordered move and a direct board write. */
export function waitItemFields(draft, by) {
  return { by, lane: 'core', title: draft.title, criterion: draft.criterion, brief: draft.brief, route: draft.route, check: draft.check, specIds: ['C7'] };
}

/**
 * The item a builder fixes the cause from: who held, who waited, how long, and where the evidence lies. It is routed
 * mid, so it carries what add requires of a cold build: a Files: section, a Test: line, and a check, which is the
 * wait audit itself for this one key, red while the wait is over budget. At most three numbered clauses.
 */
export function waitItemDraft(row) {
  const key = waitKey(row);
  const waiters = row.waiters.length
    ? row.waiters.slice(0, 12).map(waiter => `- ${waiter.label}${waiter.pid ? ` (pid ${waiter.pid})` : ''}: waited ${sayAge(waiter.ageMs)}`).join('\n')
    : '- none recorded';
  const files = [...new Set([...holderSourceFiles(row.context), SURFACE_FILE[row.surface]].filter(Boolean))];
  const title = `waits: ${row.surface} ${String(row.holder).replace(/\bpid[- ]?\d+(?:-[a-z0-9]+)*/giu, 'pid')} held ${sayAge(row.ageMs)} past its ${sayAge(row.budgetMs)} budget`.slice(0, 120);
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
    '',
    'Files:',
    ...files.map(file => `- ${file}`),
    '',
    `Test: a node:test that reproduces this ${row.surface} hold and asserts it ends within ${sayAge(row.budgetMs)}.`,
    '',
    `Wait key: ${key}`,
  ].filter(line => line !== null).join('\n');
  const criterion = `1. The cause that kept ${row.surface} ${row.holder} held past ${sayAge(row.budgetMs)} is fixed, so that wait now ends within its ${row.budgetName} budget. [test]`
    + ` 2. A node:test reproduces the hold from the evidence and proves it ends within budget. [test]`;
  return { key, title, brief, criterion, files, route: 'mid', check: `node apps/cli/pullboard.js waits check ${shellWord(key)}` };
}
