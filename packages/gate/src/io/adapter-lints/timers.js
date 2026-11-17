/**
 * Count timer misuse per source file by kind and refuse any file that gains one [C7,#9518].
 * Three kinds: deferral0 (setTimeout with 0, setImmediate, queueMicrotask, requestAnimationFrame), poll (setInterval under 5 s,
 * or an awaited sleep inside a loop; a `// budget:` comment on the line or the line above exempts it) and pause (node:timers/promises).
 * The offenders that exist today are held by a per-file, per-kind ceiling that never rises, so a swap (one timer removed, a
 * timer of another kind added in the same file) still fails.
 *
 * Why: a zero-delay deferral, a poll and a pause each hide a wait that a test cannot hold still, so the lint stops the count from
 * growing. It is built on the clock scanner (clockReads, coveredByClockLint), not a second one. Behind gate.adapterLintTimers, off
 * by default: with it off the lint reports nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walk } from '../scan.js';
import { clockReads } from './clock.js';
import { coveredByClockLint } from './clock.js';

/** The ceilings file: per-file, per-kind counts of today's timer uses, repo-relative. */
export const TIMERS_CEILING_FILE = 'packages/gate/data/ceilings/adapter-lint-timers.json';

/** The kinds the lint counts, in report order. */
export const TIMER_KINDS = ['deferral0', 'poll', 'pause'];

const SOURCE_FILE = /^(?:apps\/[^/]+\/src|packages\/[^/]+\/src|bin)\/.*\.[cm]?js$/u;
const DEFERRAL = /(?<![\w$.])(?:setImmediate|queueMicrotask|requestAnimationFrame)\s*\(/u;
const TIMEOUT_ZERO = /(?<![\w$.])setTimeout\s*\(.*,\s*0\s*\)/u;
const INTERVAL = /(?<![\w$.])setInterval\s*\(.*,\s*(\d[\d_]*)\s*\)/u;
const AWAITED_SLEEP = /\bawait\s+(?:\w+\.)*\w*(?:sleep|delay|pause)\w*\s*\(/iu;
const LOOP_HEAD = /\b(?:for|while)\s*\(.*\{\s*$|\bdo\s*\{\s*$|\bfor\s+await\b/u;
const PAUSE_IMPORT = /['"](?:node:)?timers\/promises['"]/u;
const BUDGET = /\/\/\s*budget:/u;
const LOOP_REACH = 12;

/**
 * Every counted timer use in one file's text, one row per use, in line order.
 *
 * @param {string} source - File text.
 * @returns {{line: number, kind: string, call: string}[]} Rows in line order.
 */
export function timerUses(source) {
  const lines = source.split('\n');
  const exempt = index => BUDGET.test(lines[index]) || (index > 0 && BUDGET.test(lines[index - 1]));
  const rows = [];
  const seen = new Set();
  const add = (index, kind, call) => {
    if (exempt(index) || seen.has(`${index}:${kind}`)) return;
    seen.add(`${index}:${kind}`);
    rows.push({ line: index + 1, kind, call });
  };
  for (const read of clockReads(source)) {
    const index = read.line - 1;
    const text = lines[index];
    if (read.call === 'setImmediate') add(index, 'deferral0', 'setImmediate');
    else if (read.call === 'setTimeout' && TIMEOUT_ZERO.test(text)) add(index, 'deferral0', 'setTimeout 0');
    else if (read.call === 'setInterval') {
      const delay = Number(INTERVAL.exec(text)?.[1]?.replaceAll('_', ''));
      if (Number.isFinite(delay) && delay < 5000) add(index, 'poll', `setInterval ${delay}`);
    }
  }
  lines.forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (DEFERRAL.test(text)) add(index, 'deferral0', DEFERRAL.exec(text)[0].replace(/\s*\($/u, ''));
    if (PAUSE_IMPORT.test(text)) add(index, 'pause', 'node:timers/promises');
    if (AWAITED_SLEEP.test(text) && lines.slice(Math.max(0, index - LOOP_REACH), index).some(head => LOOP_HEAD.test(head))) add(index, 'poll', 'awaited sleep in a loop');
  });
  return rows.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
}

/**
 * The findings over a set of files: each file and kind whose count passes its ceiling reports every use of that kind.
 *
 * @param {Record<string, string>} files - Repo-relative path to text.
 * @param {Record<string, Record<string, number>>} [ceilings] - Per-file, per-kind counts that may not rise; absent holds zero.
 * @returns {string[]} `path:line: ...` rows, sorted.
 */
export function timerFindings(files, ceilings = {}) {
  const rows = [];
  for (const [path, source] of Object.entries(files)) {
    if (!coveredByClockLint(path)) continue;
    const uses = timerUses(source);
    for (const kind of TIMER_KINDS) {
      const ofKind = uses.filter(use => use.kind === kind);
      const ceiling = ceilings[path]?.[kind] ?? 0;
      if (ofKind.length <= ceiling) continue;
      for (const use of ofKind) rows.push(`${path}:${use.line}: ${kind} timer use (${use.call}) past the recorded count (${ofKind.length} in this file, ceiling ${ceiling}); use the clock adapter in packages/kernel`);
    }
  }
  return rows.sort();
}

/** The per-file, per-kind counts for a set of files, for writing the ceilings file. */
export function timerCounts(files) {
  const counts = {};
  for (const [path, source] of Object.entries(files)) {
    if (!coveredByClockLint(path)) continue;
    for (const use of timerUses(source)) {
      counts[path] ??= {};
      counts[path][use.kind] = (counts[path][use.kind] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Run the lint over a checkout. Off (the default) it reports nothing and reads nothing.
 *
 * @param {string} root - Checkout root.
 * @param {{enabled?: boolean}} [options] - `enabled` is gate.adapterLintTimers.
 * @returns {string[]} Findings, empty when the setting is off or no file passes its ceiling.
 */
export function timerLintRows(root, { enabled = false } = {}) {
  if (enabled !== true) return [];
  let ceilings = {};
  try { ceilings = JSON.parse(readFileSync(join(root, TIMERS_CEILING_FILE), 'utf8')).files ?? {}; } catch { ceilings = {}; }
  const files = {};
  for (const path of walk(root, SOURCE_FILE)) if (coveredByClockLint(path)) files[path] = readFileSync(join(root, path), 'utf8');
  return timerFindings(files, ceilings);
}
