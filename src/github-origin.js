/** GitHub origin discovery without loading relay transport [C7,H16]. */
import { tryGit } from './git.js';
import { remoteRepository } from './github-remote.js';

/** Resolve the actual GitHub origin; optional discovery leaves ineligible local projects alone. */
export function originRepository(root, { optional = false } = {}) {
  return remoteRepository(tryGit(root, ['remote', 'get-url', 'origin']), { optional });
}
