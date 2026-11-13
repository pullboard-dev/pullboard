/** The served-board child the restart journey starts, kept out of the test file so the test launches nothing itself [C7]. */
import { spawn } from 'node:child_process';

/**
 * Start `node <script> <argument>` in `cwd` with output shared with the test run.
 *
 * @param {string} script - The server entry file.
 * @param {string} argument - The one JSON argument the entry reads.
 * @param {string} cwd - The folder the child runs in.
 * @returns {import('node:child_process').ChildProcess}
 */
export function startServedNode(script, argument, cwd) {
  return spawn(process.execPath, [script, argument], { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
}
