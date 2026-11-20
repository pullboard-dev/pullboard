/** Read a GitHub owner/repository from an origin remote lookup, shared by seats and the github cell above it [C7,H16]. */
import { Refused } from '../../../../kernel/browser.js';

/**
 * Resolve the actual GitHub origin from a `git remote get-url origin` result; optional discovery leaves
 * ineligible local projects alone.
 *
 * The caller runs git, so project registration and relay discovery read one parser without either
 * loading the other's cell.
 *
 * @param {{ status: number, stdout: string }} remote
 * @param {{ optional?: boolean }} [options]
 * @returns {string | null}
 */
export function remoteRepository(remote, { optional = false } = {}) {
  if (remote.status !== 0 && optional) return null;
  if (remote.status !== 0) throw new Refused('RELAY_ORIGIN', 'add a GitHub origin remote before running pullboard relay on');
  let repository;
  const ssh = /^git@github\.com:([^\s?#]+)$/.exec(remote.stdout);
  if (ssh) repository = ssh[1];
  else {
    try {
      const url = new URL(remote.stdout);
      if (url.hostname === 'github.com' && !url.password && !url.search && !url.hash &&
          ((url.protocol === 'https:' && !url.username) || (url.protocol === 'ssh:' && url.username === 'git')) && !url.port) repository = url.pathname.slice(1);
    } catch { /* A local path or another host is not a GitHub repository. */ }
  }
  repository = repository?.replace(/\.git$/, '');
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/').some((part) => ['.', '..'].includes(part))) {
    if (optional) return null;
    throw new Refused('RELAY_ORIGIN', 'origin must name a GitHub owner/repository using HTTPS or git SSH; fix origin and run pullboard relay on');
  }
  return repository;
}
