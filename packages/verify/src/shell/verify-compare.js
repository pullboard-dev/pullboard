/** Compare actual test cases at immutable review sources without recording a verdict [V4,C7]. */
import { git } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import { testOutcomeFields } from '../../core.js';
import { retryReviewCommit } from '../core/verdict-retry.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPARISON_WORKER_RECORD } from './comparison-worker.js';

export const VERIFICATION_COMPARISON_PREFIX = 'Review comparison: ';
/** A comparison whose worker died is started again this many times before it is recorded unavailable [C7]. */
export const COMPARISON_RESTART_LIMIT = 3;

/** Read one small JSON file, or null when it is absent or half-written. */
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** Whether a process still exists; a process owned by another user still counts as alive. */
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/**
 * Decide what a pending comparison needs: nothing while a worker lives, a restart from its recorded request when every
 * worker for this exact item, source and digest is dead, or an unavailable record after the restart limit.
 * Why: a worker killed in a stall left the comparison pending forever and held the item out of review (#3086) [C7].
 *
 * @param {{ commonDir: string, item: object, thread: object[], alive?: (pid: number) => boolean }} input
 * @returns {{ action: 'none' | 'restart' | 'unavailable', error?: string }}
 */
export function comparisonRestartPlan({ commonDir, item, thread, alive = processAlive }) {
  const recorded = recordedVerificationComparison(thread, item);
  if (recorded?.status !== 'pending') return { action: 'none' };
  const base = join(commonDir, 'pullboard', 'review-comparisons');
  let names = [];
  try { names = readdirSync(base); } catch { return { action: 'none' }; }
  const jobs = names.map(name => ({ request: readJson(join(base, name, 'request.json')), worker: readJson(join(base, name, COMPARISON_WORKER_RECORD)) }))
    .filter(({ request }) => request && request.item === item.item_id && request.source === item.item_commit && request.digest === item.item_frozen_digest);
  // A job with no worker record is still being launched; a worker with a result file has already finished.
  if (!jobs.length || jobs.some(({ worker }) => !worker || alive(worker.pid))) return { action: 'none' };
  const restarts = jobs.length - 1;
  if (restarts >= COMPARISON_RESTART_LIMIT) return { action: 'unavailable', error: `its worker died ${jobs.length} times, restarted ${restarts}` };
  return { action: 'restart' };
}

/** Read well-formed observation records only for the current submitted source and frozen bar. */
export function recordedVerificationComparison(thread, item) {
  for (const fact of [...thread].reverse()) {
    if (fact.type !== 'fact' || !fact.text?.startsWith(VERIFICATION_COMPARISON_PREFIX)) continue;
    try {
      const result = JSON.parse(fact.text.slice(VERIFICATION_COMPARISON_PREFIX.length));
      if (result.source === item.item_commit && result.digest === item.item_frozen_digest) return result;
    } catch { /* An ordinary prose fact cannot masquerade as a comparison. */ }
  }
  return null;
}

/** Keep argument boundaries, including spaces and shell punctuation in committed test paths. */
export function comparisonCommand(runner, files) {
  const word = value => "'" + value.replaceAll("'", "'\\''") + "'";
  return files.length ? `PULLBOARD_TEST_REUSE=0 ${runner} ${files.map(file => word('./' + file)).join(' ')}`
    : `node -e 'process.stdout.write("No comparison files\\n")'`;
}

/** Read regular files once per source; a new file is never passed to the base runner. */
function sourceFiles(root, commit) {
  return new Set(git(root, ['ls-tree', '-rz', commit]).split('\0').flatMap(row => {
    const match = /^100(?:644|755) blob [a-f0-9]+\t(.+)$/u.exec(row);
    return match ? [match[1]] : [];
  }));
}

/** Accept complete source-bound Node-event accounts; plain TAP titles never invent case locations. */
export function comparisonOutcomes(run, files) {
  if (!files.length) return [];
  const rows = testOutcomeFields(run.testOutcomes ?? run.profile?.testOutcomes);
  if (!rows || files.some(file => !rows.some(row => row.file === file))) return null;
  return rows.filter(row => files.includes(row.file));
}

/** Compare exact identities; a skipped or missing case never proves that a red case was fixed. */
function differences(head, base) {
  const key = row => JSON.stringify([row.file, row.name]);
  const before = new Map(base.map(row => [key(row), row]));
  const red = row => !row.passed && !row.skipped;
  return {
    newRed: head.filter(row => red(row) && !red(before.get(key(row)) ?? { passed: true })),
    fixed: head.filter(row => row.passed && !row.skipped && red(before.get(key(row)) ?? { passed: true })),
  };
}

