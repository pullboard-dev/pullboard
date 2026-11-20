import { beginCommandPhase } from '../command.js';
/** The per-board link lock: one worktree sends at a time, and a sibling waits instead of failing (#919). */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  dirname,
  join,
} from 'node:path';
import { Refused } from '../../../../kernel/light.js';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fs = fileSystemAdapter();

/** Longest wait for a sibling worktree's relay send, and how often the waiting command says so. */
const LOCK_WAIT_MS = 120000;
const LOCK_PROGRESS_MS = 10000;
// Budget: a lock with no readable owner this long after it was made belongs to a command that died making it.
const UNOWNED_STALE_MS = 30000;

/** The lock's owner, or null when it names none yet (its maker is between creating it and writing its pid). */
function ownerOf(lock) {
  const pid = Number(fs.readFile(join(lock, 'pid'), 'utf8'));
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Whether a process has exited; one another user owns, or one we cannot signal, still counts as alive. */
function gone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

/**
 * The lease that decides which command holds a board's relay lock (#1119). Taking it is one SQLite write
 * transaction that checks the holder and replaces it only when that holder's process is gone, so of any number of
 * waiters exactly one holds it, and a live holder is never displaced: there is no separate removal step to race.
 */
function openLease(file, timeoutMs = 10000) {
  const db = new DatabaseSync(`${file}.lease.sqlite`);
  db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.min(10000, Math.floor(timeoutMs)))};
    CREATE TABLE IF NOT EXISTS relay_lease(name TEXT PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL);`);
  return db;
}

/** Take the lease for this process when it is free or its holder has died; true when this process holds it. */
function takeLease(db, token) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const holder = db.prepare("SELECT pid, token FROM relay_lease WHERE name = 'relay'").get();
    const free = !holder || holder.token === token || gone(holder.pid);
    if (free) db.prepare("INSERT OR REPLACE INTO relay_lease(name, pid, token) VALUES ('relay', ?, ?)").run(process.pid, token);
    db.exec('COMMIT');
    return free;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Give the lease up, only while it is still this process's own. */
function releaseLease(db, token) {
  db.prepare("DELETE FROM relay_lease WHERE name = 'relay' AND token = ?").run(token);
}

/**
 * Take the directory lock older pullboard versions still use, as the lease holder. Only the lease holder clears a
 * dead owner's directory, so no two current commands race on it.
 *
 * @returns {boolean} Whether this process now holds the directory lock too.
 */
function takeDirectory(lock) {
  try { fs.mkdir(lock, { mode: 0o700 }); fs.writeFile(join(lock, 'pid'), String(process.pid)); return true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  let owner = null;
  try { owner = ownerOf(lock); }
  catch (error) {
    // No pid file: either the lock is gone, or its maker died between creating it and naming itself, which the
    // age check below recovers.
    if (error.code !== 'ENOENT') owner = null;
    else {
      try { fs.lstat(lock); } catch (missing) { if (missing.code === 'ENOENT') return false; throw missing; }
    }
  }
  let stale;
  try { stale = owner !== null ? gone(owner) : Date.now() - fs.lstat(lock).mtimeMs > UNOWNED_STALE_MS; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (stale) fs.rm(lock, { recursive: true, force: true });
  return false;
}

/**
 * Wait for another worktree's upload, recovering a lock only when its owner is gone.
 * Why: one large baseline PUT can hold the lock past any short limit, and a board move that gave up
 * after 15 s failed for a reason the person cannot fix (#919); the wait is up to 2 minutes with a progress line.
 */
export async function locked(file, work, io) {
  const finishWait = beginCommandPhase('waiting-lock');
  try {
    const lock = file + '.lock';
    /** A caller deadline stops waiting without displacing or signaling another lock holder. */
    const checkAbort = () => {
      if (io?.relaySignal?.aborted) throw new Refused('RELAY_TIMEOUT', 'the relay deadline expired; this waiter did not take over another sender');
    };
    checkAbort();
    fs.mkdir(dirname(file), { recursive: true });
    const startedAt = Date.now();
    const deadline = startedAt + (io?.relayLockWaitMs ?? LOCK_WAIT_MS);
    const progressEvery = io?.relayLockProgressMs ?? LOCK_PROGRESS_MS;
    let nextProgress = startedAt + progressEvery;
    const lease = openLease(file, io?.relaySignal ? deadline - Date.now() : 10000);
    const token = randomUUID();
    try {
      while (true) {
        checkAbort();
        if (takeLease(lease, token) && takeDirectory(lock)) break;
        if (Date.now() >= deadline) throw new Refused('RELAY_BUSY', `another worktree was still sending this board after ${Math.round((Date.now() - startedAt) / 1000)} s; this attempt was not recorded; run the command again`);
        if (io?.err && Date.now() >= nextProgress) {
          nextProgress = Date.now() + progressEvery;
          io.err(`pullboard: waiting for another worktree to finish sending this board (${Math.round((Date.now() - startedAt) / 1000)} s of ${Math.round((deadline - startedAt) / 1000)} s)`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      finishWait();
      try {
        checkAbort();
        // Only the current lock holder can have a live link write; remove crashed legacy bearer fragments.
        for (const name of fs.list(dirname(file))) {
          if (/^relay\.json\.[0-9a-f-]+\.tmp$/u.test(name)) fs.rm(join(dirname(file), name), { force: true });
        }
        return await work();
      } finally {
        // Remove only this command's own directory lock; another's is never ours to free.
        let owner = null;
        try { owner = ownerOf(lock); } catch { /* Already gone, or never named: nothing of ours to keep. */ }
        if (owner === process.pid) fs.rm(lock, { recursive: true, force: true });
      }
    } finally {
      releaseLease(lease, token);
      lease.close();
    }
  } finally { finishWait(); }
}
