/** Read committed coordinator policy without loading check execution or resource admission [C7,V4]. */
import { spawnSync } from 'node:child_process';
import { configFromSource } from './config.js';
import {
  cleanGitEnvironment,
  mainCheckout,
} from './git.js';
import { Refused } from './refused.js';
import { carriedRunnerTrunk } from './runner-policy.js';

/** Read raw Git output, retaining NUL-delimited names without exposing Git diagnostics. */
export function policyGit(root, args) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Refused('NO_POLICY', 'the committed coordinator policy or claim base is missing; restore its Git objects or ask the coordinator to refreeze the item');
  return result.stdout;
}

/** Resolve the primary checkout's committed HEAD, independently of a linked or detached checkout. */
export function mainPolicy(root) {
  const checkout = mainCheckout(root);
  if (!checkout) {
    const carried = carriedRunnerTrunk(root);
    if (carried) return policyAt(root, carried.commit);
    throw new Refused('NO_POLICY', 'the coordinator checkout is detached for review; ask it to return to its main branch before claiming or running the project gate');
  }
  if (!checkout.commit) throw new Refused('NO_POLICY', 'the coordinator checkout has no commit on ' + checkout.branch + '; create its first commit before claiming or running the project gate');
  return policyAt(root, checkout.commit);
}

export { trunkRef } from './git-trunk-ref.js';

/** Re-read coordinator settings from a pinned Git object; never from the candidate filesystem. */
export function policyAt(root, commit) {
  if (!/^[0-9a-f]{40,64}$/.test(commit ?? '')) throw new Refused('NO_POLICY', 'this item has no recorded claim base; ask the coordinator to refreeze it and claim it again');
  const config = configFromSource(policyGit(root, ['show', commit + ':pullboard.json']));
  return { version: 1, commit, config };
}

