/** Read only reached file limits and changed ratchet rows from committed Git sources [C7]. */
import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { sep } from 'node:path';
import { posix } from 'node:path';
import { gitChildEnv } from '../../../../src/git.js';
import { tryGit } from '../../../../src/git.js';
import { mainCheckout } from '../../../../src/git.js';
import { carriedRunnerTrunk } from '../../../sandbox/index.js';
import { readPlacementIndex } from './test-economics-index.js';
import { DEFAULT_TEST_FILE_BUDGET_MS } from '../core/test-file-budget.js';
import { requireTestFileRatchet } from '../core/test-file-budget.js';
import { testFileLimit } from '../core/test-file-budget.js';

const DIRECTORY = '.pullboard/test-file-budgets';
export function testFileRelative(root, file) { return relative(root, resolve(root, file)).split(sep).join('/'); }

/** Hash names so paths never escape the tracked table directory. */
export function testFileBudgetPath(file) {
  if (typeof file !== 'string' || !file || file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..')) throw new TypeError('invalid test file path');
  return `${DIRECTORY}/${createHash('sha256').update(file).digest('hex')}.json`;
}

/** Read a Git object; a nonexistent row means the immutable default, not unlimited time. */
function rowAt(root, ref, path, env) {
  const entry = tryGit(root, ['ls-tree', '--format=%(objectname)', ref, '--', path], { env });
  if (entry.status !== 0) throw new Error(`cannot read test file budget tree at ${ref}`);
  if (!entry.stdout.trim()) return null;
  const result = tryGit(root, ['show', `${ref}:${path}`], { env });
  if (result.status !== 0) throw new Error(`cannot read test file budget row ${path}`);
  const value = JSON.parse(result.stdout);
  if (value?.version !== 1 || typeof value.file !== 'string' || testFileBudgetPath(value.file) !== path) throw new Error(`invalid test file budget row ${path}`);
  return { file: value.file, ms: testFileLimit(value.ms) };
}

/** Compare changed rows and read only the selected files, not the repository-wide table. */
export function readTestFileBudgets(root, files) {
  const portable = files.map(file => testFileRelative(root, file));
  const env = gitChildEnv(root);
  if (tryGit(root, ['rev-parse', '--git-dir'], { env }).status !== 0) return new Map(portable.map(file => [file, { ms: DEFAULT_TEST_FILE_BUDGET_MS, audit: false }]));
  const main = mainCheckout(root)?.commit ?? carriedRunnerTrunk(root)?.commit;
  if (!main) throw new Error('cannot determine accepted main for test file budgets');
  const diff = tryGit(root, ['diff', '--no-renames', '--name-only', '-z', main, 'HEAD', '--', DIRECTORY], { env });
  if (diff.status !== 0) throw new Error('cannot compare test file budgets to accepted main');
  for (const path of diff.stdout.split('\0').filter(Boolean)) {
    const before = rowAt(root, main, path, env), after = rowAt(root, 'HEAD', path, env);
    if (before && after && before.file !== after.file) throw new Error(`test file budget identity changed at ${path}`);
    requireTestFileRatchet(after?.file ?? before?.file ?? path, before?.ms, after?.ms);
  }
  const inside = portable.filter(file => file !== '..' && !file.startsWith('../') && !posix.isAbsolute(file));
  const insideSet = new Set(inside);
  for (const file of inside) testFileBudgetPath(posix.normalize(file));
  const placement = readPlacementIndex(root, inside);
  const audits = new Set(placement.files.filter(row => row.tier === 'audit').map(row => row.file));
  return new Map(portable.map(file => {
    const row = insideSet.has(file) ? rowAt(root, 'HEAD', testFileBudgetPath(file), env) : null;
    return [file, { ms: row?.ms ?? DEFAULT_TEST_FILE_BUDGET_MS, audit: audits.has(file) }];
  }));
}
