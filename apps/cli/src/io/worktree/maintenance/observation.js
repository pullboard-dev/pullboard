/** Native observations and leases for repository-scoped worktree maintenance [B3,C7]. */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync } from 'node:fs';
import { constants } from 'node:fs';
import { existsSync } from 'node:fs';
import { fsyncSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { repoInfo } from '../../../../../../packages/git/index.js';
import { holdsLease } from '../../../../../../packages/resources/index.js';
import { takeResource } from '../../../../../../packages/resources/index.js';
import { maintenanceGit } from './archive.js';
import { workingDirectories } from '../../../../../../packages/landing/index.js';
import { withFileLock } from '../../../../../../packages/outbox/index.js';
import { environmentAdapter } from '../../../../../../packages/env/index.js';

export { workingDirectories as maintenanceWorkingDirectories };

/** Parse only Git's actual NUL-delimited registrations, including locks that forbid pruning. */
export function registeredMaintenanceTrees(root) {
  const output = maintenanceGit(root, ['worktree', 'list', '--porcelain', '-z']);
  if (!output.endsWith('\0')) throw new Error('maintenance worktree registration is incomplete');
  const trees = [];
  let tree;
  for (const field of output.split('\0')) {
    if (!field) continue;
    if (field.startsWith('worktree ')) {
      tree = { path: field.slice(9) };
      if (!isAbsolute(tree.path)) throw new Error('maintenance registration has a relative path');
      trees.push(tree);
    } else if (!tree) throw new Error('maintenance registration has no root');
    else if (field.startsWith('HEAD ')) tree.head = field.slice(5);
    else if (field === 'bare') tree.bare = true;
    else if (field === 'locked' || field.startsWith('locked ')) tree.locked = true;
    else if (field === 'prunable' || field.startsWith('prunable ')) tree.prunable = true;
  }
  if (!trees.length || trees.some(row => !row.bare && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(row.head ?? '')))
    throw new Error('maintenance registration has an unknown HEAD');
  return trees;
}

/** Acquire the exact lease used by native claim/hook binding; contention keeps the target. */
export async function takeMaintenanceCheckout(root, agent) {
  const info = repoInfo(root);
  const name = 'checkout-session:' + createHash('sha256').update(info.gitDir).digest('hex');
  const inherited = environmentAdapter().get('PULLBOARD_CHECKOUT_SESSION_TOKEN');
  if (inherited && holdsLease({ name, scope: 'repo', root, token: inherited })) return { release() {} };
  return takeResource({ name, capacity: 1, scope: 'repo', root, agent,
    /** Never wait for an active session or stop its command to make maintenance progress. */
    onWait() { throw new Error('maintenance checkout is busy; source retained'); } });
}

/** Keep recovery observations private and outside every removable worktree. */
export function maintenanceDirectory(common) {
  let directory = common;
  for (const name of ['pullboard', 'worktree-maintenance']) {
    directory = join(directory, name);
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const state = lstatSync(directory);
    if (!state.isDirectory() || state.isSymbolicLink() || name === 'worktree-maintenance' && (state.mode & 0o077))
      throw new Error('maintenance state directory changed');
  }
  return directory;
}

/** Serialize whole sweeps independently of foreground checkout ownership and the hourly timer. */
export async function withMaintenanceLock(common, work) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error('maintenance needs no-follow file observation');
  const file = join(maintenanceDirectory(common), 'sweep.guard.sqlite');
  try { closeSync(openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const state = lstatSync(file);
  if (!state.isFile() || state.isSymbolicLink() || state.mode & 0o077) throw new Error('maintenance sweep lock is not private');
  return withFileLock(file, work);
}

/** Read a bounded completed observation; missing history supplies no invented retention age. */
export function readMaintenanceState(common) {
  const file = join(common, 'pullboard', 'worktree-maintenance', 'state.json');
  if (!existsSync(file)) return { version: 1, trees: {} };
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error('maintenance state is not a bounded file');
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value?.version !== 1 || !value.trees || typeof value.trees !== 'object' || Array.isArray(value.trees))
    throw new Error('maintenance state is incomplete');
  return value;
}

/** Persist intent before deletion, and final outcomes after it; a partial write is never an archive receipt. */
export function writeMaintenanceState(common, state) {
  const directory = maintenanceDirectory(common), file = join(directory, 'state.json');
  const temporary = join(directory, randomUUID() + '.tmp');
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(state, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, file);
}

/** Count allocated worktree bytes without interpreting paths as flags or measuring unrelated filesystem activity. */
export function maintenanceAllocatedBytes(path) {
  if (!isAbsolute(path)) return null;
  const value = spawnSync('/usr/bin/du', ['-sk', path], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4096 });
  const number = value.status === 0 && !value.error && !value.signal ? /^([0-9]+)\s/u.exec(value.stdout)?.[1] : null;
  const bytes = number === null ? NaN : Number(number) * 1024;
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}
