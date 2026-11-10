/** Account-scoped opaque excluded-board lists; only machine labels and counts are public [H5,H17]. */
import { createHash } from 'node:crypto';
import { Refused } from '../../../../../packages/kernel/index.js';

/** Bind one machine's encrypted inventory to a stable, non-path transport identifier. */
export function excludedInventoryId(machine, account) {
  return createHash('sha256').update('pullboard-exclusions-v1:' + account + ':' + machine).digest('hex').slice(0, 32);
}

/** Install the opaque inventory schema whenever its existing device database is opened [H5,H17]. */
export function createExcludedTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS excluded_inventory (
      account TEXT NOT NULL, machine TEXT NOT NULL, label TEXT NOT NULL, count INTEGER NOT NULL,
      engine INTEGER NOT NULL, sealed TEXT NOT NULL, PRIMARY KEY(account,machine));
      CREATE TABLE IF NOT EXISTS excluded_inventory_wrap (
      account TEXT NOT NULL, machine TEXT NOT NULL, device TEXT NOT NULL, wrapped TEXT NOT NULL,
      PRIMARY KEY(account,machine,device));`);
}

/** Keep names sealed and disclose a wrap only after checking that account's active device. */
export function createExcludedStore({ database, active }) {
  return {
    /** Replace one exact machine publication atomically; inclusion clears the last stale entry. */
    publish(account, value) {
      if (!value || Object.keys(value).sort().join(',') !== 'count,engine,label,machine,sealed,wraps'
          || !/^[A-Za-z0-9_.-]{1,128}$/u.test(value.machine ?? '')
          || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 80
          || /[\u0000-\u001f\u007f]/u.test(value.label)
          || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > 256
          || !Number.isSafeInteger(value.engine) || value.engine < 1
          || typeof value.sealed !== 'string' || !Array.isArray(value.wraps) || value.wraps.length > 100
          || (value.count === 0 ? value.sealed !== '' || value.wraps.length !== 0
            : !/^[A-Za-z0-9_-]{39,131072}$/u.test(value.sealed))) {
        throw new Refused('EXCLUDED_INVENTORY', 'Publish a bounded sealed excluded-board list with a machine label and count.');
      }
      const ids = new Set();
      for (const wrap of value.wraps) {
        if (!wrap || Object.keys(wrap).sort().join(',') !== 'device,wrapped'
            || !/^device-[0-9a-f]{32}$/u.test(wrap.device ?? '')
            || typeof wrap.wrapped !== 'string' || !/^[A-Za-z0-9_-]{1,6000}$/u.test(wrap.wrapped)
            || ids.has(wrap.device)) throw new Refused('EXCLUDED_INVENTORY', 'Wrap this list once for each enrolled device.');
        ids.add(wrap.device);
        active(account, wrap.device);
      }
      const db = database();
      db.exec('BEGIN IMMEDIATE');
      try {
        // Recheck under the write transaction: a concurrent revocation must win before publication.
        for (const wrap of value.wraps) active(account, wrap.device);
        db.prepare('DELETE FROM excluded_inventory_wrap WHERE account=? AND machine=?').run(account, value.machine);
        db.prepare('DELETE FROM excluded_inventory WHERE account=? AND machine=?').run(account, value.machine);
        if (value.count) {
          db.prepare('INSERT INTO excluded_inventory VALUES(?,?,?,?,?,?)')
            .run(account, value.machine, value.label, value.count, value.engine, value.sealed);
          const insert = db.prepare('INSERT INTO excluded_inventory_wrap VALUES(?,?,?,?)');
          for (const wrap of value.wraps) insert.run(account, value.machine, wrap.device, wrap.wrapped);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return { recorded: true };
    },
    /** A signed-in browser without a key learns only this account's machine labels and counts. */
    metadata(account) {
      return database().prepare('SELECT machine,label,count FROM excluded_inventory WHERE account=? ORDER BY machine').all(account);
    },
    /** Never return another device's wrap, including to a freshly signed-in revoked browser. */
    forDevice(account, device) {
      active(account, device);
      return database().prepare(`SELECT i.machine,i.label,i.count,i.engine,i.sealed,w.wrapped
        FROM excluded_inventory AS i JOIN excluded_inventory_wrap AS w
        ON w.account=i.account AND w.machine=i.machine WHERE i.account=? AND w.device=? ORDER BY i.machine`)
        .all(account, device).map(row => ({ ...row, id: excludedInventoryId(row.machine, account) }));
    },
  };
}
