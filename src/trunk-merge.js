import { existsSync } from 'node:fs';
import { join } from 'node:path';
/** In-memory Git conflict computation without loading check execution or resource admission [V4,C7]. */
import { spawnSync } from './windows-child-process.js';
import { cleanGitEnvironment } from './git.js';
import { mainCheckout } from './git.js';
import { trunkRef } from './trusted-policy-read.js';
import { Refused } from './refused.js';
import { mechanicalConflictFiles } from './mechanical-merge.js';

/** Merge a commit onto the trunk tip in memory: the ref, the tip, and the conflicting files or null [B34,V6].
 *
 * @param {string} root
 * @param {string} commit
 * @param {string} [retainedRef]
 * @returns {{ ref: string, commit: string, files: string[] | null }}
 */
export function trunkMerge(root, commit, retainedRef = trunkRef(root)) {
  const checkout = mainCheckout(root);
  const branchRef = checkout?.branch ?? retainedRef;
  if (!branchRef?.startsWith('refs/heads/')) throw new Refused('NO_TRUNK', 'no trunk branch was recorded; check out the trunk branch in the main checkout once and run pullboard inbox');
  const tip = spawnSync('git', ['--no-replace-objects', 'rev-parse', '--verify', '--quiet', branchRef + '^{commit}'], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8' });
  if (tip.status !== 0) throw new Refused('NO_TRUNK', 'the recorded trunk branch has no readable tip; check out the trunk branch in the main checkout once and run pullboard inbox');
  const files = mechanicalConflictFiles(root, tip.stdout.trim(), commit);
  if (files === null) throw new Refused('MERGE_CHECK_FAILED', 'Git could not check the candidate against the trunk; use Git 2.38 or newer, restore its objects and retry');
  return { ref: branchRef, commit: tip.stdout.trim(), files: files.length ? files : null };
}


/** Verify exactly the recorded immutable commits, independent of this machine's current trunk. */
export function recordedTrunkMerge(gitDirectory, head, trunk, { version = 2 } = {}) {
  if (version === 1) return plainRecordedTrunkMerge(gitDirectory, head, trunk);
  const files = mechanicalConflictFiles(gitDirectory, trunk, head, { gitDirectory });
  if (files === null) throw new Refused('MERGE_CHECK_FAILED', 'fetch the recorded submitted and trunk commits, then resume this move; Git could not verify its immutable conflict');
  return files.length ? files : null;
}

/** Preserve version-one immutable evidence exactly: mechanical policy never reinterprets historical receipts. */
function plainRecordedTrunkMerge(gitDirectory, head, trunk) {
  const result = spawnSync('git', ['--no-replace-objects', `--git-dir=${gitDirectory}`, '-c', 'core.quotepath=false',
    'merge-tree', '--write-tree', '--name-only', '-z', trunk, head], {
    env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  // Git may return 1 for an invalid/missing merge parent as well as for a real conflict.
  // Only a merge result carrying its output tree can establish either clean or conflicting state.
  const output = (result.stdout ?? '').split('\0');
  if (![0, 1].includes(result.status) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(output[0].trim())) {
    throw new Refused('MERGE_CHECK_FAILED', 'fetch the recorded submitted and trunk commits, then resume this move; Git could not verify its immutable conflict');
  }
  if (result.status === 0) return null;
  const records = output.slice(1), end = records.indexOf('');
  const files = records.slice(0, end < 0 ? records.length : end);
  if (!files.length) throw new Refused('MERGE_CHECK_FAILED', 'Git did not provide conflict paths for the recorded commits; fetch their complete objects before resuming');
  return files;
}


/** Refuse local history overrides before trusting either a fresh or cached immutable conflict result. */
export function refuseRecordedHistoryOverrides(gitDirectory) {
  if (existsSync(join(gitDirectory, 'info', 'grafts'))) {
    throw new Refused('GIT_GRAFTS', 'recorded conflict replay cannot trust a repository with info/grafts; ask the coordinator to remove its graft file, then resume the same move');
  }
  const refs = spawnSync('git', ['--no-replace-objects', `--git-dir=${gitDirectory}`, 'for-each-ref', '--format=%(refname)', 'refs/replace/'],
    { env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (refs.status !== 0) throw new Refused('MERGE_CHECK_FAILED', 'Git could not inspect this replica history; restore its object store, then resume the same move');
  if (refs.stdout.trim()) throw new Refused('GIT_REPLACE_REFS',
    'recorded conflict replay cannot trust a repository with replacement refs; ask the coordinator to remove the refs/replace entries, then resume the same move');
}
