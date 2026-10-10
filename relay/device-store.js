/** Durable account-scoped opaque device wraps and expiring enrollment transport [H5,H15,H17]. */
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Refused } from '../src/refused.js';
import { approvalContext } from '../src/relay-approval.js';

/** Keep device revocations durable so an in-flight native wrap cannot recreate deleted grants. */
export function createDeviceStore({ directory, now = Date.now }) {
  const file = join(directory, 'devices.sqlite');
  let db;
  /** Open device storage only when used, preserving legacy pairing and unauthorized no-write paths. */
  function database() {
    if (db) return db;
    const opened = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
      opened.exec(`PRAGMA busy_timeout=30000;
        CREATE TABLE IF NOT EXISTS device (account TEXT NOT NULL, id TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(account,id));
        CREATE TABLE IF NOT EXISTS wrapped_key (account TEXT NOT NULL, device TEXT NOT NULL, board TEXT NOT NULL, engine INTEGER NOT NULL, wrapped TEXT NOT NULL, PRIMARY KEY(account,device,board));
        CREATE TABLE IF NOT EXISTS enrollment (account TEXT NOT NULL, locator TEXT NOT NULL, expires INTEGER NOT NULL, payload TEXT, PRIMARY KEY(account,locator));
        CREATE TABLE IF NOT EXISTS phone_approval (id TEXT PRIMARY KEY, account TEXT NOT NULL, publisher TEXT NOT NULL,
          board TEXT NOT NULL, device TEXT NOT NULL, action TEXT NOT NULL, machine TEXT NOT NULL, expires INTEGER NOT NULL,
          context TEXT NOT NULL, sealed TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'waiting', response TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS phone_approval_pending ON phone_approval(account,board,action) WHERE state='waiting';`);
      db = opened;
      return db;
    } catch (error) { opened.close(); throw error; }
  }
  /** Require an active account device for reads and writes alike. */
  function active(account, id) {
    if (!database().prepare('SELECT 1 FROM device WHERE account=? AND id=? AND revoked=0').get(account, id)) {
      throw new Refused('DEVICE_NOT_ENROLLED', 'Pair this device from the linked Mac before receiving wrapped board keys.');
    }
  }
  /** Require a live enrollment without renewing its lifetime through subsequent contacts. */
  function pending(account, locator) {
    database().prepare('DELETE FROM enrollment WHERE expires<=?').run(now());
    const row = database().prepare('SELECT * FROM enrollment WHERE account=? AND locator=?').get(account, locator);
    if (!row) throw new Refused('DEVICE_PAIR_EXPIRED', 'Run pullboard relay on --all for a fresh one-time pairing link.');
    return row;
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
      expireApprovals();
      return database().prepare("SELECT * FROM phone_approval WHERE account=? AND device=? AND state='waiting' ORDER BY expires,id").all(account, device).map(approval);
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
      return database().prepare('SELECT board,engine,wrapped FROM wrapped_key WHERE account=? AND device=? ORDER BY board').all(account, id);
    },
    /** Tombstone first and delete grants atomically, refusing any stale in-flight upload. */
    revoke(account, id) {
      database().exec('BEGIN IMMEDIATE');
      try {
        database().prepare('INSERT INTO device VALUES(?,?,1) ON CONFLICT(account,id) DO UPDATE SET revoked=1').run(account, id);
        database().prepare('DELETE FROM wrapped_key WHERE account=? AND device=?').run(account, id);
        database().exec('COMMIT');
      } catch (error) { database().exec('ROLLBACK'); throw error; }
    },
    /** Delete the unlinked board's grants without changing unrelated devices or boards. */
    unlink(board) { if (db || existsSync(file)) database().prepare('DELETE FROM wrapped_key WHERE board=?').run(board); },
    /** Close the owned database before removing a private test or service directory. */
    close() { db?.close(); db = undefined; },
  };
}
