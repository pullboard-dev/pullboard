/** Stage the shared test registries a landing derives from what the item merge moved, so no lane hand-edits them [C7,V24]. */
import { git } from '../../../git/index.js';

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

/**
 * Rebuild the test registries in the merged tree and stage the ones that changed.
 * Why: the gate door is loaded only here, when a landing derives, so the landing's other modules never reach the CLI through it.
 * @param {string} root A checkout of the merged tree.
 * @param {string} [base] The commit the merge started from.
 * @returns {Promise<string[]>} The staged registry files.
 */
export async function stageTestRegistries(root, base = 'HEAD^1') {
  const { deriveTestRegistries } = await import('../../../gate/index.js');
  const registries = deriveTestRegistries(root, mergeTestChanges(root, base));
  if (registries.length) git(root, ['add', '--', ...registries]);
  return registries;
}
