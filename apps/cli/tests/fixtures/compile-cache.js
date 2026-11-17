/** Run `pullboard help` in a fresh node process against a private machine home, for the compile-cache test [C7]. */
import { fileURLToPath } from 'node:url';
import { runFixtureChild } from './child.js';

const ENTRY = fileURLToPath(new URL('../../pullboard.js', import.meta.url));

/**
 * One real CLI start-up with its machine home set to `home`.
 *
 * Why: a cross-run cache needs a fresh process, and one fixture holds the spawn so the test file counts no launch.
 *
 * @param {string} home - The private machine home folder.
 * @returns {object} The fixture child result; `status` is the exit code.
 */
export function runHelpAt(home) {
  return runFixtureChild(process.execPath, [ENTRY, 'help'], { env: { PATH: process.env.PATH, PULLBOARD_MACHINE_HOME: home }, encoding: 'utf8' });
}

/**
 * One real CLI start-up for a version probe, with both machine homes set to `home`.
 *
 * Why: the probe test must see what the entry leaves in the home, so it needs a fresh process and an env it fully controls.
 *
 * @param {string} home - The private machine home folder.
 * @param {string[]} flags - The version flags, `['--version']` or `['--version', '--json']`.
 * @returns {object} The fixture child result; `status` is the exit code and `stdout` the printed text.
 */
export function runVersionAt(home, flags) {
  return runFixtureChild(process.execPath, [ENTRY, ...flags], { env: { PATH: process.env.PATH, PULLBOARD_MACHINE_HOME: home, PULLBOARD_HOME: home }, encoding: 'utf8' });
}
