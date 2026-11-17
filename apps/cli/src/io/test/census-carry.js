/** The skip-unchanged step of `pullboard test --census`: choose the files to run and the earlier green rows to carry [C7,#10383]. */
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { selectAffectedTests } from '../../../../../packages/gate/index.js';
import { carriedRows } from '../../logic/census-skip.js';
import { skipSplit } from '../../logic/census-skip.js';

/** The rows of one census JSONL; a torn line is skipped. */
function readRows(path) {
  try { return readFileSync(path, 'utf8').split('\n').flatMap((line) => { try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; } }); } catch { return []; }
}

/**
 * Split a census's files into those to run and the earlier green rows to carry. Everything runs unless the newest earlier
 * census in `dir` (never `out`) exists, its sha is an ancestor of `sha`, and the affected-test selection between them is
 * not the full suite. Why: a census on a sha that does not descend from the earlier one cannot trust its rows [C7,#10383].
 *
 * @param {string} root - The checkout being censused.
 * @param {{ files: string[], sha: string, dir: string, out: string }} input
 * @returns {{ run: string[], carried: object[], from: string | null }}
 */
export function censusCarry(root, { files, sha, dir, out }) {
  const all = { run: files, carried: [], from: null };
  let names;
  try { names = readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => join(dir, name)).filter(path => resolve(path) !== resolve(out)); } catch { return all; }
  const newest = names.map((path) => { try { return { path, at: statSync(path).mtimeMs }; } catch { return null; } }).filter(Boolean).sort((a, b) => b.at - a.at)[0];
  if (!newest) return all;
  const previousRows = readRows(newest.path);
  const from = previousRows[0]?.sha;
  if (!from || from === sha) return all;
  if (spawnSync('git', ['merge-base', '--is-ancestor', from, sha], { cwd: root }).status !== 0) return all;
  const selection = selectAffectedTests(root, { base: from, commit: sha });
  const split = skipSplit({ files, previousRows, selection });
  return { run: split.run, carried: carriedRows(previousRows, split.skip, from), from };
}
