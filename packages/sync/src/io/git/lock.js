/** Git transport leases fence expired writers without changing the generic relay lock [H11,C7]. */
import { randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  join,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Refused } from '../../../../kernel/index.js';

const LEASE_MS = 120_000;
const WAIT_MS = 120_000;
const UNOWNED_MS = 30_000;
const COLUMNS = {
  git_owner_version: 'INTEGER',
  git_started_at: 'INTEGER',
  git_expires_at: 'INTEGER',
  git_command: 'TEXT',
};

/** Only a definite missing process permits recovery of an owner without an expiry protocol. */
function dead(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

/** Health records contain operation names, never arguments, paths or credentials. */
function command(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(value) ? value : 'unknown';
}

/** Retain legacy pid-only owners as unknown-age leases, not implicitly expired writers. */
function observation(row, now = Date.now()) {
  if (!row) return { pid: null, command: null, startedAt: null, expiresAt: null, state: 'absent' };
  const versioned = row.git_owner_version === 1
    && Number.isSafeInteger(row.git_started_at) && Number.isSafeInteger(row.git_expires_at)
    && row.git_expires_at > row.git_started_at && row.git_started_at >= 0;
  const value = { pid: row.pid, command: versioned ? command(row.git_command) : null,
    startedAt: versioned ? row.git_started_at : null, expiresAt: versioned ? row.git_expires_at : null };
  if (dead(row.pid)) return { ...value, state: 'dead' };
  if (versioned && row.git_expires_at <= now) return { ...value, state: 'expired' };
  return { ...value, state: versioned ? 'live' : 'unknown' };
}

/** Read a directory's exact identity so replacing its path cannot authorize moving a new owner. */
function directoryOwner(path) {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { invalid: true, dev: stat.dev, ino: stat.ino };
  const pidFile = ownerFile(join(path, 'pid'), 32);
  const tokenFile = ownerFile(join(path, 'git-token'), 128);
  const pid = /^[1-9]\d*$/u.test(pidFile.value ?? '') && Number.isSafeInteger(Number(pidFile.value)) ? Number(pidFile.value) : null;
  const token = /^[a-f0-9-]{36}$/iu.test(tokenFile.value ?? '') ? tokenFile.value : null;
  const unsafe = pidFile.unsafe || tokenFile.unsafe || !pidFile.missing && pid === null || !tokenFile.missing && token === null;
  return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, pid, token, unsafe };
}

/** Read at most the protocol's bounded bytes from a regular, non-symlink owner file. */
function ownerFile(path, limit) {
  let fd;
  try {
    if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW <= 0) return { unsafe: true };
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) return { unsafe: true };
    const bytes = Buffer.alloc(limit + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > limit) return { unsafe: true };
    return { value: bytes.subarray(0, count).toString('utf8').trim() };
  } catch (error) {
    return error.code === 'ENOENT' ? { missing: true } : { unsafe: true };
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Compare both filesystem identity and owner bytes immediately before a directory rename. */
function sameDirectory(left, right) {
  return left && right && !left.invalid && !right.invalid && !left.unsafe && !right.unsafe && left.dev === right.dev && left.ino === right.ino
    && left.pid === right.pid && left.token === right.token && left.mtimeMs === right.mtimeMs;
}

/** Inspect existing lease metadata without creating files, migrating schema or changing ownership. */
export function inspectGitSyncLock(markerPath) {
  let directory;
  try { directory = directoryOwner(markerPath + '.lock'); }
  catch { directory = { unsafe: true }; }
  if (directory?.unsafe || directory?.invalid) return { pid: directory.pid ?? null, command: null, startedAt: null, expiresAt: null, state: 'unknown' };
  const file = markerPath + '.lease.sqlite';
  if (existsSync(file)) {
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      db.exec('PRAGMA busy_timeout=250');
      const row = db.prepare("SELECT * FROM relay_lease WHERE name='relay'").get();
      if (row) return observation(row);
    } catch {
      // Unreadable legacy metadata cannot grant permission to displace an owner.
      return { pid: null, command: null, startedAt: null, expiresAt: null, state: 'unknown' };
    } finally { db?.close(); }
  }
  try {
    const owner = directory;
    if (!owner) return observation(null);
    return { pid: owner.pid ?? null, command: null, startedAt: null, expiresAt: null,
      state: dead(owner.pid) ? 'dead' : 'unknown' };
  } catch {
    return { pid: null, command: null, startedAt: null, expiresAt: null, state: 'unknown' };
  }
}

