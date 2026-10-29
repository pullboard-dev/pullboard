/** Private device-only cipher cache and durable upload graph; no board key or decrypted record is stored [H15,H17]. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Refused } from './refused.js';
import {
  PAGE_CIPHER_BYTES,
  PAGE_FANOUT,
  pageReference,
  sealedPageFingerprint,
} from './sealed-pages.js';

/** Refuse a damaged private cache without repeating any bytes or private fingerprints. */
function invalid() { return new Refused('RELAY_PAGE_CACHE', 'Restore private relay page cache storage, or remove this device cache and retry the saved snapshot.'); }

/** Hash a local identity without making a repository name, token or relay address a filename. */
export function snapshotSourceId(value) { return createHash('sha256').update(value).digest('hex'); }

/** Keep one board and relay origin's immutable cipher objects, private reuse mappings and unfinished uploads. */
export function createRelayPageCache(state) {
  if (!/^[0-9a-f]{32}$/u.test(state?.board ?? '') || typeof state.url !== 'string') throw invalid();
  const directory = join(process.env.PULLBOARD_HOME || join(homedir(), '.pullboard'), 'relay-pages');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077) throw invalid();
  const origin = snapshotSourceId(state.url);
  const file = join(directory, state.board + '-' + origin + '.sqlite');
  try { closeSync(openSync(file, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) throw invalid();
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS object (id TEXT PRIMARY KEY,sequence INTEGER NOT NULL,payload BLOB NOT NULL,children TEXT NOT NULL,ack INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS fingerprint (hash TEXT PRIMARY KEY,id TEXT NOT NULL REFERENCES object(id) ON DELETE CASCADE,reference TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notice (session TEXT PRIMARY KEY,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS job (source TEXT PRIMARY KEY,reference TEXT NOT NULL,upload TEXT);
      CREATE TABLE IF NOT EXISTS job_object (source TEXT NOT NULL REFERENCES job(source) ON DELETE CASCADE,id TEXT NOT NULL REFERENCES object(id),PRIMARY KEY(source,id));`);
    const saved = db.prepare('SELECT key,value FROM meta ORDER BY key').all();
    if (!saved.length) db.prepare('INSERT INTO meta VALUES (?,?),(?,?),(?,?)').run('board', state.board, 'format', '1', 'origin', origin);
    else if (JSON.stringify(saved.map(row => [row.key, row.value])) !== JSON.stringify([['board', state.board], ['format', '1'], ['origin', origin]])) throw invalid();
  } catch (error) { db.close(); throw error; }

  /** Validate both ciphertext identity and opaque metadata before reusing a private object. */
  function object(id) {
    if (!/^[0-9a-f]{64}$/u.test(id ?? '')) throw invalid();
    const row = db.prepare('SELECT * FROM object WHERE id=?').get(id);
    if (!row || !Number.isSafeInteger(row.sequence) || row.sequence < 0 || row.payload.byteLength > PAGE_CIPHER_BYTES || snapshotSourceId(row.payload) !== id) throw invalid();
    let children;
    try { children = JSON.parse(row.children); } catch { throw invalid(); }
    if (!Array.isArray(children) || children.length > PAGE_FANOUT || children.some(child => !/^[0-9a-f]{64}$/u.test(child))) throw invalid();
    return { id, sequence: row.sequence, bytes: Uint8Array.from(row.payload), children, acknowledged: row.ack === 1 };
  }

  /** Store immutable bytes before recording any reference or upload progress. */
  function put(value) {
    const id = snapshotSourceId(value.bytes);
    if (id !== value.id || value.bytes.byteLength > PAGE_CIPHER_BYTES || !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
        !Array.isArray(value.children) || value.children.length > PAGE_FANOUT || value.children.some(child => !/^[0-9a-f]{64}$/u.test(child))) throw invalid();
    const saved = db.prepare('SELECT id FROM object WHERE id=?').get(id);
    if (saved) {
      const previous = object(id);
      if (previous.sequence !== value.sequence || JSON.stringify(previous.children) !== JSON.stringify(value.children)) throw invalid();
      return;
    }
    db.prepare('INSERT INTO object(id,sequence,payload,children) VALUES (?,?,?,?)').run(id, value.sequence, value.bytes, JSON.stringify(value.children));
  }

  /** Verify decrypted cache identity instead of trusting a stale or misbound private fingerprint row. */
  async function lookup(hash, context) {
    const saved = db.prepare('SELECT reference FROM fingerprint WHERE hash=?').get(hash);
    if (!saved) return null;
    let reference;
    try { reference = pageReference(JSON.parse(saved.reference)); } catch { throw invalid(); }
    let actual;
    try { actual = await sealedPageFingerprint(reference, { ...context, get: id => object(id).bytes, parents: [] }); }
    catch (error) {
      // A legitimate off/delete/relink can replace the key at this board/origin. Old local cipher hints cannot
      // be reused under that key; rebuild from the caller's native data. Actual remote reads still authenticate.
      if (error instanceof Refused && error.code === 'SEAL_AUTH_FAILED') return null;
      throw error;
    }
    if (actual !== hash) throw invalid();
    return reference;
  }

  /** A plaintext hash is private device cache metadata and never part of an upload object. */
  function remember(hash, reference) {
    if (!/^[0-9a-f]{64}$/u.test(hash ?? '')) throw invalid();
    const ref = pageReference(reference);
    db.prepare('INSERT INTO fingerprint VALUES (?,?,?) ON CONFLICT(hash) DO UPDATE SET id=excluded.id,reference=excluded.reference').run(hash, ref.id, JSON.stringify(ref));
  }

  /** Read a durable job only under its exact original pending-cipher source identity. */
  function job(source) {
    if (!/^[0-9a-f]{64}$/u.test(source ?? '')) throw invalid();
    const row = db.prepare('SELECT reference,upload FROM job WHERE source=?').get(source);
    if (!row) return null;
    let reference;
    try { reference = pageReference(JSON.parse(row.reference)); } catch { throw invalid(); }
    return { reference, upload: row.upload };
  }

  /** Atomically retain only this exact prepared graph as the job's upload/resume set. */
  function prepare(source, reference) {
    pageReference(reference);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO job VALUES (?,?,NULL) ON CONFLICT(source) DO UPDATE SET reference=excluded.reference,upload=NULL').run(source, JSON.stringify(reference));
      db.prepare('DELETE FROM job_object WHERE source=?').run(source);
      const found = new Set(), visiting = new Set();
      /** Visit each local child once, refusing cycles and missing data before publishing. */
      function visit(id, depth = 0) {
        if (visiting.has(id) || depth >= 64) throw invalid();
        if (found.has(id)) return;
        visiting.add(id);
        const value = object(id);
        for (const child of value.children) visit(child, depth + 1);
        visiting.delete(id); found.add(id);
        db.prepare('INSERT INTO job_object VALUES (?,?)').run(source, id);
      }
      visit(reference.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  /** Record the server's principal-bound upload id before the first object request. */
  function upload(source, id) {
    if (!/^[A-Za-z0-9-]{1,128}$/u.test(id ?? '')) throw invalid();
    db.prepare('UPDATE job SET upload=? WHERE source=?').run(id, source);
  }

  /** Stream only objects not yet acknowledged by this relay, without an aggregate request body. */
  function* pending(source) {
    // Finish each read before yielding: an awaited PUT may let another connection commit,
    // and a suspended SQLite iterator would make the subsequent ACK upgrade a stale snapshot.
    // CROSS JOIN keeps the rowid seek outermost instead of sorting the whole job for each page.
    const statement = db.prepare('SELECT object.rowid AS position,object.id FROM object CROSS JOIN job_object USING(id) WHERE source=? AND ack=0 AND object.rowid>? ORDER BY object.rowid LIMIT 1');
    statement.setReadBigInts(true);
    let position = 0n;
    for (;;) {
      const row = statement.get(source, position);
      if (!row) return;
      position = row.position;
      yield object(row.id);
    }
  }

  /** A lost ACK safely retries the same immutable object; only an actual ACK marks it done. */
  function acknowledge(id) { db.prepare('UPDATE object SET ack=1 WHERE id=?').run(id); }

  /** A collected remote subtree must be re-staged; an old successful upload is not perpetual remote custody. */
  function missing(id) {
    const found = new Set();
    /** Reset the complete local subtree so publication never depends on a stale server-ACK cache. */
    function visit(child, depth = 0) {
      if (depth >= 64) throw invalid();
      if (found.has(child)) return;
      found.add(child);
      const value = object(child);
      db.prepare('UPDATE object SET ack=0 WHERE id=?').run(child);
      for (const next of value.children) visit(next, depth + 1);
    }
    visit(id);
  }

  /** After a real root ACK, discard superseded jobs and locally cached pages unreachable from the current graph. */
  function complete(source) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM job WHERE source<>?').run(source);
      db.exec('DELETE FROM object WHERE id NOT IN (SELECT id FROM job_object)');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  /** Retain one credential-free pause notice receipt per session across CLI processes, with bounded private metadata. */
  function firstNotice(session) {
    if (!/^[0-9a-f]{64}$/u.test(session ?? '')) throw invalid();
    const inserted = db.prepare('INSERT OR IGNORE INTO notice VALUES (?,?)').run(session, Date.now()).changes;
    db.exec('DELETE FROM notice WHERE session NOT IN (SELECT session FROM notice ORDER BY created DESC,rowid DESC LIMIT 128)');
    return inserted === 1;
  }

  /** A successful upload ends the pause interval for all local sessions. */
  function clearNotices() { db.exec('DELETE FROM notice'); }

  /** Close the private cache after every request, including refused or interrupted uploads. */
  function close() { db.close(); }
  return { file, object, put, lookup, remember, job, prepare, upload, pending, acknowledge, missing, complete, firstNotice, clearNotices, close };
}
