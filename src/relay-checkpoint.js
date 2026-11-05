/**
 * The board checkpoint leaves the command path (#1014): a move sends only its own sealed event, and one background
 * publisher per board uploads the checkpoint once moves have been quiet for about a second.
 *
 * Measured 22 Oct: every command rebuilt the full presentation (all item threads and 22,618 shouts, 30.7 MB of JSON,
 * about 1 s) and re-published the sealed checkpoint (about 6.7 MB gzipped) on nearly every move, under the relay lock,
 * so moves took minutes and failed RELAY_BUSY. A burst of moves now coalesces into one upload, and the relay lock
 * keeps one upload in flight; moves during an upload are covered by the next one.
 */
import { spawn } from './windows-child-process.js';
import {
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { fileURLToPath } from 'node:url';

/** Set to 0 to publish the checkpoint inside the command, as before #1014; the test runner sets it, like the view. */
export const CHECKPOINT_BACKGROUND_ENV = 'PULLBOARD_RELAY_CHECKPOINT_BACKGROUND';
/** Overrides how long moves must be quiet before the checkpoint goes out; a test models a burst with it. */
export const CHECKPOINT_QUIET_ENV = 'PULLBOARD_RELAY_CHECKPOINT_QUIET_MS';
// Budget: a burst of moves a second apart or closer shares one checkpoint; a phone sees a move within about two seconds.
export const CHECKPOINT_QUIET_MS = 1_000;
const WORKER = fileURLToPath(new URL('./relay-checkpoint-worker.js', import.meta.url));

/**
 * Whether this process leaves the checkpoint to the background publisher.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function checkpointInBackground(env = process.env) {
  return env[CHECKPOINT_BACKGROUND_ENV] !== '0';
}

/**
 * The quiet period before a checkpoint goes out, in ms.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
export function checkpointQuietMs(env = process.env) {
  const value = Number(env[CHECKPOINT_QUIET_ENV]);
  return Number.isSafeInteger(value) && value >= 0 ? value : CHECKPOINT_QUIET_MS;
}

/**
 * The files the publisher keeps beside the relay link: when the last move happened, which move the last upload
 * covered, when a command last asked for a presentation check, when the last checkpoint was read, and which
 * process publishes.
 *
 * @param {string} file - The relay link file.
 * @returns {{ due: string, done: string, asked: string, checked: string, pid: string, log: string }}
 */
export function checkpointFiles(file) {
  const directory = dirname(file);
  return { due: join(directory, 'relay-checkpoint.due'), done: join(directory, 'relay-checkpoint.done'),
    asked: join(directory, 'relay-checkpoint.asked'), checked: join(directory, 'relay-checkpoint.checked'),
    pid: join(directory, 'relay-checkpoint.pid'), log: join(directory, 'relay-checkpoint.log') };
}

// Budget: a publisher refreshes its claim on every pass, far more often than this; an older claim belongs to a
// process that died and whose number may since have been reused.
const CLAIM_STALE_MS = 600_000;

/**
 * The live publisher holding a board's claim, or 0: a claim counts only while its process lives and it was
 * refreshed recently, so a reused process number never keeps the board without a publisher.
 *
 * @param {string} pidFile
 * @returns {number}
 */
export function publisherHolding(pidFile) {
  try {
    if (Date.now() - statSync(pidFile).mtimeMs > CLAIM_STALE_MS) return 0;
    const holder = Number(readFileSync(pidFile, 'utf8'));
    return alive(holder) ? holder : 0;
  } catch { return 0; }
}

/** Whether a process is alive; a process another user owns still is. */
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

/**
 * Note a move and make sure one publisher will upload the checkpoint once moves go quiet. Never waits and never
 * builds the checkpoint: a running publisher sees the new time and waits again, so a burst shares one upload.
 *
 * @param {string} root
 * @param {string} file - The relay link file.
 */
export function scheduleCheckpoint(root, file) {
  notePublisher(root, file, 'due');
}

/**
 * Ask the publisher to read the board once things are quiet and upload only if the presentation changed. A spec,
 * doctrine or config edit changes the phone's page without any move, and a command cannot afford to build the
 * presentation to find out, so every synced command asks and the publisher compares in the background.
 *
 * @param {string} root
 * @param {string} file - The relay link file.
 */
export function requestCheckpointCheck(root, file) {
  notePublisher(root, file, 'asked');
}

/** Note the time in one of the publisher's files and start a publisher unless a live one holds the board. */
function notePublisher(root, file, marker) {
  const files = checkpointFiles(file);
  const { pid } = files;
  writeFileSync(files[marker], `${Date.now()}\n`, { mode: 0o600 });
  if (publisherHolding(pid)) return;
  const child = spawn(process.execPath, [WORKER, root, file], { cwd: root, detached: true, stdio: 'ignore', env: process.env });
  child.unref();
}
