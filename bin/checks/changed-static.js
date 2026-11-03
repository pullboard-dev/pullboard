/** The gate's changed-file static checks as one function, so the gate and the pre-commit hook run the same list [C7]. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importStyleViolations } from '../../packages/gate/index.js';
import { engineFolderProblems } from '../../packages/state/index.js';
import { engineFolderViolations } from '../../packages/state/index.js';
import { emptyCatchProblems } from './empty-catch.js';
import { fileSizeProblems } from './file-size.js';
import { testInputProblems } from './test-inputs.js';
import { testWaitSites } from './test-waits.js';
import { testWaitGrowth } from './test-waits.js';
import { relayBoundaryProblems } from './relay-boundary.js';
import { fixedWallMargins } from '../../test/wall-clock-budgets.js';

/**
 * Judge only the named files with the static checks the gate runs on changed files.
 *
 * @param {string} root - Checkout root the files are read from.
 * @param {string[]} files - Root-relative changed or staged paths.
 * @returns {string[]} One `path:line: message` per failure; empty when clean.
 */
export function changedStaticFailures(root, files, { staged = false } = {}) {
  const cache = new Map();
  const text = file => {
    if (!cache.has(file)) {
      if (staged) {
        const result = spawnSync('git', ['show', `:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        if (result.status !== 0) throw new Error(`cannot read staged ${file}: ${result.stderr || result.error?.message}`);
        cache.set(file, result.stdout);
      } else cache.set(file, readFileSync(join(root, file), 'utf8'));
    }
    return cache.get(file);
  };
  const read = file => ({ file, source: text(file) });
  const sources = files.filter(file => /^(?:src|packages|apps)\//u.test(file) && /\.[cm]?js$/u.test(file)).map(read);
  let engineSources = sources;
  if (staged && sources.some(row => row.source.includes('EXIT_RULES_ENGINE'))) {
    const paths = spawnSync('git', ['ls-files', '-z', '--', 'src/exit-rules-engine.js', 'packages/state/core.js', 'packages/state/src/core'], { cwd: root, encoding: 'utf8' });
    if (paths.status !== 0) throw new Error('cannot list staged state metadata');
    const extra = paths.stdout.split('\0').filter(file => file && !files.includes(file) && /\.[cm]?js$/u.test(file));
    engineSources = [...sources, ...extra.map(read)];
  }
  const failures = [
    ...relayBoundaryProblems([...sources, ...files.filter(file => /^relay\/.*\.[cm]?js$/u.test(file)).map(read)]).map(row => `${row.file}:${row.line}: ${row.text}`),
    ...importStyleViolations(sources).map(row => `${row.file}:${row.line}: one import binding per line (${row.count} bindings)`),
    // The approved state metadata chain is proved across the whole tree, so judge the tree and report only changed files.
    ...(staged ? engineFolderViolations(engineSources) : engineFolderProblems(root)).filter(row => files.includes(row.file)).map(row => `${row.file}:${row.line}: ${row.text}`),
  ];
  for (const check of [emptyCatchProblems, fileSizeProblems, testInputProblems]) {
    failures.push(...check(root, files, text).map(row => `${row.path}:${row.line}: ${row.text}`));
  }
  const waitBaseline = JSON.parse(readFileSync(join(root, 'bin/checks/test-waits-baseline.json'), 'utf8'));
  for (const file of files) {
    if (/\.[cm]?js$/u.test(file) && (/(?:^|\/)test\//u.test(file) || /(?:^|\/)(?:test|test[-_.].+|.+[-_.]test)\.[cm]?js$/u.test(file))) {
      const { source } = read(file);
      failures.push(...fixedWallMargins(source, file));
      failures.push(...testWaitGrowth(testWaitSites(source, file), waitBaseline).map(row => `${row.path}:${row.line}: ${row.text}`));
    }
  }
  return failures;
}

/** Fast hook entry; leave projects with fixers or a different static policy to the ordinary hook. */
export function stagedHookFailures(root) {
  let config;
  try { config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8')); }
  catch { return []; }
  if (!/\bbin\/static-style-checks\.js\b/u.test(config.staticChecks ?? '') || config.fix?.length) return [];
  const diff = spawnSync('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], { cwd: root, encoding: 'utf8' });
  if (diff.status !== 0) throw new Error('cannot enumerate staged files');
  return changedStaticFailures(root, diff.stdout.split('\0').filter(Boolean), { staged: true });
}

// Run directly (node --experimental-vm-modules changed-static.js <files...>) it judges the files in the current directory.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const staged = process.argv[2] === '--staged';
  const failures = process.argv[2] === '--staged-hook' ? stagedHookFailures(process.cwd())
    : changedStaticFailures(process.cwd(), process.argv.slice(staged ? 3 : 2), { staged });
  if (failures.length) { process.stderr.write(`${failures.join('\n')}\n`); process.exitCode = 1; }
}
