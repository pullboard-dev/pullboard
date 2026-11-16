/** A private copy of the shipped package without the folders no runner fixture reads [C7]. */
import { copyPackageFiles } from '../../index.js';
import { packageFiles } from '../../index.js';

/** Folders no fixture worker reads (gate/data stays: the worker closure reads its baselines and listings, and a later one would leave the copy): docs, skills, the two apps the runner never loads, and the archived board history. */
const NOT_NEEDED = /^(?:docs|skills|apps\/view|apps\/relay|packages\/state\/data|packages\/codemap\/data)\//u;

/**
 * Copy the shipped package into a private directory, minus the folders a fixture never reads.
 * Why: every copy, commit and worker round trip handles this whole tree, and the full 41 MB package made the fleet case
 * spend about 25 s a trip; the rest is the same bytes the runner runs.
 *
 * @param {string} source - The package source directory.
 * @param {string} destination - A private directory outside the source.
 * @returns {string[]} The copied paths relative to the destination.
 */
export function copyRunnerPackage(source, destination) {
  return copyPackageFiles(source, destination, { files: packageFiles(source).filter(file => !NOT_NEEDED.test(file)) });
}
