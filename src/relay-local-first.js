/**
 * Local first (#1013, H21): on a linked board whose relay.outbox is on, the local board is the source of truth and
 * the relay is a mailbox. A move applies here and returns at once; a read never syncs or takes a lock. One
 * background sender per machine pushes the queued moves and pulls other machines' moves, for every board on it.
 */
import { spawn } from './windows-child-process.js';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pullboardHome } from './local-state.js';

/** Set to 0 to send inside each command instead, as before #1013; the test runner sets it, like the view. */
export const SENDER_BACKGROUND_ENV = 'PULLBOARD_RELAY_SENDER_BACKGROUND';
/** The machine sender's entry file, which every sender process runs. */
export const SENDER_WORKER = fileURLToPath(new URL('./relay-sender-worker.js', import.meta.url));

/**
 * Whether this process leaves sending to the machine's background sender.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function senderInBackground(env = process.env) {
  return env[SENDER_BACKGROUND_ENV] !== '0';
}

/**
 * The machine sender's files: its claim, its short log, one note per board it serves, and the marker of a sender
 * being started.
 *
 * @returns {{ directory: string, pid: string, log: string, boards: string, starting: string }}
 */
export function senderFiles() {
  const directory = join(pullboardHome(), 'relay-sender');
  return { directory, pid: join(directory, 'sender.pid'), log: join(directory, 'sender.log'), boards: join(directory, 'boards'),
    starting: join(directory, 'sender.starting') };
}

// Budget: a sender refreshes its claim every few seconds while it runs; a claim this old belongs to a process that
// died, whose number may since have been reused.
export const SENDER_CLAIM_STALE_MS = 120_000;

/** Whether a process is alive; one another user owns still is. */
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

/**
 * The live sender holding this machine's claim, or 0.
 *
 * @returns {number}
 */
export function senderHolding() {
  const { pid } = senderFiles();
  try {
    if (Date.now() - statSync(pid).mtimeMs > SENDER_CLAIM_STALE_MS) return 0;
    const holder = Number(readFileSync(pid, 'utf8'));
    return alive(holder) ? holder : 0;
  } catch { return 0; }
}

// Budget: a sender starts and claims its place well within this; an older start marker belongs to one that died.
const STARTING_STALE_MS = 10_000;

/**
 * Mark that a sender is starting, so the several nudges of one burst of commands start one sender, not one each.
 * True when this caller should start it.
 */
function startingSender() {
  const marker = senderFiles().starting;
  mkdirSync(senderFiles().directory, { recursive: true, mode: 0o700 });
  try { writeFileSync(marker, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); return true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  try { if (Date.now() - statSync(marker).mtimeMs < STARTING_STALE_MS) return false; } catch { /* Gone: start one. */ }
  rmSync(marker, { force: true });
  try { writeFileSync(marker, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); return true; } catch { return false; }
}

/** The note a board keeps in the sender's folder, named by its link file. */
export function boardNote(file) {
  return join(senderFiles().boards, createHash('sha256').update(file).digest('hex').slice(0, 32) + '.json');
}

/**
 * Tell the machine's sender that a board has work, and start the sender unless a live one runs. Never waits and
 * never touches the network: the command that calls it returns at once.
 *
 * @param {string} root - The board's checkout.
 * @param {string} file - The board's relay link file.
 */
export function nudgeRelaySender(root, file) {
  if (!senderInBackground()) return;
  try {
    const note = boardNote(file);
    mkdirSync(senderFiles().boards, { recursive: true, mode: 0o700 });
    const temporary = `${note}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ root, file, due: Date.now() }) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temporary, note);
    } finally { rmSync(temporary, { force: true }); }
    if (senderHolding() || !startingSender()) return;
    const env = { ...process.env };
    delete env.PULLBOARD_RELAY_TOKEN; // The sender works only with this machine's own saved credentials.
    const child = spawn(process.execPath, [SENDER_WORKER], { cwd: root, detached: true, stdio: 'ignore', env });
    child.unref();
  } catch { /* A board the sender misses now is served by the next command's nudge; the move is already saved. */ }
}

/**
 * Whether the board at this checkout is local first: linked in order, its baseline accepted, its relay.outbox on,
 * and no environment token in this shell. Reads two small local files and the committed setting, nothing more.
 *
 * @param {string} file - The board's relay link file.
 * @param {() => boolean} outboxSetting - Reads the board's committed relay.outbox setting.
 * @returns {boolean}
 */
export function localFirstBoard(file, outboxSetting) {
  if (process.env.PULLBOARD_RELAY_TOKEN !== undefined || !existsSync(file)) return false;
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { return false; }
  if (!state || state.unlinking || state.recovery || state.mode !== 'ordered' || state.baselineAccepted !== true
    || state.baselineConflict || state.environment) return false;
  try { return outboxSetting() === true; } catch { return false; }
}
