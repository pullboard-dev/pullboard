#!/usr/bin/env node
/** Rebuild the shared test registries after an item merge and print the files that changed, one JSON list [C7,V24]. */
import { git } from '../../../../../git/index.js';
import { deriveTestRegistries } from '../../../../index.js';

/**
 * What the item merge changed in test files: each rename (old path to new) and every path added, copied, modified or renamed to.
 * Why: the test registries follow these so a move needs no hand edit; a checkout with no merge parent has no changes to follow.
 * @returns {{ renamed: Map<string, string>, touched: string[] }}
 */
export function mergeTestChanges(root, base = 'HEAD^1') {
  const renamed = new Map(), touched = [];
  let out = '';
  try { out = git(root, ['diff', '--name-status', '-M', base, 'HEAD']); } catch { return { renamed, touched }; }
  for (const line of out.split('\n').filter(Boolean)) {
    const [status, from, to] = line.split('\t');
    if (status.startsWith('R')) { renamed.set(from, to); touched.push(to); }
    else if (status !== 'D') touched.push(from);
  }
  return { renamed, touched };
}

const at = process.argv.indexOf('--base');
const root = process.cwd();
process.stdout.write(`${JSON.stringify(deriveTestRegistries(root, mergeTestChanges(root, at < 0 ? 'HEAD^1' : process.argv[at + 1])))}\n`);
