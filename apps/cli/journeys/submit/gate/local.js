/** In-process runs of the real CLI for the submit gate journeys, on the shared gate fixture's repositories [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCliInProcess } from '../../../tests/fixtures/process.js';
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
