#!/usr/bin/env node
/** List the test files whose recorded wall time is over their tier limit, per tier, with the files that have no recorded time apart [C7,#11418]. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIER_TABLE } from '../../../../../commits/light.js';
import { testFileTierLimit } from '../../../logic/test/budget/file.js';
import { readFileTimes } from '../value/timing.js';

/** The limit tier each manifest tier name stands for. */
const TIER_NAMES = Object.freeze({ T1: 'cell', T2: 'component', T3: 'journey' });

/**
 * The manifest rows whose recorded time is over their tier's limit, counts per tier, and the rows with no recorded time.
 *
 * Why: a file with no time is unknown, not slow, so it is listed apart and never counted as over.
 *
 * @param {{ files: { file: string, tier: string }[], times: Record<string, number> }} input - Manifest rows and the { file: ms } map readFileTimes returns.
 * @returns {{ over: { file: string, tier: string, durationMs: number, limitMs: number }[], counts: { T1: number, T2: number, T3: number }, unmeasured: string[] }}
 */
export function tierOverruns({ files, times }) {
  const over = [];
  const unmeasured = [];
  const counts = { T1: 0, T2: 0, T3: 0 };
  for (const { file, tier } of files) {
    if (!Object.hasOwn(TIER_NAMES, tier)) continue;
    if (!Object.hasOwn(times, file) || !Number.isFinite(times[file])) { unmeasured.push(file); continue; }
    const limitMs = testFileTierLimit(TIER_NAMES[tier]);
    if (times[file] > limitMs) { over.push({ file, tier, durationMs: times[file], limitMs }); counts[tier] += 1; }
  }
  return { over, counts, unmeasured };
}

/**
 * The report the command prints for `[root]`, and the exit code it ends with.
 *
 * Why: the work runs in this process so a test calls it without starting node; the command below only prints it.
 *
 * @param {string[]} args - The command's arguments.
 * @param {string} [cwd] - The folder a missing root resolves against.
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
export function tierOverrunsReport(args, cwd = '.') {
  if (args.some(arg => arg.startsWith('-')) || args.length > 1) {
    return { code: 1, stdout: '', stderr: 'usage: node packages/gate/src/io/test/scripts/tier-overruns.js [project-root]\n' };
  }
  const root = resolve(cwd, args[0] ?? '.');
  const times = readFileTimes(root);
  if (!Object.keys(times).length) return { code: 1, stdout: '', stderr: 'no file times recorded\n' };
  let files;
  try { files = JSON.parse(readFileSync(resolve(root, TIER_TABLE), 'utf8')).files; } catch { files = undefined; }
  if (!Array.isArray(files)) return { code: 1, stdout: '', stderr: `no tier manifest at ${TIER_TABLE}\n` };
  const { over, counts, unmeasured } = tierOverruns({ files, times });
  const lines = over.map(({ file, tier, durationMs, limitMs }) => `${tier} ${file} ${durationMs} ms over ${limitMs} ms\n`);
  return { code: 0, stdout: `${lines.join('')}T1 ${counts.T1}, T2 ${counts.T2}, T3 ${counts.T3}, unmeasured ${unmeasured.length}\n`, stderr: '' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = tierOverrunsReport(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
