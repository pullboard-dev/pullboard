/** Private, clock-controlled relay expiry and consistent SQLite backups, without opening seals [H18]. */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  join,
  resolve,
} from 'node:path';
import { Refused } from '../../../../packages/kernel/index.js';
import { SEALED_SNAPSHOT_BYTES } from '../../../../packages/link/index.js';
import { createRelayJournal } from './journal.js';
import { fileSystemAdapter } from '../../../../packages/fs/index.js';
const fs = fileSystemAdapter();

const DAY = 86_400_000;
const WARN = 60 * DAY;
const EXPIRE = 90 * DAY;
const KEEP = 14 * DAY;
const BACKUP = /^([0-9a-f]{32})\.(\d+)\.sqlite$/;
const PENDING = /^([0-9a-f]{32})\.(\d+)\.[0-9a-f-]{36}\.pending$/;

/** Only persistent board ids can derive storage or backup filenames. */
function identity(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) throw new Refused('BAD_BOARD', 'use the persistent board id');
  return id;
}

/** Refuse unexpected file types and public permissions; never follow a managed symlink. */
function regular(file) {
  let stat;
  try { stat = fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Refused('RELAY_STORAGE', 'restore relay files as private regular files');
  return true;
}

/** Create/check a private directory without accepting a substituted symlink. */
function privateDirectory(directory) {
  fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Refused('RELAY_STORAGE', 'use a private relay directory with mode 700');
}

/** Keep lifecycle mutations in the host's trusted process; this is never an unauthenticated HTTP API. */
export function createRelayRetention({ directory, backupsDirectory = directory + '-backups', auth, now = Date.now, onDelete = () => {} }) {
  if (typeof directory !== 'string' || !directory.trim() || typeof backupsDirectory !== 'string' ||
      !backupsDirectory.trim() || typeof now !== 'function' || typeof onDelete !== 'function' || !auth?.linkedBoards || !auth?.forgetBoard || !auth?.withBoard || !auth?.pendingCleanup || !auth?.finishCleanup || !auth?.withCleanup) {
    throw new Refused('RELAY_CONFIG', 'configure private relay storage, authentication and a retention clock');
  }
  const root = resolve(directory);
  const backups = resolve(backupsDirectory);
  if (root === backups) throw new Refused('RELAY_CONFIG', 'keep backups in a separate private directory');
  privateDirectory(root);
  let lastBackupDay = null;

  /** Require a usable clock before changing files, expiry or backup retention. */
  function time() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) {
      throw new Refused('RELAY_CLOCK', 'configure a valid nonnegative millisecond clock before maintenance');
    }
    return value;
  }

  /** Existing managed backup names, with validated regular files; unrelated files remain untouched. */
  function backupFiles() {
    try {
      const stat = fs.lstat(backups);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Refused('RELAY_STORAGE', 'restore the private backup directory');
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return fs.list(backups).flatMap((name) => {
      const match = BACKUP.exec(name) ?? PENDING.exec(name);
      if (!match) return [];
      if (!Number.isSafeInteger(Number(match[2]))) throw new Refused('RELAY_STORAGE', 'restore backup filenames with valid creation times');
      const file = join(backups, name);
      regular(file);
      return [{ board: match[1], createdAt: Number(match[2]), file, name }];
    });
  }

  /** Last append, or original link time before the first move; snapshots do not reset inactivity. */
  function lastActivity(link) {
    const file = join(root, identity(link.id) + '.journal.sqlite');
    if (!regular(file)) {
      if (!Number.isSafeInteger(link.linkedAt) || link.linkedAt < 0) throw new Refused('RELAY_CLOCK', 'restore a valid link time before retention maintenance');
      return link.linkedAt;
    }
    const journal = createRelayJournal({ directory: root, boardId: link.id, maxBytes: SEALED_SNAPSHOT_BYTES });
    try {
      const activity = journal.activity();
      const at = activity === null ? link.linkedAt : Date.parse(activity);
      if (!Number.isSafeInteger(at) || at < 0) throw new Refused('RELAY_CLOCK', 'restore a valid last-activity time before retention maintenance');
      return at;
    } finally { journal.close(); }
  }

  /** A next-contact warning carries only public board identity and an actionable deadline. */
  function notice(id) {
    let activity;
    try { activity = auth.withBoard(identity(id), lastActivity); }
    catch (error) { if (error.code === 'BOARD_NOT_LINKED') return null; throw error; }
    const age = time() - activity;
    if (age < WARN) return null;
    return { board: id, code: 'BOARD_INACTIVE', inactiveDays: Math.floor(age / DAY),
      daysLeft: Math.max(0, Math.ceil((EXPIRE - age) / DAY)),
      deletesAt: new Date(activity + EXPIRE).toISOString(),
      message: 'This linked board is inactive and will be deleted after 90 days without new board activity.',
      next: 'Make a board move before the deadline, or unlink; the local board stays complete.' };
  }

  /** Validate all managed paths before any deletion, leaving unrelated files untouched. */
  function affected(id) {
    identity(id);
    const files = ['', '-wal', '-shm'].map((suffix) => join(root, id + '.journal.sqlite' + suffix)).filter(regular);
    return [...files, ...backupFiles().filter((entry) => entry.board === id).map((entry) => entry.file)];
  }

  /** Finish a durable unlink intent; a crash or I/O failure leaves it eligible for retry. */
  function cleanup(id) {
    auth.withCleanup(id, () => {
      const files = affected(id);
      for (const file of files) {
        try { fs.unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const result = onDelete(id);
      if (result && typeof result.then === 'function') throw new Refused('RELAY_CONFIG', 'Finish relay cleanup notices synchronously before completing deletion.');
      auth.finishCleanup(id);
    });
  }

  /** Revoke access and commit unlink intent before purging files, so crashes cannot revive a board. */
  function unlink(id) {
    auth.withBoard(identity(id), () => { affected(id); auth.forgetBoard(id); });
    cleanup(id);
    return { deleted: id };
  }

  /** Decide inactivity under the same cross-process lock used by every service journal operation. */
  function expire(id) {
    identity(id);
    let expired;
    try {
      expired = auth.withBoard(id, (link) => {
        if (time() - lastActivity(link) < EXPIRE) return false;
        affected(id); auth.forgetBoard(id); return true;
      });
    } catch (error) { if (error.code === 'BOARD_NOT_LINKED') return false; throw error; }
    if (expired) cleanup(id);
    return expired;
  }

  /** Retry unfinished purges, then sweep valid persistent board identities. */
  function sweep() {
    time();
    for (const id of auth.pendingCleanup()) if (/^[0-9a-f]{32}$/.test(id)) cleanup(id);
    return auth.linkedBoards().filter((link) => /^[0-9a-f]{32}$/.test(link.id) && expire(link.id)).map((link) => link.id);
  }

  /** Prune only our dated backups/partial outputs, strictly older than fourteen days. */
  function prune() {
    const cutoff = time() - KEEP;
    const expired = backupFiles().filter((entry) => entry.createdAt < cutoff);
    for (const entry of expired) fs.unlink(entry.file);
    return expired.map((entry) => entry.name);
  }

  /**
   * VACUUM INTO makes a consistent, compact logical SQLite snapshot even with WAL present.
   * Publish a completed private file without overwriting another job's result.
   */
  function backup() {
    const at = time();
    sweep();
    const written = [];
    for (const link of auth.linkedBoards()) {
      if (!/^[0-9a-f]{32}$/.test(link.id)) continue;
      try { auth.withBoard(link.id, () => {
        const source = join(root, link.id + '.journal.sqlite');
        if (!regular(source)) return;
        privateDirectory(backups);
        const name = link.id + '.' + at + '.sqlite';
        const target = join(backups, name);
        if (regular(target)) return;
        const pending = join(backups, link.id + '.' + at + '.' + randomUUID() + '.pending');
        fs.close(fs.open(pending, 'wx', 0o600));
        let db;
        try {
          db = new DatabaseSync(source, { readOnly: true });
          db.prepare('VACUUM INTO ?').run(pending);
          db.close(); db = null;
          try { fs.link(pending, target); written.push(name); }
          catch (error) { if (error.code !== 'EEXIST' || !regular(target)) throw error; }
        } finally {
          db?.close();
          fs.unlink(pending);
        }
      }); } catch (error) { if (error.code !== 'BOARD_NOT_LINKED') throw error; }
    }
    return { written, removed: prune() };
  }

  /** Run expiry each tick and backups once per UTC day; errors leave the next tick able to retry. */
  function maintain() {
    const at = time();
    const deleted = sweep();
    const day = Math.floor(at / DAY);
    let copied = { written: [], removed: prune() };
    if (day !== lastBackupDay) { copied = backup(); lastBackupDay = day; }
    return { deleted, ...copied };
  }

  return { notice, unlink, expire, sweep, prune, backup, maintain, directory: root, backupsDirectory: backups };
}
