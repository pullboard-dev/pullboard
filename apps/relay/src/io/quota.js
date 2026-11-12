/** Account-wide logical sealed storage, checked under the same cross-process lifecycle lock as publication [H15,H17,H18]. */
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Refused } from '../../../../packages/kernel/index.js';

export const ACCOUNT_STORAGE_BYTES = 256_000_000;

/** Read only byte counts from a private relay database; never decode or return stored payloads. */
function storedBytes(file) {
  let stat;
  try { stat = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) throw new Refused('RELAY_STORAGE', 'Keep account storage in private regular relay databases.');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    let bytes = 0;
    for (const name of ['journal_record', 'journal_snapshot']) {
      if (tables.has(name)) bytes += db.prepare(`SELECT COALESCE(SUM(length(payload)),0) AS bytes FROM ${name}`).get().bytes;
    }
    if (tables.has('page_object')) bytes += db.prepare('SELECT COALESCE(SUM(length(payload)+length(children)),0) AS bytes FROM page_object').get().bytes;
    if (tables.has('board_link_delivery')) bytes += db.prepare('SELECT COALESCE(SUM(length(envelope)+length(receipt)),0) AS bytes FROM board_link_delivery').get().bytes;
    return bytes;
  } finally { db.close(); }
}

/** Count committed legacy bytes and every staged or committed opaque page for one linked board. */
export function boardStorageBytes(directory, id) {
  if (!/^[0-9a-f]{32}$/u.test(id ?? '')) throw new Refused('BAD_BOARD', 'Use a persistent board identity for storage accounting.');
  const root = resolve(directory);
  return storedBytes(join(root, id + '.journal.sqlite'));
}

/** Format the provisional operator-set account budget without printing a credential or repository path. */
export function storageLimitMessage(storage) {
  return `Account ${storage.account.login} has used ${(storage.usedBytes / 1_000_000).toFixed(1)} MB of its ${(storage.limitBytes / 1_000_000).toFixed(1)} MB relay storage limit. Remove unneeded relay copies or ask the relay operator to increase the account quota.`;
}

/** Warn before the account reaches its quota while naming exact bytes and the available next step. */
function storageWarningMessage(storage) {
  return `Account ${storage.account.login} has used ${storage.usedBytes} of ${storage.limitBytes} bytes of relay storage (over 80%). Remove unneeded relay copies or ask the relay operator to increase the account quota.`;
}

/** Enforce a net storage change while authentication's shared lifecycle transaction excludes competing board writes. */
export function createStorageQuota({ directory, auth, limitBytes = ACCOUNT_STORAGE_BYTES }) {
  if (typeof directory !== 'string' || !Number.isSafeInteger(limitBytes) || limitBytes < 1 || !auth?.withBoard) throw new Refused('RELAY_CONFIG', 'Configure a positive account storage quota and the shared relay lifecycle lock.');
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const parent = lstatSync(root);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077) throw new Refused('RELAY_STORAGE', 'Keep quota notices in private relay storage.');
  const file = join(root, 'storage-quota.sqlite');
  try { closeSync(openSync(file, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) throw new Refused('RELAY_STORAGE', 'Keep quota notices in a private regular database.');
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA busy_timeout=30000; CREATE TABLE IF NOT EXISTS storage_warning (board TEXT PRIMARY KEY, storage TEXT NOT NULL, needed INTEGER NOT NULL)'); }
  catch (error) { db.close(); throw error; }
  let closed = false;

  /** Refuse use after shutdown instead of exposing a native database error. */
  function open() { if (closed) throw new Refused('RELAY_CLOSED', 'Open relay quota storage before using it.'); }

  /** Resolve only service-derived identity and count every board charged to that account. */
  function usage(board, principal) {
    open();
    if (!auth.storageAccount || !auth.storageBoards) throw new Refused('RELAY_CONFIG', 'Upgrade the relay authentication adapter for account storage quotas.');
    const account = auth.storageAccount(board, principal?.userId);
    if (!account) return null;
    let usedBytes = 0;
    for (const id of auth.storageBoards(account.id)) {
      usedBytes += boardStorageBytes(root, id);
      if (!Number.isSafeInteger(usedBytes)) throw new Refused('RELAY_STORAGE', 'Restore storage accounting within safe byte counts.');
    }
    return { account: { id: account.id, login: account.login }, usedBytes, limitBytes };
  }

  /** Execute a synchronous authorized write only when its additional retained bytes fit; shrinking writes remain available. */
  function change(board, principal, delta, write) {
    if (!Number.isSafeInteger(delta) || typeof write !== 'function') throw new Refused('RELAY_CONFIG', 'Compute the exact retained byte change before storing opaque data.');
    return auth.withBoard(board, () => {
      const storage = usage(board, principal);
      if (!storage) throw new Refused('RELAY_CONFIG', 'Assign the linked board to its authenticated storage account before uploading.');
      if (delta > 0 && storage.usedBytes + delta > limitBytes) {
        // This small independent notice survives the failed journal transaction, which must roll back its data write.
        db.prepare('INSERT INTO storage_warning VALUES (?,?,?) ON CONFLICT(board) DO UPDATE SET storage=excluded.storage,needed=excluded.needed').run(board, JSON.stringify(storage), delta);
        const error = new Refused('ACCOUNT_STORAGE_LIMIT', storageLimitMessage(storage));
        error.storage = storage;
        throw error;
      }
      const result = write();
      if (result && typeof result.then === 'function') throw new Refused('RELAY_CONFIG', 'Finish storage accounting and its write before awaiting.');
      return result;
    });
  }

  /** Reuse a caller's fresh locked accounting observation, or count now, when reporting quota warnings. */
  function notice(board, current = usage(board)) {
    open();
    const saved = db.prepare('SELECT storage,needed FROM storage_warning WHERE board=?').get(board);
    if (!current) return null;
    if (saved && current.usedBytes + saved.needed > limitBytes || current.usedBytes >= limitBytes) {
      return { code: 'ACCOUNT_STORAGE_LIMIT', message: storageLimitMessage(current), storage: current };
    }
    if (current.usedBytes / current.limitBytes <= 0.8) return null;
    return { code: 'ACCOUNT_STORAGE_WARNING', message: storageWarningMessage(current), storage: current };
  }

  /** A successful checkpoint or explicit unlink clears this board's old refusal notice. */
  function clear(board) { open(); db.prepare('DELETE FROM storage_warning WHERE board=?').run(board); }

  /** Close this private notice store exactly once. */
  function close() { if (!closed) { db.close(); closed = true; } }
  return { usage, change, notice, clear, close };
}
