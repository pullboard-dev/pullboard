import { clauseTestFile } from '../../../../../packages/state/index.js';
import { criterionClauses } from '../../../../../packages/state/index.js';
import { itemFiles } from '../../../../../packages/items/index.js';
import { contains } from '../../../../../packages/git/index.js';
import { resolveCommit } from '../../../../../packages/git/index.js';
import { tryGit } from '../../../../../packages/git/index.js';

/** A clause tick note: "clause N [kind]: evidence". */
const TICK_NOTE = /^clause \d+ \[[a-z]+\]:/u;

/**
 * The commits a clause tick cites that carry the same work as the submitted head: each is an ancestor of the head, and
 * nothing the item changed or any test file its clauses cite differs between it and the head, so only a merge of main
 * separates them. Anything else, including an item with no recorded files, gives none and the accept refuses as before.
 * Why: a tick cites the head it ran on, the board then merges main for the gate, and the reviewer's accept refused
 * CLAUSE_UNTICKED for work it could see was identical (#11077, #11082, #11092, #11047, #11098 on 18 Nov) [C7].
 *
 * @param {string} root - The review checkout.
 * @param {any} item - The item row; item_commit is the submitted head.
 * @param {object[]} thread - The item's thread.
 * @returns {string[]} Full shas of the cited commits that count as the submitted head.
 */
export function sameWorkHeads(root, item, thread) {
  const head = item.item_commit ? resolveCommit(root, item.item_commit) : null;
  const files = itemFiles(item);
  if (!head || files.length === 0) return [];
  const clauses = criterionClauses(item.item_criterion);
  const tests = clauses.map(clause => clauseTestFile(clause, clauses)).filter(Boolean);
  const paths = [...new Set([...files, ...tests])];
  const cited = new Set();
  for (const entry of thread) {
    if (entry.type !== 'fact' || entry.kind !== 'note' || !TICK_NOTE.test(String(entry.text).trim())) continue;
    for (const sha of String(entry.text).toLowerCase().match(/\b[0-9a-f]{7,64}\b/gu) ?? []) cited.add(sha);
  }
  const heads = [];
  for (const sha of cited) {
    const full = resolveCommit(root, sha);
    if (!full || full === head || heads.includes(full) || !contains(root, full, head)) continue;
    if (tryGit(root, ['diff', '--quiet', `${full}...${head}`, '--', ...paths]).status === 0) heads.push(full);
  }
  return heads;
}
