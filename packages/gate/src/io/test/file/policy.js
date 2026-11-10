/** Read only reached file limits and changed ratchet rows from committed Git sources [C7]. */
import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { sep } from 'node:path';
import { posix } from 'node:path';
import { gitChildEnv } from '../../../../../git/index.js';
import { tryGit } from '../../../../../git/index.js';
import { mainCheckout } from '../../../../../git/index.js';
import { carriedRunnerTrunk } from '../../../../../sandbox/light.js';
import { mainPolicy } from '../../../../../sandbox/light.js';
import { DEFAULT_TEST_FILE_BUDGET_MS } from '../../../logic/test/budget/file.js';
import { requireTestFileRatchet } from '../../../logic/test/budget/file.js';
import { testFileLimit } from '../../../logic/test/budget/file.js';

const DIRECTORY = '.pullboard/test-file-budgets';
export function testFileRelative(root, file) { return relative(root, resolve(root, file)).split(sep).join('/'); }

/** Hash names so paths never escape the tracked table directory. */
export function testFileBudgetPath(file) {
  if (typeof file !== 'string' || !file || file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..')) throw new TypeError('invalid test file path');
  return `${DIRECTORY}/${createHash('sha256').update(file).digest('hex')}.json`;
}

/** A runner's linked item worktree shares its primary checkout's admitted trunk, not its HEAD. */
export function acceptedBudgetTrunk(root, env = gitChildEnv(root)) {
  const main = mainCheckout(root) ?? carriedRunnerTrunk(root);
  if (main?.commit) return main;
  const list = tryGit(root, ['worktree', 'list', '--porcelain', '-z'], { env });
  if (list.status !== 0) return null;
  const first = list.stdout.split('\0').find(entry => entry.startsWith('worktree '));
  const primary = first?.slice('worktree '.length);
  return primary ? carriedRunnerTrunk(primary) : null;
}

/** Read only reached rows, batching tree lookups so absent defaults do not each launch Git. */
function rowsAt(root, ref, paths, env) {
  const rows = new Map(), unique = [...new Set(paths)];
  for (let start = 0; start < unique.length; start += 200) {
    const entry = tryGit(root, ['ls-tree', '-r', '-z', '--name-only', ref, '--', ...unique.slice(start, start + 200).map(path => `:(literal)${path}`)], { env });
    if (entry.status !== 0) throw new Error(`cannot read test file budget tree at ${ref}`);
    for (const path of entry.stdout.split('\0').filter(Boolean)) {
      const result = tryGit(root, ['show', `${ref}:${path}`], { env });
      if (result.status !== 0) throw new Error(`cannot read test file budget row ${path}`);
      let value;
      try { value = JSON.parse(result.stdout); }
      catch { throw new Error(`invalid test file budget row ${path}`); }
      if (value?.version !== 1 || typeof value.file !== 'string' || !Object.hasOwn(value, 'ms') || testFileBudgetPath(value.file) !== path
        || value.placement !== undefined && value.placement !== 'audit') throw new Error(`invalid test file budget row ${path}`);
      let ms;
      try { ms = testFileLimit(value.ms); }
      catch { throw new Error(`invalid test file budget row ${path}`); }
      rows.set(path, { file: value.file, ms, audit: value.placement === 'audit' });
    }
  }
  return rows;
}

/** Compare changed rows and read only the selected files, not the repository-wide table. */
export function readTestFileBudgets(root, files) {
  const portable = files.map(file => testFileRelative(root, file));
  const env = gitChildEnv(root);
  if (tryGit(root, ['rev-parse', '--git-dir'], { env }).status !== 0) return new Map(portable.map(file => [file, { ms: DEFAULT_TEST_FILE_BUDGET_MS, audit: false }]));
  // No admitted trunk is the policy authority's refusal: it names NO_POLICY and its fix before any file runs [V4].
  const main = acceptedBudgetTrunk(root, env)?.commit ?? mainPolicy(root).commit;
  if (!main) throw new Error('cannot determine accepted main for test file budgets; restore the main checkout or run through the runner with its pinned trunk');
  const diff = tryGit(root, ['diff', '--no-renames', '--name-only', '-z', main, 'HEAD', '--', DIRECTORY], { env });
  if (diff.status !== 0) throw new Error('cannot compare test file budgets to accepted main');
  const changed = diff.stdout.split('\0').filter(Boolean);
  const inside = portable.filter(file => file !== '..' && !file.startsWith('../') && !posix.isAbsolute(file));
  const insideSet = new Set(inside);
  const selected = inside.map(file => testFileBudgetPath(posix.normalize(file)));
  const previous = rowsAt(root, main, changed, env);
  const current = rowsAt(root, 'HEAD', [...changed, ...selected], env);
  for (const path of changed) {
    const before = previous.get(path), after = current.get(path);
    if (before && after && before.file !== after.file) throw new Error(`test file budget identity changed at ${path}`);
    requireTestFileRatchet(after?.file ?? before?.file ?? path, before?.ms, after?.ms);
  }
  return new Map(portable.map(file => {
    const row = insideSet.has(file) ? current.get(testFileBudgetPath(file)) : null;
    return [file, { ms: row?.ms ?? DEFAULT_TEST_FILE_BUDGET_MS, audit: row?.audit === true }];
  }));
}
