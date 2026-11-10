/**
 * The outbox guard (#1013): a short local lock around the relay outbox and the board changes it stands for. A move
 * holds it while it queues and applies itself; the background sender holds it only while it rebuilds the board from
 * what the relay ordered. Neither holds it across a network call, so a move never waits on the relay.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  mkdirSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  dirname,
  join,
} from 'node:path';

// Budget: the guard is held only for local SQLite work (queue one move, or rebuild a board); a minute covers the
// largest board's rebuild with room, and a holder that died releases its lock with its process.
const GUARD_WAIT_MS = 60_000;

/** Only the active asynchronous owner may reenter its own guard; detached descendants lose that authority. */
const OWNERS = new AsyncLocalStorage();

/** Same-process contenders wait asynchronously, so none blocks the event loop needed by the current owner. */
const WAITING = new Map();

/** The guard file beside a relay link file. */
export function outboxGuardFile(linkFile) {
  return join(dirname(linkFile), 'relay-outbox.guard.sqlite');
}

/**
 * Run `work` holding the board's outbox guard, waiting while another process holds it.
 *
 * @template T
 * @param {string} linkFile - The board's relay link file.
 * @param {() => Promise<T> | T} work
 * @returns {Promise<T>}
 */
export function withOutboxGuard(linkFile, work) {
  return withFileLock(outboxGuardFile(linkFile), work);
}

/**
 * Run `work` holding an exclusive SQLite lock on `file`, waiting while another process holds it.
 * Why: SQLite's exclusive lock is released by the operating system when its holder dies, so a crashed command or
 * sender never leaves a board stuck; and it needs no polling, so a waiter starts the moment the holder finishes.
 *
 * @template T
 * @param {string} file
 * @param {() => Promise<T> | T} work
 * @returns {Promise<T>}
 */
export async function withFileLock(file, work) {
  if (OWNERS.getStore()?.get(file)?.active) return work();
  const previous = WAITING.get(file);
  let release;
  const finished = new Promise(resolve => { release = resolve; });
  WAITING.set(file, finished);
  try {
    if (previous) await previous;
    return await ownFileLock(file, work);
  } finally {
    release();
    if (WAITING.get(file) === finished) WAITING.delete(file);
  }
}

/** Hold the actual cross-process SQLite lock for one active asynchronous operation and its genuine nested work. */
async function ownFileLock(file, work) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  const owner = { active: true };
  try {
    db.exec(`PRAGMA busy_timeout = ${GUARD_WAIT_MS}`);
    db.exec('BEGIN EXCLUSIVE');
    const context = new Map(OWNERS.getStore() ?? []);
    context.set(file, owner);
    return await OWNERS.run(context, work);
  } finally {
    owner.active = false;
    try { db.exec('COMMIT'); } catch { /* Nothing was written; closing releases the lock either way. */ }
    db.close();
  }
}
