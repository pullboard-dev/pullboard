#!/usr/bin/env node
/** Report T1/T2/T3 counts and the files a one-line change to one front door selects, componentTier off and on [C7,#9789]. */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchFolder } from '../../../../../config/index.js';
import { generateTestTiers } from '../../../../heavy.js';
import { selectTestTiers } from '../../../../heavy.js';

/** Run Git in a checkout, optionally with extra environment, and return trimmed stdout. */
function git(root, args, env = {}, input) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', input, env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Commit object (never a ref) holding HEAD's tree with one line appended to `door`, built in a throwaway index so the checkout is untouched. */
function changedCommit(root, door) {
  const head = git(root, ['rev-parse', 'HEAD']);
  const scratch = scratchFolder('pullboard-tier-counts-');
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index'), GIT_AUTHOR_NAME: 'tier-counts', GIT_AUTHOR_EMAIL: 'tier-counts@example.invalid', GIT_COMMITTER_NAME: 'tier-counts', GIT_COMMITTER_EMAIL: 'tier-counts@example.invalid' };
    git(root, ['read-tree', head], env);
    const blob = git(root, ['hash-object', '-w', '--stdin'], env, `${git(root, ['show', `${head}:${door}`])}\n// tier-counts probe\n`);
    git(root, ['update-index', '--cacheinfo', `100644,${blob},${door}`], env);
    return { base: head, commit: git(root, ['commit-tree', git(root, ['write-tree'], env), '-p', head, '-m', 'tier-counts probe'], env) };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Counts per tier and, when `door` is named, the files its one-line change selects, for each componentTier setting. */
export function tierCounts(root, { door } = {}) {
  const probe = door ? changedCommit(root, door) : null;
  const out = {};
  for (const componentTier of [false, true]) {
    const counts = { T1: 0, T2: 0, T3: 0 };
    for (const row of generateTestTiers(root, { componentTier }).files) if (row.tier in counts) counts[row.tier] += 1;
    out[componentTier ? 'on' : 'off'] = { counts, ...(probe ? { selected: selectTestTiers(root, { ...probe, componentTier }).units } : {}) };
  }
  return out;
}

/**
 * The report the command prints for `[--door <door>] [root]`, and the exit code it ends with.
 *
 * Why: the work runs in this process so a test calls it without starting node; the command below only prints it.
 *
 * @param {string[]} args - The command's arguments.
 * @param {string} [cwd] - The folder a missing root resolves against.
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
export function tierCountsReport(args, cwd = '.') {
  const at = args.indexOf('--door');
  const door = at >= 0 ? args[at + 1] : undefined;
  const rest = at < 0 ? args : args.filter((_, i) => i !== at && i !== at + 1);
  if (rest.some(arg => arg.startsWith('-')) || rest.length > 1 || (at >= 0 && !door)) {
    return { code: 1, stdout: '', stderr: 'usage: node packages/gate/src/io/test/scripts/tier-counts.js [--door <packages/x/index.js>] [project-root]\n' };
  }
  let stdout = '';
  for (const [setting, { counts, selected }] of Object.entries(tierCounts(resolve(cwd, rest[0] ?? '.'), { door }))) {
    stdout += `componentTier ${setting}: T1 ${counts.T1}, T2 ${counts.T2}, T3 ${counts.T3}\n`;
    if (selected) stdout += `componentTier ${setting}: ${door} change selects ${selected.length} files\n${selected.map(file => `  ${file}\n`).join('')}`;
  }
  return { code: 0, stdout, stderr: '' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = tierCountsReport(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
