/** Put a job on a pull-mode runner, send it a source pack, and read back its files; one multiplexed ssh each [5465,5468]. */
import { statSync } from 'node:fs';
import { enqueueScript } from './scripts.js';
import { fetchScript } from './scripts.js';
import { packScript } from './scripts.js';
import { runRunnerScript } from './ssh.js';

/** A refusal-shaped error carrying the script's own words, so callers can name the next step. */
function scriptFailure(what, run) {
  const detail = run.error ?? (run.stderr.trim().split('\n').at(-1) || `status ${run.status}`);
  return Object.assign(new Error(`${what}: ${detail}`), { code: 'RUNNER_PULL_SCRIPT', status: run.status, transport: run.error !== null || run.status === 255 });
}

/**
 * Queue one job: its row and its frame become `queue/<id>` on the runner, whole or not at all.
 * @param {{ host: string, root?: string }} runner The runner record.
 * @param {{ id: string, row: object, frame: Buffer, command?: string, agent?: string }} job The row.json fields (a version, the id and
 *   `enqueuedAt` are added), the stdin frame, the remote command the agent runs, and an optional agent-start snippet.
 * @param {object} [options] `ssh`, `env`, `dir` and `timeoutMs` for the ssh call.
 * @returns {Promise<void>} Settles when the runner has the row; rejects with `RUNNER_PULL_SCRIPT`.
 */
export async function enqueueRunnerJob(runner, { id, row, frame, command, agent }, options = {}) {
  const line = JSON.stringify({ version: 1, id, enqueuedAt: Date.now(), ...row });
  const run = await runRunnerScript(runner, enqueueScript(runner, { id, frameBytes: frame.length, command, agent }),
    { ...options, stdin: Buffer.concat([Buffer.from(`${line}\n`), frame]) });
  if (run.status !== 0 || run.error) throw scriptFailure(`could not queue job ${id} on ${runner.host}`, run);
}

/**
 * Upload a job's source pack from a local file; the worker's wait for `source.pack.ready` ends when this settles.
 * @param {{ host: string, root?: string }} runner The runner record.
 * @param {{ id: string, file: string }} pack The job id and the pack file.
 * @param {object} [options] `ssh`, `env`, `dir` and `timeoutMs` for the ssh call.
 * @returns {Promise<void>} Settles when the pack is in place and marked ready.
 */
export async function uploadRunnerPack(runner, { id, file }, options = {}) {
  const run = await runRunnerScript(runner, packScript(runner, { id, bytes: statSync(file).size }),
    { timeoutMs: 600_000, ...options, stdin: { file } });
  if (run.status !== 0 || run.error) throw scriptFailure(`could not send the source pack for ${id} to ${runner.host}`, run);
}

/**
 * Read one file of a job back from the runner.
 * @param {{ host: string, root?: string }} runner The runner record.
 * @param {{ id: string, name: 'out.bin'|'control.log'|'exit'|'row.json', tailBytes?: number }} file Which file; `tailBytes` keeps only its end.
 * @param {object} [options] `ssh`, `env`, `dir` and `timeoutMs` for the ssh call.
 * @returns {Promise<Buffer>} The bytes; rejects with `RUNNER_PULL_SCRIPT` (status 4 when the file does not exist).
 */
export async function fetchRunnerFile(runner, file, options = {}) {
  const run = await runRunnerScript(runner, fetchScript(runner, file), { timeoutMs: 300_000, ...options });
  if (run.status !== 0 || run.error) throw scriptFailure(`could not read ${file.name} of ${file.id} on ${runner.host}`, run);
  return run.stdout;
}
