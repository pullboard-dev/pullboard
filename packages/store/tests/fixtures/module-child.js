/** The child process the file write queue's cross-process cases start, kept out of the test file so the test launches nothing itself [C7,#8163]. */
import { spawn } from 'node:child_process';

/**
 * Run `source` as module code in a node child process, with `args` as its argv, and resolve with its exit code.
 *
 * @param {string} source - Module code to run.
 * @param {...string} args - Arguments the code reads from process.argv.
 * @returns {Promise<number | null>} The child's exit code.
 */
export function runModuleChild(source, ...args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', source, ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    proc.on('error', reject);
    proc.on('exit', code => resolve(code));
  });
}
