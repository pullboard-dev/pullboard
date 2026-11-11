import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { git } from '../../../../packages/git/index.js';
import { gitChildEnv } from '../../../../packages/git/index.js';
import { mainCheckout } from '../../../../packages/git/index.js';
import { Refused } from '../../../../packages/kernel/light.js';
import { trunkRef } from '../../../../packages/sandbox/index.js';

/**
 * Read the collision baseline from the primary branch, retained trunk, or detached HEAD default.
 *
 * @param {string} root
 * @param {string} path
 * @param {string} [revision]
 * @returns {{ status: number, stdout: string, baseline?: string }}
 */
export function coordinatorFile(root, path, revision) {
  const commonDir = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const coordinatorRoot = dirname(commonDir);
  const env = { ...gitChildEnv(root), GIT_NO_REPLACE_OBJECTS: '1' };
  const primary = mainCheckout(coordinatorRoot);
  let ref = primary?.branch ?? trunkRef(coordinatorRoot);
  const detachedHeadDefault = !primary && !ref;
  if (detachedHeadDefault) ref = 'HEAD';
  if (ref !== 'HEAD' && !ref?.startsWith('refs/heads/')) {
    throw new Refused('NO_TRUNK', 'no trunk branch was recorded; check out the trunk branch in the main checkout once and run pullboard inbox');
  }
  if (!primary) {
    const tip = spawnSync('git', ['--no-replace-objects', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: coordinatorRoot, env, encoding: 'utf8',
    });
    if (tip.status !== 0) {
      throw new Refused('NO_TRUNK', 'the recorded trunk branch has no readable tip; check out the trunk branch in the main checkout once and run pullboard inbox');
    }
    ref = tip.stdout.trim();
  }
  const result = spawnSync('git', ['--no-replace-objects', 'show', `${revision ?? ref}:${path}`], {
    cwd: coordinatorRoot, env, encoding: 'utf8',
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    ...(detachedHeadDefault ? { baseline: 'collision baseline default: detached HEAD' } : {}),
  };
}
