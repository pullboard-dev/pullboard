/** Read committed coordinator policy without loading check execution or resource admission [C7,V4]. */
import { spawnSync } from './windows-child-process.js';
import { configFromSource } from './config.js';
import {
  cleanGitEnvironment,
  gitConfig,
  invalidateGitFacts,
  localConfigIs,
  mainCheckout,
} from './git.js';
import { Refused } from './refused.js';

/** Read raw Git output, retaining NUL-delimited names without exposing Git diagnostics. */
export function policyGit(root, args) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Refused('NO_POLICY', 'the committed coordinator policy or claim base is missing; restore its Git objects or ask the coordinator to refreeze the item');
  return result.stdout;
}

/** Resolve the primary checkout's committed HEAD, independently of a linked or detached checkout. */
export function mainPolicy(root) {
  const checkout = mainCheckout(root);
  if (!checkout) throw new Refused('NO_POLICY', 'the coordinator checkout is detached for review; ask it to return to its main branch before claiming or running the project gate');
  if (!checkout.commit) throw new Refused('NO_POLICY', 'the coordinator checkout has no commit on ' + checkout.branch + '; create its first commit before claiming or running the project gate');
  return policyAt(root, checkout.commit);
}

/** Retain the local primary branch outside replicated board data and read-only diagnostics [B34,V6]. */
export function trunkRef(root, branch) {
  // A trunk already recorded as this branch needs no Git process to confirm and nothing written.
  if (branch !== undefined && localConfigIs(root, 'pullboard', 'trunk', branch)) return branch;
  const read = gitConfig(root, 'pullboard.trunk', { local: true, clean: true, flags: false, noReplace: true });
  if (read.status !== 0 && read.status !== 1) throw new Refused('NO_POLICY', 'the retained trunk cannot be read; restore the local Git configuration and retry');
  const current = read.status === 0 ? read.stdout.trim() : null;
  if (branch === undefined || branch === current) return current;
  const saved = spawnSync('git', ['--no-replace-objects', 'config', '--local', '--replace-all', 'pullboard.trunk', branch], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8',
  });
  invalidateGitFacts();
  if (saved.status !== 0) throw new Refused('NO_POLICY', 'the trunk branch cannot be recorded; restore writable local Git configuration and retry');
  return branch;
}

/** Re-read coordinator settings from a pinned Git object; never from the candidate filesystem. */
export function policyAt(root, commit) {
  if (!/^[0-9a-f]{40,64}$/.test(commit ?? '')) throw new Refused('NO_POLICY', 'this item has no recorded claim base; ask the coordinator to refreeze it and claim it again');
  const config = configFromSource(policyGit(root, ['show', commit + ':pullboard.json']));
  return { version: 1, commit, config };
}