/** Add only optional Git columns; legacy relay INSERT OR REPLACE continues to create legacy rows. */
function openLease(markerPath) {
  const db = new DatabaseSync(markerPath + '.lease.sqlite');
  try {
    db.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE');
    db.exec('CREATE TABLE IF NOT EXISTS relay_lease(name TEXT PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL)');
    const names = new Set(db.prepare('PRAGMA table_info(relay_lease)').all().map(row => row.name));
    for (const [name, type] of Object.entries(COLUMNS)) if (!names.has(name)) db.exec(`ALTER TABLE relay_lease ADD COLUMN ${name} ${type}`);
    db.exec('COMMIT');
    return db;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve the schema/open failure. */ }
    db.close();
    throw error;
  }
}

/** Keep stale directory bytes intact under a fixed local quarantine parent, never delete evidence. */
function quarantine(markerPath, observed, reason, owner) {
  const lock = markerPath + '.lock';
  if (!sameDirectory(observed, directoryOwner(lock))) return null;
  const folder = join(dirname(markerPath), 'quarantine');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const parent = lstatSync(folder);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Refused('GIT_SYNC_LOCK_EVIDENCE', 'the Git sync quarantine parent must be a real local directory',
      'restore its local directory without deleting the existing lock evidence');
  }
  const entry = join(folder, `git-sync-${Date.now()}-${randomUUID()}`);
  mkdirSync(entry, { mode: 0o700 });
  const name = basename(markerPath) + '.lock';
  const destination = join(entry, name);
  renameSync(lock, destination);
  const at = new Date().toISOString();
  const observedTime = owner.startedAt ?? observed.mtimeMs;
  const summary = { version: 1, at, reason, artifacts: [{ name, path: destination,
    pid: owner.pid ?? observed.pid ?? null, command: command(owner.command),
    at: Number.isFinite(observedTime) ? new Date(observedTime).toISOString() : at }] };
  writeFileSync(join(entry, 'recovery.json'), JSON.stringify(summary) + '\n', { mode: 0o600, flag: 'wx' });
  return summary;
}

/** Own a compatible SQLite lease before examining or quarantining its legacy directory lock. */
function acquire(db, markerPath, token, op) {
  db.exec('BEGIN IMMEDIATE');
  let created = null;
  try {
    const previous = db.prepare("SELECT * FROM relay_lease WHERE name='relay'").get();
    const observed = observation(previous);
    if (previous && !['dead', 'expired'].includes(observed.state)) { db.exec('COMMIT'); return null; }
    const directory = directoryOwner(markerPath + '.lock');
    let recovered = null;
    if (directory) {
      if (directory.invalid || directory.unsafe) { db.exec('COMMIT'); return null; }
      // An expired versioned row proves only its own token's directory is stale.
      const expired = observed.state === 'expired' && directory.token === previous.token && directory.pid === previous.pid;
      const exited = dead(directory.pid);
      const abandoned = !directory.pid && Date.now() - directory.mtimeMs > UNOWNED_MS;
      if (!expired && !exited && !abandoned) { db.exec('COMMIT'); return null; }
      // Current waiters serialize on this SQLite write lock. A replaced directory is left alone.
      recovered = quarantine(markerPath, directory, expired ? 'expired-lease' : exited ? 'dead-owner' : 'abandoned-unowned-directory',
        previous && directory.pid === previous.pid ? observed : { pid: directory.pid });
      if (!recovered) { db.exec('COMMIT'); return null; }
    }
    const startedAt = Date.now();
    const owner = { pid: process.pid, command: op, startedAt, expiresAt: startedAt + LEASE_MS };
    db.prepare(`INSERT OR REPLACE INTO relay_lease(name,pid,token,git_owner_version,git_started_at,git_expires_at,git_command)
      VALUES ('relay',?,?,?,?,?,?)`).run(owner.pid, token, 1, owner.startedAt, owner.expiresAt, owner.command);
    mkdirSync(markerPath + '.lock', { mode: 0o700 });
    created = directoryOwner(markerPath + '.lock');
    writeFileSync(join(markerPath + '.lock', 'pid'), String(process.pid), { mode: 0o600, flag: 'wx' });
    writeFileSync(join(markerPath + '.lock', 'git-token'), token, { mode: 0o600, flag: 'wx' });
    db.exec('COMMIT');
    return { owner, recovered };
  } catch (error) {
    // A failed owner-file write must not strand our live pid in an otherwise rolled-back acquisition.
    const current = created && directoryOwner(markerPath + '.lock');
    if (current && current.dev === created.dev && current.ino === created.ino) {
      quarantine(markerPath, current, 'incomplete-acquisition', { pid: process.pid, command: op });
    }
    db.exec('ROLLBACK');
    throw error;
  }
}

