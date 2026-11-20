/** Count the node children this process starts while a piece of work runs, so a test file launches and imports no process module itself [C7,U149]. */
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

/**
 * Run `work` and count the spawnSync calls that start this node binary.
 * Why: the cockpit fixture starts the CLI with spawnSync(process.execPath, ...), so the count is the number of CLI launches.
 *
 * @param {() => Promise<unknown>} work - The awaited piece of work to watch.
 * @returns {Promise<number>} How many node children it started.
 */
export async function nodeLaunches(work) {
  const real = childProcess.spawnSync;
  let launched = 0;
  childProcess.spawnSync = function counted(command, ...rest) {
    if (command === process.execPath) launched += 1;
    return real.call(this, command, ...rest);
  };
  syncBuiltinESMExports();
  try { await work(); } finally {
    childProcess.spawnSync = real;
    syncBuiltinESMExports();
  }
  return launched;
}
