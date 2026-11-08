/** One retained database connection per file for a long-lived process, so repeated slot calls never leak handles [C7,#3338]. */
import { statSync } from 'node:fs';

/** The retained connection per database file, with the inode it was opened on. */
const sharedConnections = new Map();
let reusingConnections = false;

/** Make every later slot call in this process (takeResource, listResources, release, renew) reuse one connection per database file, opened once and closed when the process exits [C7,#3338]. */
export function reuseResourceConnections() {
  if (reusingConnections) return;
  reusingConnections = true;
  process.once('exit', closeResourceConnections);
}

/** Close the retained connections; the next call reopens a fresh one if reuse is still on [C7,#3338]. */
export function closeResourceConnections() {
  for (const { db } of sharedConnections.values()) { try { db.close(); } catch { /* Already closed. */ } }
  sharedConnections.clear();
}

/**
 * The inode of a database file, or null when it is missing, so a deleted and recreated file is never served a stale handle.
 * @param {string} file - The database path.
 * @returns {number | null} The inode.
 */
function fileIdentity(file) {
  try { return statSync(file).ino; } catch { return null; }
}

/**
 * Wrap a retained connection so a caller's close() leaves it open for the next slot call.
 * @param {import('node:sqlite').DatabaseSync} db - The retained connection.
 * @returns {import('node:sqlite').DatabaseSync} A stand-in whose close does nothing.
 */
function retained(db) {
  return new Proxy(db, {
    get(target, key) {
      if (key === 'close') return () => {};
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Open a connection, or return the process's one retained connection for the file when reuse is on.
 * @param {string} file - The database path.
 * @param {() => import('node:sqlite').DatabaseSync} fresh - Opens and initializes a new connection.
 * @returns {import('node:sqlite').DatabaseSync} The connection.
 */
export function retainConnection(file, fresh) {
  if (!reusingConnections) return fresh();
  const kept = sharedConnections.get(file);
  if (kept && kept.ino !== null && kept.ino === fileIdentity(file)) return kept.proxy;
  if (kept) { try { kept.db.close(); } catch { /* Already closed. */ } sharedConnections.delete(file); }
  const db = fresh();
  const entry = { db, proxy: retained(db), ino: fileIdentity(file) };
  sharedConnections.set(file, entry);
  return entry.proxy;
}
