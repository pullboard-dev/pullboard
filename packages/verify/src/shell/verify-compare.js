/** Compare actual test cases at immutable review sources without recording a verdict [V4,C7]. */
import { git } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import { testOutcomeFields } from '../../core.js';
import { retryReviewCommit } from '../core/verdict-retry.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** Prefer native accounts; plain TAP profiles remain usable, with skipped titles excluded conservatively. */
export function comparisonOutcomes(run, files) {
  if (!files.length) return [];
  const native = testOutcomeFields(run.testOutcomes ?? run.profile?.testOutcomes);
  if (native) return native;
  const skipped = new Set((run.output ?? '').split('\n').flatMap(line => {
    const match = /^\s*(?:not )?ok \d+\s*-\s*(.*?)\s+#\s*(?:SKIP|TODO)\b/iu.exec(line);
    return match ? [match[1]] : [];
  }));
  const rows = testOutcomeFields((run.profile?.tests ?? []).filter(row => files.includes(row.file))
    .map(row => ({ file: row.file, name: row.name, passed: row.passed, skipped: skipped.has(row.name) })));
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
export async function compareVerification(root, item, { main, selectTests, runTests }) {
  if (!item.item_commit) throw new Refused('NOT_SUBMITTED', 'submit the item before comparing its head');
  const originalHead = git(root, ['rev-parse', `${item.item_commit}^{commit}`]);
  const originalBase = git(root, ['merge-base', originalHead, main]);
  const directory = join(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'pullboard', 'check-output');
  mkdirSync(directory, { recursive: true });
  /** Give each actual execution a durable source-bound identity beside its native timing profile. */
  const runAt = async (commit, files) => {
    const id = randomUUID();
    const profileFile = join(directory, `compare-${id}.profile.json`);
    const run = await runTests(commit, files, { id, profileFile, artifactDirectory: directory });
    if (run.unavailable) throw new Error(run.unavailable);
    writeFileSync(join(directory, `compare-${id}.json`), JSON.stringify({ id, commit, files, profileFile,
      green: run.isGreen, runner: run.executionRunner ?? run.profile?.receipt?.runner?.id ?? null }) + '\n');
    return { ...run, id, files, profileFile };
  };
  /** Recompute affected tests for this pair and drain both real executions before deciding on fallback. */
  const pair = async (head, base, additional = []) => {
    const selected = selectTests(root, { base, commit: head });
    if (!Array.isArray(selected.files)) throw new Refused('COMPARE_SELECTION', 'the changed test closure could not be selected');
    const headFiles = sourceFiles(root, head), baseFiles = sourceFiles(root, base);
    const files = [...new Set([...selected.files, ...additional])].filter(file => headFiles.has(file)).sort();
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
  const summary = side => ({ id: side.id, files: side.files, profileFile: side.profileFile });
  return { item: item.item_id, files: result.files, newFiles: result.newFiles,
    headCommit: result.headCommit, baseCommit: result.baseCommit,
    head: summary(result.head), base: summary(result.base),
    ...differences(result.head.tests, result.base.tests), fallback };
}

/** Show only changed red cases and fixed cases, retaining the two execution identities. */
export function renderVerificationComparison(result) {
  const lines = [`comparison #${result.item}${result.fallback ? ' (main fallback)' : ''}`,
    `head ${result.headCommit}: run ${result.head.id}`,
    `base ${result.baseCommit}: run ${result.base.id}`];
  for (const row of result.newRed) lines.push(`new red: ${row.file}: ${row.name}`);
  for (const row of result.fixed) lines.push(`fixed: ${row.file}: ${row.name}`);
  if (!result.newRed.length && !result.fixed.length) lines.push('No new red or fixed cases.');
  return lines.join('\n');
}
