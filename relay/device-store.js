/** Durable account-scoped opaque device wraps and expiring enrollment transport [H5,H15,H17]. */
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Refused } from '../src/refused.js';

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
        CREATE TABLE IF NOT EXISTS enrollment (account TEXT NOT NULL, locator TEXT NOT NULL, expires INTEGER NOT NULL, payload TEXT, PRIMARY KEY(account,locator));`);
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
  return {
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
