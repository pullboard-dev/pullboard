/** In-process runs of the real CLI for the submit gate journeys, on the shared gate fixture's repositories [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { failingParts } from '../../../../../packages/api/index.js';
import { runCliInProcess } from '../../../tests/fixtures/process.js';
import { settleSubmit } from '../../../tests/fixtures/submit/settle.js';
import { stopFixtureLocalRunner } from '../../../tests/fixtures/runner/local-stop.js';
import {
  commitAll,
  put,
  withBrief,
} from '../../../tests/fixtures/submit/gate.js';

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

/** Copy the real module graph in bounded commits while retaining every installed hook and secret scan. */
export function copyRepositoryFixture(box, repository, tracked) {
  // New-file diffs add one prefix per line and small path headers. Leave half the real scan limit free.
  const batchBytes = 4 * 1024 * 1024;
  let stagedBytes = 0;
  let pending = false;
  let head;
  for (const path of tracked) {
    const source = readFileSync(join(repository, path), 'utf8');
    const estimate = Buffer.byteLength(source) + source.split('\n').length + 512 + 2 * Buffer.byteLength(path);
    assert.ok(estimate <= batchBytes, `one copied module exceeds the fixture batch limit: ${path}`);
    if (pending && stagedBytes + estimate > batchBytes) {
      head = commitAll(box); stagedBytes = 0; pending = false;
    }
    put(box.root, path, source);
    stagedBytes += estimate; pending = true;
  }
  return pending ? commitAll(box) : head;
}

/**
 * Submit item 1 as the fixture's builder and wait for its pulled gate, answering in the shape an inline submit once printed:
 * code 1 when the gate came back red, with the board's failing parts (the builder's own shout text) and the gate job's receipt in `err`.
 * Why: a pulled submit queues its gate and returns at once; the verdict (a red gate, a sandbox refusal) is the runner's receipt [C7,P7].
 *
 * @param {import('node:test').TestContext} t
 * @param {{ root: string, env: object, dir: string }} box - A fixture box from privateRepo or builderRepo.
 * @param {Function} run - (...args) => { code, out, err } or a promise of it: the box's own sync run or runLocal.
 * @param {string[]} [extra] - Further submit flags, such as --infra with its reason.
 * @param {{ unknownSettles?: boolean }} [settle] - Settle options: unknownSettles ends the wait at the board's recorded "unknown" verdict.
 * @returns {Promise<{ code: number, out: string, err: string, gateJob: object | null, receipt?: object }>} receipt is the queued submit's document with the settled `gate` and `gateJob`.
 */
export async function submitSettled(t, box, run, extra = [], settle = undefined) {
  t.after(() => { stopFixtureLocalRunner(box.env.PULLBOARD_MACHINE_HOME); });
  const submitted = await run('submit', '1', '--json', ...extra);
  if (submitted.code !== 0) return { ...submitted, gateJob: null };
  const settled = await settleSubmit(t, { repo: box.root, env: box.env, run: (_cwd, ...args) => run(...args) }, JSON.parse(submitted.out), settle);
  return { code: settled.gate?.green === true ? 0 : 1, out: submitted.out, err: `${settled.gate?.green === true ? '' : failingParts({ status: 1, gate: settled.gate }).join('\n')}\n${JSON.stringify(settled.gateJob)}`, gateJob: settled.gateJob, receipt: settled };
}

/**
 * submitSettled for a journey that sets environment variables its gate reads after the fixture was built.
 * Why: a local runner keeps the environment it started with, so the submit's runner is stopped first and starts again with this one [C7,V10,#7530].
 * A runner stopped mid-job hands it back and the next runner runs it again, so a journey settles its jobs first (add --check --wait).
 */
export function submitWithEnv(t, box, run, extra = []) {
  stopFixtureLocalRunner(box.env.PULLBOARD_MACHINE_HOME);
  return submitSettled(t, box, run, extra);
}
