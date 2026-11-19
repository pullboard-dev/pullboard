/** Durable account-scoped opaque device wraps and expiring enrollment transport [H5,H15,H17]. */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Refused } from '../../../../../packages/kernel/index.js';
import { approvalContext } from '../../../../../packages/link/index.js';
import { createPersonEnrollmentStore } from './enrollment.js';
import {
  createExcludedStore,
  createExcludedTables,
} from './excluded.js';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
const fs = fileSystemAdapter();

/** Keep device revocations durable so an in-flight native wrap cannot recreate deleted grants; onRevoke(account, id) runs once the revocation commits, so a push subscription ends with its pairing. */
export function createDeviceStore({ directory, now = Date.now, onRevoke = () => {} }) {
  const file = join(directory, 'devices.sqlite');
  let db;
  /** Open device storage only when used, preserving legacy pairing and unauthorized no-write paths. */
  function database() {
    if (db) return db;
    const opened = new DatabaseSync(file);
    try {
      fs.chmod(file, 0o600);
      opened.exec(`PRAGMA busy_timeout=30000;
        CREATE TABLE IF NOT EXISTS device (account TEXT NOT NULL, id TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(account,id));
        CREATE TABLE IF NOT EXISTS device_session (account TEXT NOT NULL, session TEXT NOT NULL, device TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(account,session,device));
        CREATE TABLE IF NOT EXISTS wrapped_key (account TEXT NOT NULL, device TEXT NOT NULL, board TEXT NOT NULL, engine INTEGER NOT NULL, wrapped TEXT NOT NULL, PRIMARY KEY(account,device,board));
        CREATE TABLE IF NOT EXISTS enrollment (account TEXT NOT NULL, locator TEXT NOT NULL, expires INTEGER NOT NULL, payload TEXT, PRIMARY KEY(account,locator));
        CREATE TABLE IF NOT EXISTS person_enrollment (
          account TEXT NOT NULL, nonce TEXT NOT NULL, device TEXT NOT NULL, expires INTEGER NOT NULL,
          payload TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, wrapped TEXT,
          PRIMARY KEY(account,nonce));
        CREATE TABLE IF NOT EXISTS phone_approval (id TEXT PRIMARY KEY, account TEXT NOT NULL, publisher TEXT NOT NULL,
          board TEXT NOT NULL, device TEXT NOT NULL, action TEXT NOT NULL, machine TEXT NOT NULL, expires INTEGER NOT NULL,
          context TEXT NOT NULL, sealed TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'waiting', response TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS phone_approval_pending ON phone_approval(account,board,action) WHERE state='waiting';`);
      // The phone's last contact lets its owner see from the linked computer whether it still reads the boards.
      if (!opened.prepare('PRAGMA table_info(device)').all().some(column => column.name === 'seen')) opened.exec('ALTER TABLE device ADD COLUMN seen INTEGER');
      createExcludedTables(opened);
      db = opened;
      return db;
    } catch (error) { opened.close(); throw error; }
  }
  /** Require an active account device for reads and writes alike. */
  function active(account, id) {
    const row = database().prepare('SELECT revoked FROM device WHERE account=? AND id=?').get(account, id);
    if (row?.revoked) throw new Refused('DEVICE_REVOKED', 'This browser was removed from the board. Sign in again and get a fresh pairing link from a linked Mac.');
    if (!row) throw new Refused('DEVICE_NOT_ENROLLED', 'Pair this device from the linked Mac before receiving wrapped board keys.');
  }
  /** Require a live enrollment without renewing its lifetime through subsequent contacts. */
  function pending(account, locator) {
    database().prepare('DELETE FROM enrollment WHERE expires<=?').run(now());
    const row = database().prepare('SELECT * FROM enrollment WHERE account=? AND locator=?').get(account, locator);
    if (!row) throw new Refused('DEVICE_PAIR_EXPIRED', 'Run pullboard relay on --all for a fresh one-time pairing link.');
    return row;
  }
  /** Record a phone read as its last contact, at most once a minute. */
  function touch(account, id) {
    database().prepare('UPDATE device SET seen=? WHERE account=? AND id=? AND (seen IS NULL OR seen<?)').run(now(), account, id, now() - 60_000);
  }
  /** Keep expired approval metadata visible without renewing it or silently asking the phone again. */
  function expireApprovals() {
    database().prepare("UPDATE phone_approval SET state='expired', response=NULL WHERE expires<=? AND state IN ('waiting','approved')").run(now());
  }
  /** Return public immutable context and opaque envelopes, never a plaintext credential. */
  function approval(row) {
    return row ? { context: JSON.parse(row.context), sealed: row.sealed, state: row.state, response: row.response } : null;
  }
  return {
    person: createPersonEnrollmentStore({ database, now }),
    exclusions: createExcludedStore({ database, active }),
    /** Bind the public session id that actually uploaded enrollment, never its bearer credential. */
    bindSession(principal, device, { enrollment = false } = {}) {
      if (principal.kind !== 'session') return;
      if (!enrollment && !database().prepare('SELECT 1 FROM device WHERE account=? AND id=?').get(principal.user.id, device)) return;
      database().prepare('DELETE FROM device_session WHERE expires<=?').run(now());
      database().prepare('INSERT OR IGNORE INTO device_session VALUES(?,?,?,?)')
        .run(principal.user.id, principal.id, device, principal.expires);
    },
    /** Whether this session was bound to an enrolled device, so a browser with cleared storage can be told its pairing was lost. */
    knownSession(principal) {
      if (principal.kind !== "session" || !db && !fs.exists(file)) return false;
      return Boolean(database().prepare("SELECT 1 FROM device_session WHERE account=? AND session=? AND expires>?").get(principal.user.id, principal.id, now()));
    },
    /** A revoked phone cannot reuse its original session to bypass device routes and fetch ciphertext. */
    authorizeSession(principal) {
      if (principal.kind !== 'session' || !db && !fs.exists(file)) return principal;
      const revoked = database().prepare(`SELECT 1 FROM device_session AS s JOIN device AS d ON d.account=s.account AND d.id=s.device
        WHERE s.account=? AND s.session=? AND s.expires>? AND d.revoked=1`).get(principal.user.id, principal.id, now());
      if (revoked) throw new Refused('DEVICE_REVOKED', 'This browser was removed from the board. Sign in again and get a fresh pairing link from a linked Mac.');
      return principal;
    },
    /** Enqueue one immutable action for this account's already enrolled phone; PM cannot approve it. */
    requestApproval(account, value, sealed) {
      const context = approvalContext(value);
      if (context.account !== account || context.expires <= now() || context.expires > now() + 630_000 ||
          typeof sealed !== 'string' || !/^[A-Za-z0-9_-]{1,32000}$/u.test(sealed)) throw new Refused('PHONE_APPROVAL_CONTEXT', 'send a bounded ten-minute sealed approval for this account');
      active(account, context.device);
      database().exec('BEGIN IMMEDIATE');
      try {
        expireApprovals();
        const existing = database().prepare('SELECT * FROM phone_approval WHERE id=?').get(context.id);
        if (existing && (existing.context !== JSON.stringify(context) || existing.sealed !== sealed)) throw new Refused('PHONE_APPROVAL_CONTEXT', 'this request id already names another action');
        const other = database().prepare("SELECT id FROM phone_approval WHERE account=? AND board=? AND action=? AND state='waiting'").get(account, context.board, context.action);
        if (other && other.id !== context.id) throw new Refused('PHONE_APPROVAL_PENDING', 'one approval for this board and action is already waiting; use it or wait for its visible expiry');
        if (!existing) database().prepare('INSERT INTO phone_approval(id,account,publisher,board,device,action,machine,expires,context,sealed) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(context.id, account, context.publisher, context.board, context.device, context.action, context.machine, context.expires, JSON.stringify(context), sealed);
        database().exec('COMMIT');
        return approval(existing ?? database().prepare('SELECT * FROM phone_approval WHERE id=?').get(context.id));
      } catch (error) { database().exec('ROLLBACK'); throw error; }
    },
    /** Read one request only within its account and, for PM callers, its exact publisher and machine. */
    approval(account, id, scope) {
      expireApprovals();
      const row = database().prepare('SELECT * FROM phone_approval WHERE account=? AND id=?').get(account, id);
      if (!row || scope && (scope.board !== row.publisher || scope.machine !== row.machine)) throw new Refused('PHONE_APPROVAL_MISSING', 'use the approval published by this machine and board');
      return approval(row);
    },
    /** List only this paired phone's account inbox; a machine never gets the account inventory. */
    approvals(account, device) {
      active(account, device);
      touch(account, device);
      expireApprovals();
      return database().prepare("SELECT * FROM phone_approval WHERE account=? AND device=? AND state='waiting' ORDER BY expires,id").all(account, device).map(approval);
    },
    /** List only the names of unexpired link requests for their signed-in account, never sealed intent. */
    pendingLinks(account) {
      expireApprovals();
      return database().prepare("SELECT context FROM phone_approval WHERE account=? AND action='link' AND state='waiting' ORDER BY expires,id")
        .all(account).map(row => ({ name: approvalContext(JSON.parse(row.context)).target }));
    },
    /** Persist only the phone-encrypted reply, rejecting expired or twice-completed approval. */
    completeApproval(account, id, response) {
      if (typeof response !== 'string' || !/^[A-Za-z0-9_-]{1,32000}$/u.test(response)) throw new Refused('PHONE_APPROVAL_CONTEXT', 'send the encrypted phone reply');
      expireApprovals();
      const result = database().prepare("UPDATE phone_approval SET response=?,state='approved' WHERE account=? AND id=? AND state='waiting' AND expires>?").run(response, account, id, now());
      if (!result.changes) throw new Refused('PHONE_APPROVAL_USED', 'this request was approved or expired; use its existing reply');
      return { recorded: true };
    },
    /** Initialize an account-owned ten-minute locator without storing its secret. */
    begin(account, locator) {
      database().prepare('DELETE FROM enrollment WHERE expires<=?').run(now());
      database().prepare('INSERT INTO enrollment(account,locator,expires) VALUES(?,?,?)').run(account, locator, now() + 600_000);
    },
    /** Carry the signed public enrollment; the native Mac authenticates its MAC independently. */
    enroll(account, locator, payload) {
      pending(account, locator);
      database().prepare('UPDATE enrollment SET payload=? WHERE account=? AND locator=?').run(JSON.stringify(payload), account, locator);
    },
    /** Return only this account's current public enrollment to its authenticated Mac. */
    enrollment(account, locator) {
      const row = pending(account, locator);
      return { enrollment: row.payload ? JSON.parse(row.payload) : null };
    },
    /** Consume the public transport after the Mac has durably accepted the device key. */
    consume(account, locator) { database().prepare('DELETE FROM enrollment WHERE account=? AND locator=?').run(account, locator); },
    /** Register a Mac-authenticated device id without allowing a revoked id to be reused. */
    register(account, id) {
      const row = database().prepare('SELECT revoked FROM device WHERE account=? AND id=?').get(account, id);
      if (row?.revoked) throw new Refused('DEVICE_REVOKED', 'Create a fresh device key and pair again.');
      database().prepare('INSERT OR IGNORE INTO device(account,id) VALUES(?,?)').run(account, id);
    },
    /** Persist opaque client ciphertext; there is no public-key lookup or decryption operation. */
    put(account, id, board, engine, wrapped) {
      active(account, id);
      database().prepare('INSERT INTO wrapped_key VALUES(?,?,?,?,?) ON CONFLICT(account,device,board) DO UPDATE SET engine=excluded.engine,wrapped=excluded.wrapped').run(account, id, board, engine, wrapped);
    },
    /** List only this account/device's opaque grants; the HTTP boundary rechecks board access. */
    wraps(account, id) {
      active(account, id);
      touch(account, id);
      return database().prepare('SELECT board,engine,wrapped FROM wrapped_key WHERE account=? AND device=? ORDER BY board').all(account, id);
    },
    /** Replace one board's wraps for this account with exactly the given device wraps, in one transaction, so a device left out of a rotated set reads none. */
    replaceBoardWraps(account, board, wraps) {
      database().exec('BEGIN IMMEDIATE');
      try {
        for (const { device } of wraps) active(account, device);
        database().prepare('DELETE FROM wrapped_key WHERE account=? AND board=?').run(account, board);
        const insert = database().prepare('INSERT INTO wrapped_key VALUES(?,?,?,?,?)');
        for (const { device, engine, wrapped } of wraps) insert.run(account, device, board, engine, wrapped);
        database().exec('COMMIT');
      } catch (error) { database().exec('ROLLBACK'); throw error; }
    },
    /** Return when a phone of this account last read its approvals or keys, and whether it was revoked; null fields for an unknown id. */
    status(account, id) {
      const row = database().prepare('SELECT seen, revoked FROM device WHERE account=? AND id=?').get(account, id);
      return row ? { seen: row.seen ?? null, revoked: row.revoked === 1 } : { seen: null, revoked: null };
    },
    /** List the phones of this account that hold this board's key, by id only: names stay on the computer that paired them. */
    boardDevices(account, board) {
      return database().prepare('SELECT d.id AS deviceId, d.seen AS seen, d.revoked AS revoked FROM wrapped_key w JOIN device d ON d.account=w.account AND d.id=w.device WHERE w.account=? AND w.board=? ORDER BY d.id')
        .all(account, board).map(row => ({ deviceId: row.deviceId, seen: row.seen ?? null, revoked: row.revoked === 1 }));
    },
    /** Tombstone first and delete grants atomically, refusing any stale in-flight upload. */
    revoke(account, id) {
      database().exec('BEGIN IMMEDIATE');
      try {
        database().prepare('INSERT INTO device(account,id,revoked) VALUES(?,?,1) ON CONFLICT(account,id) DO UPDATE SET revoked=1').run(account, id);
        database().prepare('DELETE FROM wrapped_key WHERE account=? AND device=?').run(account, id);
        database().exec('COMMIT');
      } catch (error) { database().exec('ROLLBACK'); throw error; }
      onRevoke(account, id);
    },
    /** Delete the unlinked board's grants without changing unrelated devices or boards. */
    unlink(board) { if (db || fs.exists(file)) database().prepare('DELETE FROM wrapped_key WHERE board=?').run(board); },
    /** Close the owned database before removing a private test or service directory. */
    close() { db?.close(); db = undefined; },
  };
}
