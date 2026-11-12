/** In-process runs of the real CLI for the submit gate journeys, on the shared gate fixture's repositories [C7]. */
import { join } from 'node:path';
import { runCliInProcess } from '../../../tests/fixtures/process.js';
import { withBrief } from '../../../tests/fixtures/submit/gate.js';

/**
 * Run one CLI command in this process as the fixture box's builder, with the answer shape of `box.run`.
 * Why: a node start-up per call is most of a journey's time; hooks, signals and the gate's own children stay processes.
 *
 * @param {object} box - A fixture box from privateRepo or builderRepo.
 * @param {...string} rawArgs - The command and its flags.
 * @returns {Promise<{code: number, out: string, err: string, failure: null}>}
 */
export async function runLocal(box, ...rawArgs) {
  const result = await runCliInProcess(withBrief(...rawArgs), { cwd: box.root, env: box.env });
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '', failure: null };
}

/**
 * Run one CLI command in this process from the project's main checkout, as the fixture's coordinator.
 * Why: a builder box has moved its root to its own worktree; the coordinator still works in the main one.
 *
 * @param {object} box - A fixture box from builderRepo.
 * @param {...string} args - The command and its flags.
 * @returns {Promise<{code: number, out: string, err: string, failure: null}>}
 */
export function coordinatorLocal(box, ...args) {
  return runLocal({ ...box, root: join(box.dir, 'repo') }, ...args);
}
