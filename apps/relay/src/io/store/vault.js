/** Durable account-scoped vault: one opaque, bounded ciphertext per account with its root and a revision that only moves forward [H5,H15,C7]. */
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Refused } from '../../../../../packages/kernel/index.js';

/** The most ciphertext bytes one account's vault may hold; a larger write is refused, never truncated. */
export const VAULT_MAX_BYTES = 1_048_576;

/** The vault's root names the sealed content it covers: a short token, never a path or URL. */
const ROOT = /^[A-Za-z0-9_-]{1,128}$/u;

/** Keep each account's one vault row durable, so a restart never loses or rolls back the revision a client holds. */
export function createVaultStore({ directory }) {
  const file = join(directory, 'vault.sqlite');
  let db;
  /** Open vault storage only when used, so an unused relay creates no file. */
  function database() {
    if (db) return db;
    const opened = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
      opened.exec(`PRAGMA busy_timeout=30000;
        CREATE TABLE IF NOT EXISTS vault (account TEXT PRIMARY KEY, root TEXT NOT NULL, revision INTEGER NOT NULL, ciphertext BLOB NOT NULL);`);
      db = opened;
      return db;
    } catch (error) { opened.close(); throw error; }
  }
  /** The stored row for this account, or null. */
  function stored(account) {
    return database().prepare('SELECT root, revision, ciphertext FROM vault WHERE account=?').get(account) ?? null;
  }
  return {
    /** Return only this account's root, revision and ciphertext; an account that never wrote reads nothing. */
    read(account) {
      const row = stored(account);
      return row ? { root: row.root, revision: row.revision, ciphertext: Buffer.from(row.ciphertext) } : null;
    },
    /**
     * Store one ciphertext at a new revision. `expected` is the revision the writer read (0 for none yet). A retry of the
     * stored write byte for byte answers the same revision and writes nothing; a revision below the stored one is refused
     * VAULT_ROLLBACK; any other write that is not built on the stored revision is refused VAULT_CONFLICT.
     */
    write(account, { expected, revision, root, ciphertext }) {
      if (typeof account !== 'string' || !account) throw new Refused('VAULT_ACCOUNT', 'write the vault as a signed-in account');
      if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(expected) || expected < 0) throw new Refused('VAULT_REVISION', 'send whole-number revisions: expected from 0 and revision from 1');
      if (typeof root !== 'string' || !ROOT.test(root)) throw new Refused('VAULT_ROOT', 'send the vault root as a short token of letters, digits, - and _');
      if (!(ciphertext instanceof Uint8Array)) throw new Refused('VAULT_CIPHERTEXT', 'send the encrypted vault as bytes');
      if (ciphertext.byteLength > VAULT_MAX_BYTES) throw new Refused('VAULT_TOO_LARGE', `the vault holds at most ${VAULT_MAX_BYTES} encrypted bytes; send less`);
      const bytes = Buffer.from(ciphertext);
      database().exec('BEGIN IMMEDIATE');
      try {
        const row = stored(account);
        const current = row?.revision ?? 0;
        if (row && row.revision === revision && row.root === root && Buffer.from(row.ciphertext).equals(bytes)) { database().exec('COMMIT'); return { revision }; }
        if (revision < current) throw new Refused('VAULT_ROLLBACK', `the vault is at revision ${current}; a write at revision ${revision} would roll it back, so read it and build on the stored revision`);
        if (expected !== current || revision <= current) throw new Refused('VAULT_CONFLICT', `the vault is at revision ${current}, not ${expected}; read it again and write on top of the stored revision`);
        database().prepare('INSERT INTO vault(account,root,revision,ciphertext) VALUES(?,?,?,?) ON CONFLICT(account) DO UPDATE SET root=excluded.root,revision=excluded.revision,ciphertext=excluded.ciphertext')
          .run(account, root, revision, bytes);
        database().exec('COMMIT');
        return { revision };
      } catch (error) { database().exec('ROLLBACK'); throw error; }
    },
    /** Close the owned database before removing a private test or service directory. */
    close() { db?.close(); db = undefined; },
  };
}
