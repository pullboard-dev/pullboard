/** Capture immutable source and executed test observations without writing proof receipts [C7,H16]. */
import { invalidateGitFacts } from '../../../git/index.js';
import { headCommit } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { gitChildEnv } from '../../../git/index.js';
import { tapTests } from './tap.js';

/** Capture source identifiers before execution; a dirty tree remains explicitly unproven. */
export function proofSourceAt(root, commit, committedTree) {
  invalidateGitFacts(); // The child may have changed Git facts outside this command context.
  const head = commit ?? headCommit(root);
  const tree = head ? tryGit(root, ['rev-parse', '--verify', `${head}^{tree}`], { env: gitChildEnv(root) }) : null;
  const clean = commit !== null || committedTree(root) !== null;
  return { head: clean ? head : null, tree: clean && tree?.status === 0 ? tree.stdout : null, clean };
}

/** Retain explicit executed TAP outcomes; skipped, aggregate and aborted cases prove no named result. */
export function testValueProfile(root, run) {
  try {
    return { ...run.profile, tests: tapTests(run.output ?? '', run.executionRoot ?? root).filter(row =>
      !row.skip && row.type !== 'suite'
      && !['subtestsFailed', 'cancelledByParent', 'testAborted'].includes(row.failureType)) };
  } catch { return null; }
}

