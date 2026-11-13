/** A content-addressed blob store for big job step payloads, beside the board file [C7]. */
import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';

/** Payloads over this many bytes live in the blob store; job_step keeps only their hash and size. */
export const BLOB_THRESHOLD_BYTES = 64 * 1024;

const HASH = /^[0-9a-f]{64}$/u;

/**
 * The blob directory of a board: `blobs/` beside the board file, in the private pullboard dir.
 *
 * Why: the board file's folder is already private to the repository; null for an in-memory board, which keeps
 * every payload inline.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string | null}
 */
export function blobDirOf(db) {
  const file = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  return file ? join(dirname(file), 'blobs') : null;
}

/**
 * The stub a job_step row keeps for a payload held in the blob store.
 *
 * @param {string} text - The payload's JSON text.
 * @returns {{ blob: string, size: number }}
 */
export function stubOf(text) {
  return { blob: createHash('sha256').update(text).digest('hex'), size: Buffer.byteLength(text) };
}

/**
 * The stub a payload text is, or null when it is an ordinary payload.
 *
 * @param {string} text
 * @returns {{ blob: string, size: number } | null}
 */
export function parseStub(text) {
  if (typeof text !== 'string' || !text.startsWith('{"blob":"') || text.length > 200) return null;
  try {
    const value = JSON.parse(text);
    const keys = Object.keys(value);
    return keys.length === 2 && HASH.test(value.blob ?? '') && Number.isSafeInteger(value.size) ? { blob: value.blob, size: value.size } : null;
  } catch { return null; }
}

/**
 * Write a payload text to the store; a blob that already exists is left as it is. Written to a private temp file and
 * renamed, so a reader never sees a half-written blob.
 *
 * @param {string} dir - The blob directory.
 * @param {string} text
 * @returns {{ blob: string, size: number }}
 */
export function putBlob(dir, text) {
  const stub = stubOf(text);
  const target = join(dir, stub.blob);
  if (existsSync(target)) return stub;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${stub.blob}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temp, text, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, target);
  } finally { rmSync(temp, { force: true }); }
  return stub;
}

/**
 * The text of a stored blob, or null when it is not in the store (pruned, or not carried to this machine).
 *
 * @param {string | null} dir
 * @param {string} hash
 * @returns {string | null}
 */
export function readBlob(dir, hash) {
  if (!dir || !HASH.test(hash)) return null;
  try { return readFileSync(join(dir, hash), 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

/**
 * Read a job_step payload text into its value, fetching it from the blob store when the row holds a stub. A stub whose
 * blob is gone reads as `{ blob, size, pruned: true }` so a reader treats the body as absent.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} text
 * @returns {any}
 */
export function readPayload(db, text) {
  const stub = parseStub(text);
  if (!stub) return JSON.parse(text);
  const body = readBlob(blobDirOf(db), stub.blob);
  return body === null ? { ...stub, pruned: true } : JSON.parse(body);
}

/**
 * The text to store for a payload: the payload itself, or its stub after the body went to the blob store.
 *
 * Why a gate hand-off record stays inline: the gate readers find it in SQL (json_extract on `$.record`), and a record
 * is small by construction.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} text - The payload's JSON text.
 * @param {unknown} payload
 * @returns {string}
 */
export function storableText(db, text, payload) {
  if (Buffer.byteLength(text) <= BLOB_THRESHOLD_BYTES || (payload && typeof payload === 'object' && 'record' in payload)) return text;
  const dir = blobDirOf(db);
  return dir ? JSON.stringify(putBlob(dir, text)) : text;
}
