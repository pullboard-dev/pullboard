/** Queue mode: a runner agent runs the worker from a job folder, so the source pack comes from a file, not stdin [C7,#5467]. */
import { assertTransportLive } from './process.js';
import { createReadStream } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';

/** Name of the environment value the runner agent sets to the job folder it claimed. */
export const QUEUE_JOB_ENV = 'PULLBOARD_QUEUE_JOB';

/**
 * Return the claimed job folder, or null when the worker was launched the old way (spec and pack on stdin).
 * Why: the folder is a runner-private path from the agent, so a relative or empty value is refused, never guessed.
 */
export function queueJobFolder(env = process.env) {
  const folder = env[QUEUE_JOB_ENV];
  if (folder === undefined || folder === '') return null;
  if (!isAbsolute(folder)) throw new Error('queue job folder is invalid');
  return folder;
}

/**
 * Copy the job's source.pack into the worker's pack file once source.pack.ready exists; false when not in queue mode.
 * Why: the pack is built after the worker's NEED line reaches the coordinator, so the worker waits for the ready marker
 * (the upload is whole by then) and a lost transport (SIGTERM from cancel or an expired wanted file) ends the wait.
 */
export async function receiveQueuedPack(S, packFile, { env = process.env, pollMs = 100, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const folder = queueJobFolder(env);
  if (folder === null) return false;
  while (!existsSync(join(folder, 'source.pack.ready'))) {
    assertTransportLive(S);
    await wait(pollMs);
  }
  assertTransportLive(S);
  await pipeline(createReadStream(join(folder, 'source.pack')), createWriteStream(packFile, { mode: 0o600, flags: 'wx' }));
  return true;
}
