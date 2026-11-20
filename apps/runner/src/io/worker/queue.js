/** Queue mode: a runner agent runs the worker from a job folder, so the source pack comes from a file, not stdin [C7,#5467]. */
import { assertTransportLive } from './process.js';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
import { environmentAdapter } from '../../../../../packages/env/index.js';
import { join } from 'node:path';
import { isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';

const fs = fileSystemAdapter();

/** Name of the environment value the runner agent sets to the job folder it claimed. */
export const QUEUE_JOB_ENV = 'PULLBOARD_QUEUE_JOB';

/**
 * Return the claimed job folder, or null when the worker was launched the old way (spec and pack on stdin).
 * Why: the folder is a runner-private path from the agent, so a relative or empty value is refused, never guessed.
 */
export function queueJobFolder(env) {
  const folder = environmentAdapter(env).get(QUEUE_JOB_ENV);
  if (folder === undefined || folder === '') return null;
  if (!isAbsolute(folder)) throw new Error('queue job folder is invalid');
  return folder;
}

/** A named refusal: the code is what the receipt and the board read, the message ends with the next step. */
function refusal(code, message) { return Object.assign(new Error(message), { code }); }

/** Longest the worker holds the source-cache pin waiting for the coordinator's pack. */
export const SOURCE_PACK_WAIT_MS = 600_000;

/**
 * Copy the job's source.pack into the worker's pack file once source.pack.ready exists; false when not in queue mode.
 * Why: the pack is built after the worker's NEED line reaches the coordinator, so the worker waits for the ready marker
 * (the upload is whole by then) and a lost transport (SIGTERM from cancel or an expired wanted file) ends the wait.
 * The wait is bounded too: the worker holds the repo source-cache pin meanwhile, and 11 Nov on runner .51 an orphan held it for
 * an hour after its job folder vanished while every other job queued behind it [#5624].
 */
export async function receiveQueuedPack(S, packFile, { env, pollMs = 100, limitMs = SOURCE_PACK_WAIT_MS, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const folder = queueJobFolder(env);
  if (folder === null) return false;
  const deadline = now() + limitMs;
  while (!fs.exists(join(folder, 'source.pack.ready'))) {
    assertTransportLive(S);
    // A vanished job folder means the agent already finished this job; no pack can ever arrive, and the wait held the pin [#5624].
    if (!fs.exists(folder)) throw refusal('SOURCE_PACK_ORPHANED', 'the runner job folder is gone, so no source pack can arrive; resubmit the run');
    if (now() >= deadline) throw refusal('SOURCE_PACK_TIMEOUT', `no source pack arrived within ${Math.round(limitMs / 1000)} s; the repo source-cache pin is released, rerun the job`);
    await wait(pollMs);
  }
  assertTransportLive(S);
  await pipeline(fs.createReadStream(join(folder, 'source.pack')), fs.createWriteStream(packFile, { mode: 0o600, flags: 'wx' }));
  return true;
}
