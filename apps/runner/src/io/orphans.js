/** Read another runner process's SSH client address and command line for the orphan check [C7]. */
import { spawnSync } from 'node:child_process';
import { fileSystemAdapter } from '../../../../packages/fs/index.js';

const disk = fileSystemAdapter();
const PS_ENV = { PATH: '/usr/bin:/bin:/usr/sbin', LC_ALL: 'C' };

/**
 * The SSH client address in another process's environment, or null when it cannot be read.
 * Why: the address ties a worker to the controller machine that launched it, so a probe from one coordinator never
 * reclaims a worker another coordinator still runs on a shared runner.
 *
 * @param {number} pid
 * @returns {string|null}
 */
export function sshClientAddress(pid) {
  try {
    if (process.platform === 'linux') {
      const entry = disk.readFile(`/proc/${pid}/environ`, 'utf8').split('\0').find(line => line.startsWith('SSH_CLIENT='));
      return /^SSH_CLIENT=(\S+)\s/u.exec(entry ?? '')?.[1] ?? null;
    }
    const shown = spawnSync('/bin/ps', ['-wwE', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000, env: PS_ENV });
    if (shown.error || shown.status !== 0) return null;
    return /(?:^|\s)SSH_CLIENT=(\S+)\s/u.exec(shown.stdout)?.[1] ?? null;
  } catch { return null; }
}

/**
 * One process's full command line, or null when it is gone or unreadable.
 *
 * @param {number} pid
 * @returns {string|null}
 */
export function processCommand(pid) {
  const shown = spawnSync('/bin/ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000, env: PS_ENV });
  return shown.error || shown.status !== 0 ? null : shown.stdout.trim();
}

/** The observer the runner's health entry hands its idle reply, so it can find and stop orphan workers. */
export const orphanObserver = Object.freeze({ clientOf: sshClientAddress, commandOf: processCommand });
