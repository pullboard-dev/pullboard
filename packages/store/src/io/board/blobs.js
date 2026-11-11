/** One-time move of oversized job step payloads into the blob store, and the compaction that returns their space [C7]. */
import { statfsSync } from 'node:fs';
import { BLOBS_MIGRATED_KEY } from '../../logic/board/authority.js';
import { BLOB_THRESHOLD_BYTES } from '../../../../jobs/index.js';
import { blobDirOf } from '../../../../jobs/index.js';
import { parseStub } from '../../../../jobs/index.js';
import { putBlob } from '../../../../jobs/index.js';
import { stubOf } from '../../../../jobs/index.js';


/** The job kind and step whose old copies are derived data: only the newest body is kept. */
const INVENTORY_KIND = 'cells-inventory';
const RESULT_STEP = 'result';

/** Free space worth a rewrite of the board file. */
const COMPACT_MIN_FREE_BYTES = 64 * 1024 * 1024;

/**
 * True when the move has not run on this board, or the file holds enough free pages to compact.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
export function jobBlobsPending(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_step'").get()) return false;
  return !db.prepare('SELECT 1 FROM board_meta WHERE meta_key = ?').get(BLOBS_MIGRATED_KEY) || freeBytes(db) >= COMPACT_MIN_FREE_BYTES;
}

/** Bytes in the file's free pages. */
function freeBytes(db) {
  return db.prepare('PRAGMA freelist_count').get().freelist_count * db.prepare('PRAGMA page_size').get().page_size;
}

/**
 * Move every job step payload over the threshold into the blob store, leaving {blob, size} in the row, and keep only the
 * newest cells-inventory result body: an older one keeps its hash and size and no blob.
 *
 * Why: each cells-inventory run stored the whole repository map in one row (13 rows, 721 MB of a 1.5 GB board), and an
 * old copy is never read: the result is keyed by tree and recomputed on demand. A gate hand-off record stays inline.
 * Row by row, each its own short write, so a seat waiting on the board is never held behind the whole move.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ moved: number, pruned: number, bytes: number }}
 */
export function migrateJobBlobs(db) {
  const report = { moved: 0, pruned: 0, bytes: 0 };
  const dir = blobDirOf(db);
  if (!dir || db.prepare('SELECT 1 FROM board_meta WHERE meta_key = ?').get(BLOBS_MIGRATED_KEY)) return report;
  const newest = db.prepare(`SELECT MAX(s.job_step_id) AS id FROM job_step s JOIN job j ON j.job_id = s.job_step_job
    WHERE j.job_kind = ? AND s.job_step_name = ?`).get(INVENTORY_KIND, RESULT_STEP).id;
  const inventory = db.prepare(`SELECT 1 FROM job_step s JOIN job j ON j.job_id = s.job_step_job
    WHERE s.job_step_id = ? AND j.job_kind = ? AND s.job_step_name = ?`);
  // Gate jobs carry the hand-off record the gate readers find in SQL, so their steps stay inline.
  const ids = db.prepare(`SELECT s.job_step_id AS id FROM job_step s JOIN job j ON j.job_id = s.job_step_job
    WHERE length(s.job_step_payload) > ? AND j.job_kind <> 'gate' ORDER BY s.job_step_id`).all(BLOB_THRESHOLD_BYTES);
  const read = db.prepare('SELECT job_step_payload AS text FROM job_step WHERE job_step_id = ?');
  const write = db.prepare('UPDATE job_step SET job_step_payload = ? WHERE job_step_id = ? AND job_step_payload = ?');
  for (const { id } of ids) {
    const { text } = read.get(id);
    if (parseStub(text)) continue;
    const old = id !== newest && inventory.get(id, INVENTORY_KIND, RESULT_STEP);
    const stub = old ? stubOf(text) : putBlob(dir, text);
    if (write.run(JSON.stringify(stub), id, text).changes === 1) {
      report.bytes += stub.size;
      if (old) report.pruned += 1; else report.moved += 1;
    }
  }
  db.prepare('INSERT OR REPLACE INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(BLOBS_MIGRATED_KEY, JSON.stringify({ ...report, at: new Date().toISOString() }));
  return report;
}

/**
 * Rewrite the board file without its free pages when they are worth it, and only when it is safe: there is room for the
 * copy, and the write lock comes within a short wait. Otherwise nothing changes and a later open tries again.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ minFreeBytes?: number, waitMs?: number }} [options]
 * @returns {{ compacted: boolean, reason?: string, before?: number, after?: number }}
 */
export function compactBoard(db, { minFreeBytes = COMPACT_MIN_FREE_BYTES, waitMs = 5000 } = {}) {
  const free = freeBytes(db);
  if (free < minFreeBytes) return { compacted: false, reason: 'little free space' };
  const file = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (!file) return { compacted: false, reason: 'no board file' };
  const pages = db.prepare('PRAGMA page_count').get().page_count;
  const size = pages * db.prepare('PRAGMA page_size').get().page_size;
  try {
    const room = statfsSync(file);
    if (room.bavail * room.bsize < size) return { compacted: false, reason: 'not enough disk for the rewrite' };
  } catch { /* an unreadable filesystem answer leaves the decision to VACUUM itself */ }
  const wait = db.prepare('PRAGMA busy_timeout').get().timeout;
  try {
    db.exec(`PRAGMA busy_timeout = ${waitMs}`);
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { compacted: true, before: size, after: db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size };
  } catch (error) {
    return { compacted: false, reason: String(error?.message ?? error) };
  } finally { db.exec(`PRAGMA busy_timeout = ${wait}`); }
}
