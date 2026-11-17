/** GitHub origin discovery without loading relay transport [C7,H16]. */
import { tryGit } from '../../../../git/light.js';
import { withProjectGitTimeout } from '../../../../git/light.js';
import { remoteRepository } from './remote.js';

/** Resolve the actual GitHub origin; optional discovery leaves ineligible local projects alone. */
export function originRepository(root, { optional = false } = {}) {
  return withProjectGitTimeout(root, () => remoteRepository(tryGit(root, ['remote', 'get-url', 'origin']), { optional }));
}
