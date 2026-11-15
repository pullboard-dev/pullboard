/** The base-commit run of a [test] clause's named file, for its fail-before receipt [C7]. */
import { Refused } from '../../../kernel/index.js';
import { tryGit } from '../../../git/index.js';
import { committedTest } from './tap.js';
import { runMainComparison } from './execution.js';

/**
 * Run a clause's named test file at the item's base commit through the main comparison, so the receipt it leaves
 * carries each case's outcome and failure kind (assertion or error). Why: reusing runMainComparison keeps one run path,
 * and a pinned source runs the base on the admitted runner without touching this checkout [C7].
 *
 * @param {string} root - Any checkout of the repository.
 * @param {string} base - The item's base commit.
 * @param {string} file - The test file the clause names, repository-relative.
 * @param {object} [options] - runMainComparison options (gateLease, waitMs, detailed); the lease must be admitted for `base`.
 * @returns {Promise<object>} the comparison's run, with `receiptId` when it left a receipt.
 */
export async function runClauseBaseComparison(root, base, file, options = {}) {
  if (!/^[a-f0-9]{40}$/u.test(base ?? '')) throw new Refused('BASE_COMMIT', 'a base comparison needs the item\'s full base commit; submit from the item folder');
  if (!committedTest(root, base, file)) throw new Refused('NO_BASE_FILE', `${file} does not exist at the item's base commit, so it cannot fail there; name an existing test file or add the case to one`);
  const tree = tryGit(root, ['rev-parse', `${base}^{tree}`]);
  if (tree.status !== 0) throw new Refused('BASE_COMMIT', 'the item\'s base commit is not in this repository; fetch it and retry');
  return runMainComparison(root, file, { ...options, source: { head: base, tree: tree.stdout.trim() } });
}
