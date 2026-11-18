/** Run default test discovery in a child through the shared child-test helper, so no test file spawns `node --test` itself [V4, C7]. */
import { runChildTests } from '../../../../packages/gate/tests/fixtures/child-tests.js';

/**
 * Run `node --test` with no file arguments (default discovery) in a fixture root, importing the copied runner.
 *
 * @param {string} root - Fixture checkout the child runs in.
 * @param {string} runnerPath - Copied runner module the child imports first.
 * @returns {{status: number|null, stdout: string, stderr: string}} The child's result.
 */
export function runDiscoveryChild(root, runnerPath) {
  return runChildTests([], { cwd: root, args: ['--import', runnerPath] });
}
