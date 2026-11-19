/** Whether a land job's trunk remote is a checkout on this host with the trunk branch checked out [C7,P7]. */
import { homedir } from 'node:os';
import { hostname } from 'node:os';
import { networkInterfaces } from 'node:os';
import { userInfo } from 'node:os';
import { isAbsolute } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryGit } from '../../../../../packages/git/index.js';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';

const fs = fileSystemAdapter();

/** The names and addresses this host answers to, as an ssh or scp-like trunk remote may spell it. */
function localHosts() {
  const names = new Set(['localhost', '127.0.0.1', '::1']);
  const own = hostname().toLowerCase();
  names.add(own).add(own.split('.')[0]);
  for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) names.add(entry.address.toLowerCase());
  return names;
}

/**
 * The local path a trunk remote names, or null when it names another host or user. Why: the board host can only look
 * inside a repository it reaches on disk; a scp-like address of this host (user@100.x:pb-trunk) is such a path.
 */
function localPath(remote, root) {
  if (remote.startsWith('file://')) return fileURLToPath(remote);
  const url = /^ssh:\/\/(?:([^@/]+)@)?(\[[^\]]+\]|[^:/]+)(?::\d+)?(\/.*)$/u.exec(remote);
  const scp = url ? null : /^(?:([^@/:]+)@)?(\[[^\]]+\]|[^:/]+):(?!\/\/)(.*)$/u.exec(remote);
  if (!url && !scp) return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(remote) ? null : resolve(root, remote);
  const [, user, host, path] = url ?? scp;
  if (user && user !== userInfo().username) return null;
  if (!localHosts().has(host.replace(/^\[|\]$/gu, '').toLowerCase())) return null;
  return isAbsolute(path) ? path : resolve(homedir(), path.replace(/^~\//u, ''));
}

/**
 * True when the trunk remote is a non-bare repository on this host with the trunk branch checked out in one of its work
 * trees, so the land job's push must update that tree in place (receive.denyCurrentBranch=updateInstead). Why: a trunk
 * remote of record naming the board host's own checkout (pb-trunk links to it) took a plain push, and git refused every
 * landing with "refusing to update checked out branch" (#7951). A bare trunk, or one on another host, stays false.
 *
 * @param {string} remote - The trunk remote of record, or the board host's checkout itself.
 * @param {string} root - The main checkout, which a relative remote resolves from.
 * @param {string} trunk - The trunk ref, like refs/heads/main.
 */
export function trunkCheckedOut(remote, root, trunk) {
  const path = localPath(remote, root);
  if (!path || !fs.exists(path)) return false;
  const listed = tryGit(path, ['worktree', 'list', '--porcelain']);
  if (listed.status !== 0) return false;
  return listed.stdout.split(/\n\n+/u).some(block => !/^bare$/mu.test(block) && block.split('\n').includes(`branch ${trunk}`));
}

/**
 * Doctor's finding for a trunk remote that is a non-bare checkout on this host with trunk checked out but without
 * receive.denyCurrentBranch=updateInstead set on it, or null. Why: an ssh trunk whose login takes only plain git
 * commands rejects the lander's custom receive-pack, so the repo itself must allow the push into its checkout (#7952).
 *
 * @param {string | null} remote - The trunk remote of record.
 * @param {string} root - The main checkout, which a relative remote resolves from.
 * @param {string} trunk - The trunk ref, like refs/heads/main.
 */
export function trunkUpdateInsteadProblem(remote, root, trunk) {
  if (!remote || !trunkCheckedOut(remote, root, trunk)) return null;
  const path = localPath(remote, root);
  if (tryGit(path, ['config', '--get', 'receive.denyCurrentBranch']).stdout.trim() === 'updateInstead') return null;
  return { code: 'TRUNK_UPDATEINSTEAD', message: `the trunk ${remote} is a checkout with ${trunk.replace(/^refs\/heads\//u, '')} checked out, and it lacks receive.denyCurrentBranch=updateInstead, so a plain push into it is refused`,
    next: `run git -C ${JSON.stringify(path)} config receive.denyCurrentBranch updateInstead` };
}