/** Run both sides concurrently, falling back only when the original base cannot produce a test account. */
export async function compareVerification(root, item, { main, selectTests, runTests, runnerAvailable }) {
  if (!item.item_commit) throw new Refused('NOT_SUBMITTED', 'submit the item before comparing its head');
  const originalHead = git(root, ['rev-parse', `${item.item_commit}^{commit}`]);
  const originalBase = git(root, ['merge-base', originalHead, main]);
  const directory = join(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'pullboard', 'check-output');
  mkdirSync(directory, { recursive: true });
  /** Give each actual execution a durable source-bound identity beside its native timing profile. */
  const runAt = async (commit, files) => {
    if (!files.length) return { id: null, files: [], tests: [], skipped: 'no tests at source' };
    const request = randomUUID();
    const profileFile = join(directory, `compare-${request}.profile.json`);
    const run = await runTests(commit, files, { profileFile, artifactDirectory: directory });
    if (run.unavailable) throw new Error(run.unavailable);
    const id = run.id;
    if (!/^[a-f0-9-]{36}$/u.test(id ?? '')) throw new Error('comparison execution has no native run identity');
    writeFileSync(join(directory, `compare-${id}.json`), JSON.stringify({ id, commit, files, profileFile,
      green: run.isGreen, runner: run.executionRunner ?? run.profile?.receipt?.runner?.id ?? null }) + '\n');
    return { ...run, id, files, profileFile };
  };
  /** Recompute affected tests for this pair and drain both real executions before deciding on fallback. */
  const pair = async (head, base, additional = []) => {
    const selected = await selectTests(root, { base, commit: head });
    if (!Array.isArray(selected.files)) throw new Refused('COMPARE_SELECTION', 'the changed test closure could not be selected');
    const headFiles = sourceFiles(root, head), baseFiles = sourceFiles(root, base);
    const files = [...new Set([...selected.files, ...additional])].filter(file => headFiles.has(file)).sort();
    // A diagnostic cannot acquire a runner from an empty configured pool; retain unavailable instead of queueing.
    if (files.length && !runnerAvailable()) {
      throw new Refused('COMPARE_RUNNER_REQUIRED', 'comparison unavailable: no configured runner; register a runner and retry pullboard verify --compare');
    }
    const baseSelected = files.filter(file => baseFiles.has(file));
    const settled = await Promise.allSettled([runAt(head, files), runAt(base, baseSelected)]);
    /** Retain infrastructure failures without turning an unobserved run into a passing account. */
    const result = (entry, wanted) => entry.status === 'fulfilled'
      ? { ...entry.value, tests: comparisonOutcomes(entry.value, wanted) }
      : { unavailable: entry.reason?.message ?? String(entry.reason), tests: null };
    return { head: result(settled[0], files), base: result(settled[1], baseSelected),
      files, newFiles: files.filter(file => !baseFiles.has(file)), headCommit: head, baseCommit: base };
  };
  let result = await pair(originalHead, originalBase);
  let fallback = null;
  if (result.base.tests === null) {
    fallback = { base: originalBase, reason: result.base.unavailable ?? 'base produced no complete test account' };
    const composed = retryReviewCommit(root, originalHead, { commit: main });
    result = await pair(composed, main, result.files);
  }
  if (result.head.tests === null || result.base.tests === null) {
    throw new Refused('COMPARE_UNVERIFIED', 'the comparison could not run both selected test accounts; restore the runner or source and retry');
  }
  const summary = side => ({ id: side.id, files: side.files, ...(side.profileFile ? { profileFile: side.profileFile } : {}), ...(side.skipped ? { skipped: side.skipped } : {}) });
  return { item: item.item_id, files: result.files, newFiles: result.newFiles,
    headCommit: result.headCommit, baseCommit: result.baseCommit,
    head: summary(result.head), base: summary(result.base),
    ...differences(result.head.tests, result.base.tests), fallback };
}

/** Show only changed red cases and fixed cases, retaining the two execution identities. */
export function renderVerificationComparison(result) {
  if (result.status === 'pending') return `comparison pending for #${result.item}`;
  if (result.status === 'unavailable') return `comparison unavailable: ${result.error}; rerun pullboard verify ${result.item} --compare`;
  const lines = [`comparison #${result.item}${result.fallback ? ' (main fallback)' : ''}`,
    `head ${result.headCommit}: ${result.head.id ? `run ${result.head.id}` : 'no tests at head'}`,
    `base ${result.baseCommit}: ${result.base.id ? `run ${result.base.id}` : 'no tests at base'}`];
  for (const row of result.newRed) lines.push(`new red: ${row.file}: ${row.name}`);
  for (const row of result.fixed) lines.push(`fixed: ${row.file}: ${row.name}`);
  if (!result.newRed.length && !result.fixed.length) lines.push('No new red or fixed cases.');
  return lines.join('\n');
}
