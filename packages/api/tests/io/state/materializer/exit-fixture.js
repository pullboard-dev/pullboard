/** The one seam that starts a node process for the materializer's exit test; not a test file, so it is no CLI launch row [C7]. */
import { spawn } from 'node:child_process';

/**
 * Run a module source in a fresh node process and resolve with the time it printed `closing`, or 0 if it never did.
 * Why: the exit time of a whole process, not a thread, is what the clause measures; the child is killed after `killAfterMs`
 * so a regression fails the test instead of hanging it.
 *
 * @param {string} source - Module source for the child; it prints `closing` when it calls close().
 * @param {number} killAfterMs - Kill the child this long after the start.
 * @returns {Promise<number>} Epoch ms of the print, resolved after the child exits.
 */
export function runUntilExit(source, killAfterMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, NODE_TEST_CONTEXT: '' } });
    let closedAt = 0;
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('closing')) closedAt = Date.now(); });
    const killer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
    child.once('exit', () => { clearTimeout(killer); resolve(closedAt); });
  });
}
