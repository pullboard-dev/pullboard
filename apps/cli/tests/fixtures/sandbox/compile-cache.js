/**
 * One Node compile cache that every sandbox of a journey file names in NODE_COMPILE_CACHE [C7,#10415].
 * Why: each sandbox has its own machine home, and the CLI keeps its compile cache there, so every sandbox compiled the
 * whole CLI again in each real process: its CLI calls, its local runner and that runner's gate and land jobs. One shared
 * folder lets every process after the first start warm (a tour on a loaded runner: 108 s cold, 63-75 s warm).
 */
import { rmSync } from 'node:fs';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';

/**
 * Make one private compile-cache folder, readable and writable by this user only, as the CLI requires of a cache folder.
 *
 * @returns {{ folder: string, remove: () => void }} The folder, and a removal for the file's cleanup.
 */
export function sharedCompileCache() {
  const folder = privateFixtureFiles('pullboard-compile-cache-').root;
  return { folder, remove: () => rmSync(folder, { recursive: true, force: true }) };
}
