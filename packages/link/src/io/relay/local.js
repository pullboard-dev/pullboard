/**
 * Local first (#1013, H21): on a linked board whose relay.outbox is on, the local board is the source of truth and
 * the relay is a mailbox. A move applies here and returns at once; a read never syncs or takes a lock. One
 * background sender per machine pushes the queued moves and pulls other machines' moves, for every board on it.
 */
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
import { pullboardHome } from '../../../../store/index.js';
import { ENGINE_VERSION } from '../../../../state/light.js';

/** Set to 0 to send inside each command instead, as before #1013; the test runner sets it, like the view. */
export const SENDER_BACKGROUND_ENV = 'PULLBOARD_RELAY_SENDER_BACKGROUND';

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
 * @returns {{ directory: string, pid: string, log: string, boards: string, starting: string, engine: string }}
 */
export function senderFiles() {
  const directory = join(pullboardHome(), 'relay-sender');
  return { directory, pid: join(directory, 'sender.pid'), log: join(directory, 'sender.log'), boards: join(directory, 'boards'),
    starting: join(directory, 'sender.starting'), engine: join(directory, 'sender.engine') };
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

/**
 * Record the engine this sender runs, before its claim, so a later pullboard can tell a sender it outgrew (#7938).
 * Why: a sender from before an upgrade replays the new engine's moves with old code and refuses each one
 * ENGINE_VERSION, and while moves wait it never goes idle, so it would hold the machine's place forever.
 *
 * @param {number} pid - The claiming sender's process.
 */
export function recordSenderEngine(pid) {
  writeFileSync(senderFiles().engine, `${pid} ${ENGINE_VERSION}\n`, { mode: 0o600 });
}

/**
 * The live sender that an older pullboard started, or null: its claim has no engine record (0.9.3 wrote none), or
 * one for another process, or an engine older than this pullboard's.
 *
 * @returns {{ pid: number, engine: number | null, current: number } | null}
 */
export function outdatedSender() {
  const pid = senderHolding();
  if (!pid) return null;
  let engine = null;
  try {
    const [owner, version] = readFileSync(senderFiles().engine, 'utf8').trim().split(' ').map(Number);
    if (owner === pid && Number.isSafeInteger(version)) engine = version;
  } catch { /* No record: a sender from before records were kept. */ }
  return engine !== null && engine >= ENGINE_VERSION ? null : { pid, engine, current: ENGINE_VERSION };
}

/** One line naming an outdated sender, for doctor and relay recover. */
export function outdatedSenderLine(outdated) {
  return `the relay sender (process ${outdated.pid}) was started by an older pullboard (${outdated.engine === null ? 'no engine recorded' : `engine ${outdated.engine}`}; this one is engine ${outdated.current}), so it refuses this version's moves and the outbox waits`;
}

/**
 * Stop a sender an older pullboard started and give up its claim, so this version's sender takes the machine's
 * place. Returns the stopped sender, or null when the running one is current.
 */
export function stopOutdatedSender() {
  const outdated = outdatedSender();
  if (!outdated) return null;
  try { process.kill(outdated.pid, 'SIGTERM'); } catch { /* Already gone. */ }
  // The claim is freed now, not when the old process gets round to exiting; it never removes a successor's claim.
  try { if (Number(readFileSync(senderFiles().pid, 'utf8')) === outdated.pid) rmSync(senderFiles().pid, { force: true }); } catch { /* Gone. */ }
  rmSync(senderFiles().starting, { force: true });
  return outdated;
}

/**
 * Replace an outdated sender with this version's (#7938): stop it, then start a sender that serves every board it
 * was serving. Returns the stopped sender, or null when nothing needed replacing.
 *
 * @param {string} root - A board checkout to start the new sender in.
 * @param {(root: string, env: NodeJS.ProcessEnv) => void} launchSender
 */
export function replaceOutdatedSender(root, launchSender) {
  const stopped = stopOutdatedSender();
  if (stopped && typeof launchSender === 'function' && senderInBackground() && !senderHolding() && startingSender()) {
    const env = { ...process.env };
    delete env.PULLBOARD_RELAY_TOKEN;
    launchSender(root, env);
  }
  return stopped;
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
export function nudgeRelaySender(root, file, launchSender) {
  if (!senderInBackground()) return;
  try {
    const note = boardNote(file);
    mkdirSync(senderFiles().boards, { recursive: true, mode: 0o700 });
    const temporary = `${note}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ root, file, due: Date.now() }) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temporary, note);
    } finally { rmSync(temporary, { force: true }); }
    stopOutdatedSender(); // A sender from before an upgrade refuses every new move; this version's takes over.
    if (senderHolding() || !startingSender()) return;
    const env = { ...process.env };
    delete env.PULLBOARD_RELAY_TOKEN; // The sender works only with this machine's own saved credentials.
    launchSender(root, env);
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

/**
 * The link a move may queue on and return at once (#1013), or null when it must reach the relay first: the board's
 * relay.outbox is on and the relay accepted its baseline, and the move needs no relay answer to exist (a
 * registration mints its token there, a takeover needs the relay's sign-in lineage, a person's request is the
 * phone's, and landing authority needs real order). Environment-token sessions always wait: ephemeral jobs
 * cannot retain queued moves after they exit.
 */
export function localFirstLink(file, operation, args, io, { loadLink, acknowledgedOperations, senderPolicy }) {
  let state;
  try { state = loadLink(file); } catch { return null; }
  if (!state || state.unlinking || state.recovery || state.mode !== 'ordered' || state.baselineAccepted !== true
    || state.baselineConflict || state.baselinePause || state.baselineStale || state.environment) return null;
  if (process.env.PULLBOARD_RELAY_TOKEN !== undefined || io?.relayCanary || io?.personRequest || io?.personRequestMoveId) return null;
  // A takeover needs the relay's authenticated sign-in lineage, which only the relay's order carries.
  if (acknowledgedOperations.includes(operation) || args?.[0]?.landingFence !== undefined) return null;
  if (senderPolicy.credentialActor({ operation, args }) === 'person') return null;
  try { if (io?.relayOutbox?.() !== true) return null; } catch { return null; }
  if (senderInBackground() && typeof io.launchRelaySender !== 'function') throw new TypeError('local-first relay requires the sender launch port');
  return state;
}
