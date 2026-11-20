/**
 * The machine's background relay sender (#1013): one per machine, serving every local-first board on it. For each
 * board a command nudged, and every few seconds while it runs, it sends the queued moves and pulls other machines'
 * moves under that board's relay lock, then runs the person's waiting requests. Commands never wait on it. It exits
 * once no board has been nudged for a while and no move waits; a failure backs off and is kept in its short log.
 *
 * The CLI-owned entry supplies its board service to runRelaySender.
 */
import { environmentAdapter } from '../../../../env/index.js';
import { fileSystemAdapter } from '../../../../fs/index.js';
import { join } from 'node:path';
import { withFileLock } from './guard.js';
import {
  outboxParkedOnly,
  outboxWaiting,
} from '../relay.js';
import {
  recordSenderEngine,
  senderFiles,
  senderHolding,
} from '../../../../link/index.js';
const fileSystem = fileSystemAdapter();

/** The environment this file reads, through the one adapter [C7]. */
const environment = environmentAdapter();

const files = senderFiles();
// Budget: a board is pulled this often while the sender runs, so another machine's move shows here within seconds.
const PULL_MS = Number(environment.get('PULLBOARD_RELAY_SENDER_PULL_MS')) || 3_000;
// Budget: the sender stays this long after the last nudge, so a working session keeps one warm sender.
const IDLE_MS = Number(environment.get('PULLBOARD_RELAY_SENDER_IDLE_MS')) || 60_000;
// Budget: a failing board is retried no more often than this at worst, and once a second at best.
const BACKOFF_MAX_MS = 30_000;
const TICK_MS = 100;
// Budget: keep the live claim fresh independently of a pass awaiting many bounded network requests.
const HEARTBEAT_MS = 5_000;

/** Keep a short record of each pass beside the claim; status and a person debugging read it. */
const io = {
  say(line) { io.err(line); },
  err(line) {
    try { fileSystem.appendFile(files.log, `${new Date().toISOString()} ${String(line).trim()}\n`, { mode: 0o600 }); } catch { /* No log is no worse than none. */ }
  },
};

/** Read every board note: the board's checkout, its link file, and when a command last nudged it. */
function notes() {
  let names = [];
  try { names = fileSystem.list(files.boards).filter((name) => name.endsWith('.json')); } catch { return []; }
  return names.flatMap((name) => {
    try {
      const note = JSON.parse(fileSystem.readFile(join(files.boards, name), 'utf8'));
      return typeof note.root === 'string' && typeof note.file === 'string' && Number.isFinite(note.due) ? [{ ...note, path: join(files.boards, name) }] : [];
    } catch { return []; }
  });
}

/**
 * Claim the machine's sender place. The decision is made under a lock, so two senders started together cannot
 * both take it: the second sees the first's live claim and exits.
 */
async function claim() {
  fileSystem.mkdir(files.directory, { recursive: true, mode: 0o700 });
  return withFileLock(join(files.directory, 'claim.sqlite'), () => {
    const holder = senderHolding();
    if (holder && holder !== process.pid) return false;
    recordSenderEngine(process.pid); // Before the claim, so no reader sees this claim without its engine (#7938).
    fileSystem.writeFile(files.pid, `${process.pid}\n`, { mode: 0o600 });
    fileSystem.rm(files.starting, { force: true }); // Started: the next nudge sees this claim instead.
    fileSystem.writeFile(files.log, '', { mode: 0o600 }); // Each sender keeps only its own short story.
    io.say(`claimed by ${process.pid}`);
    return true;
  });
}

/** Refresh only this process's claim under the same lock used by claim and release, never a successor's marker. */
async function refreshClaim() {
  await withFileLock(join(files.directory, 'claim.sqlite'), () => {
    let holder;
    try { holder = Number(fileSystem.readFile(files.pid, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (holder === process.pid) fileSystem.utimes(files.pid, new Date(), new Date());
  });
}

/** Pulse through asynchronous serve waits; stop and drain the last pulse before the claim can be released. */
function startHeartbeat() {
  let pending = null;
  const timer = setInterval(() => {
    if (pending) return;
    pending = refreshClaim().catch(error => io.err(`claim heartbeat failed: ${error.message}`)).finally(() => { pending = null; });
  }, HEARTBEAT_MS);
  timer.unref();
  /** No pulse may touch a later claim after this worker releases its own. */
  return async () => { clearInterval(timer); if (pending) await pending; };
}

/** Give up the claim, only while it is still this process's own. */
async function release() {
  await withFileLock(join(files.directory, 'claim.sqlite'), () => {
    try { if (Number(fileSystem.readFile(files.pid, 'utf8')) === process.pid) fileSystem.rm(files.pid, { force: true }); } catch { /* Already gone. */ }
  });
}

/** Per board: when it was last served, and when a failing board may be tried again. */
const boards = new Map();

/**
 * Serve boards until none has been nudged for the idle period and no move waits; returns the newest nudge seen.
 * A board is served when a command nudged it since its last pass, or once the pull period has passed.
 */
async function serveUntilIdle(serve) {
  let newest = 0;
  for (;;) {
    const now = Date.now();
    const seen = notes();
    let waiting = false;
    for (const note of seen) {
      newest = Math.max(newest, note.due);
      if (!fileSystem.exists(note.file)) { fileSystem.rm(note.path, { force: true }); continue; }
      const board = boards.get(note.file) ?? { served: 0, failures: 0, retryAt: 0 };
      boards.set(note.file, board);
      const nudged = note.due > board.served;
      if (now < board.retryAt || !(nudged || now - board.served >= PULL_MS)) { waiting ||= outboxWaiting(note.file) && !outboxParkedOnly(note.file); continue; }
      board.served = Date.now();
      let settled = false;
      io.say(`serving ${note.root}`);
      try { settled = await serve(note.root, note.file, io); }
      catch (error) { io.err(`${note.root}: ${error.message}`); }
      io.say(`served in ${Date.now() - board.served} ms${settled ? '' : '; moves still wait'}`);
      if (settled) { board.failures = 0; board.retryAt = 0; }
      else {
        board.failures += 1;
        board.retryAt = Date.now() + Math.min(BACKOFF_MAX_MS, 1000 * 2 ** Math.min(board.failures - 1, 5));
        waiting ||= !outboxParkedOnly(note.file);
      }
    }
    if (!waiting && Date.now() - newest >= IDLE_MS) return newest;
    await new Promise((next) => setTimeout(next, TICK_MS));
  }
}

/** Run the durable sender loop with its caller's actual board/CLI service [H21,H16]. */
export async function runRelaySender({ serve }) {
  if (typeof serve !== 'function') throw new TypeError('runRelaySender requires the board service');
  // A nudge after the last look, but before the claim was released, saw a live sender and started none: look once
  // more after releasing, and go again if a newer one came.
  for (let newest = -1; await claim();) {
    const stopHeartbeat = startHeartbeat();
    try { newest = await serveUntilIdle(serve); }
    catch (error) { io.err(`sender stopped: ${error.message}`); newest = Infinity; }
    finally { await stopHeartbeat(); await release(); }
    if (!notes().some((note) => note.due > newest)) break;
  }
}