/** A token and unexpired lease authorize the next action; each explicit assertion renews the deadline. */
function assertLease(db, markerPath, token, owner) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare("SELECT * FROM relay_lease WHERE name='relay'").get();
    const directory = directoryOwner(markerPath + '.lock');
    const now = Date.now();
    if (!row || row.token !== token || row.pid !== process.pid || row.git_owner_version !== 1
      || row.git_expires_at <= now || !directory || directory.pid !== process.pid || directory.token !== token) {
      throw new Refused('GIT_SYNC_LOCK_LOST', 'the Git sync lease expired or changed owner; this writer is fenced',
        'retry the native operation; keep its pending intent and quarantine evidence');
    }
    owner.expiresAt = now + LEASE_MS;
    db.prepare("UPDATE relay_lease SET git_expires_at=? WHERE name='relay' AND token=?").run(owner.expiresAt, token);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Release only this token's lease; retain any newer owner's row and directory. */
function release(db, markerPath, token) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare("SELECT token FROM relay_lease WHERE name='relay'").get();
    const directory = directoryOwner(markerPath + '.lock');
    if (row?.token === token && directory?.pid === process.pid && directory.token === token) {
      // This is our normal completed lock, not a stale owner's evidence directory.
      if (sameDirectory(directory, directoryOwner(markerPath + '.lock'))) rmSync(markerPath + '.lock', { recursive: true });
    }
    db.prepare("DELETE FROM relay_lease WHERE name='relay' AND token=?").run(token);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Wait at most two minutes, then supply a fenced writer capability; no implicit heartbeat runs. */
export async function withGitSyncLock(markerPath, work, io = {}) {
  mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 });
  const db = openLease(markerPath);
  const token = randomUUID();
  const deadline = Date.now() + WAIT_MS;
  let acquired = false;
  let failed = false;
  try {
    while (true) {
      if (io.relaySignal?.aborted) throw new Refused('RELAY_TIMEOUT', 'the Git sync waiter stopped without displacing another owner');
      const result = acquire(db, markerPath, token, command(io.relayCommand?.cliOperation));
      if (result) {
        acquired = true;
        /** A cancelled callback cannot renew its authority even while its SQLite token remains current. */
        const assertHeld = () => {
          if (io.relaySignal?.aborted) throw new Refused('RELAY_TIMEOUT', 'the Git sync writer was cancelled; its pending intent remains');
          assertLease(db, markerPath, token, result.owner);
        };
        assertHeld();
        if (result.recovered) await io.onQuarantine?.(result.recovered);
        assertHeld();
        const owner = Object.freeze({
          /** Expose observed ownership without granting permission to replace it. */
          get pid() { return result.owner.pid; },
          /** Report only the fixed native operation name. */
          get command() { return result.owner.command; },
          /** Retain this token's actual acquisition time. */
          get startedAt() { return result.owner.startedAt; },
          /** Expose the deadline renewed only by a successful assertion. */
          get expiresAt() { return result.owner.expiresAt; },
        });
        const value = await work({ assertHeld, owner });
        assertHeld();
        return value;
      }
      if (Date.now() >= deadline) throw new Refused('GIT_SYNC_LOCK_BUSY', 'another or unknown Git sync owner still holds the lease',
        'wait for that owner to finish; do not delete its lease or directory');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const cleanup = [];
    try { if (acquired) release(db, markerPath, token); } catch (error) { cleanup.push(error); }
    try { db.close(); } catch (error) { cleanup.push(error); }
    if (cleanup.length && failed) {
      // A secondary cleanup failure cannot replace the original callback/acquisition refusal.
      try {
        const text = 'pullboard: Git sync lease cleanup failed after an earlier error; original error and lock evidence retained';
        if (io.err) io.err(text); else process.stderr.write(text + '\n');
      } catch { /* Diagnostics cannot mask the primary error either. */ }
    } else if (cleanup.length) throw cleanup[0];
  }
}
