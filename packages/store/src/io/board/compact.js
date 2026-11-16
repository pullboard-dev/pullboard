/** Archive the job steps of items landed or withdrawn long ago into a gzip file beside the board, and read them back [C7]. */
import { closeSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { fsyncSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { gzipSync } from 'node:zlib';
import { dropSteps } from '../../../../jobs/index.js';
import { jobView } from '../../../../jobs/index.js';
import { readPayload } from '../../../../jobs/index.js';
import { compactBoard } from './blobs.js';

/** Items finished this long ago have their job steps archived. */
export const COMPACT_AFTER_DAYS = 30;

/** The archive's file name: one gzip member appended per batch, so the file only ever grows by whole members. */
export const STEP_ARCHIVE_NAME = 'job-steps.archive.ndjson.gz';

/** Jobs archived per write, so a seat waiting on the board is never held behind the whole pass. */
const BATCH_JOBS = 200;

const DAY_MS = 86_400_000;

/** The board file of a connection, or null for an in-memory board. */
function boardFileOf(db) {
  return db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file || null;
}

/** The archive file beside a board file. */
export function stepArchivePath(boardFile) {
  return join(dirname(boardFile), STEP_ARCHIVE_NAME);
}

/** The size in bytes the board's pages take, free pages included. */
function pageBytes(db) {
  return db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;
}

/**
 * The jobs of items finished before the cutoff: landed (a merged event) or withdrawn, whose last such event and last
 * update are both older than the cutoff, and whose lease is not live.
 */
function oldJobs(db, cutoff, now) {
  return db.prepare(`SELECT j.job_id AS id FROM job j JOIN item i ON i.item_id = j.job_item
    WHERE j.job_lease_until < ? AND i.item_updated_at < ?
      AND (i.item_status = 'withdrawn' OR EXISTS (SELECT 1 FROM event m WHERE m.item_id = i.item_id AND m.event_kind = 'merged'))
      AND (SELECT MAX(e.event_at) FROM event e WHERE e.item_id = i.item_id AND e.event_kind IN ('merged', 'withdraw')) < ?
    ORDER BY j.job_id`).all(now, cutoff, cutoff).map(row => row.id);
}

/**
 * The steps of one job to archive: everything except what readers of a finished item still need. Kept: the job's last
 * step (its final state), its offered request, every receipt, and the newest step carrying a hand-off record.
 */
function archivable(db, job) {
  return db.prepare(`SELECT s.* FROM job_step s WHERE s.job_step_job = ?
    AND s.job_step_id <> (SELECT MAX(job_step_id) FROM job_step WHERE job_step_job = s.job_step_job)
    AND NOT (s.job_step_name = 'offered' AND s.job_step_seq = 0) AND s.job_step_name <> 'receipt'
    AND s.job_step_id <> COALESCE((SELECT MAX(job_step_id) FROM job_step r WHERE r.job_step_job = s.job_step_job AND r.job_step_payload LIKE '%"record"%'), -1)
    ORDER BY s.job_step_id`).all(job);
}

/** Append one gzip member to the archive and make it durable before the caller deletes anything. */
function appendMember(file, rows) {
  const text = rows.map(row => JSON.stringify({ id: row.job_step_id, job: row.job_step_job, name: row.job_step_name,
    seq: row.job_step_seq, payload: row.job_step_payload, at: row.job_step_at })).join('\n') + '\n';
  const fd = openSync(file, 'a', 0o600);
  try { writeSync(fd, gzipSync(text)); fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Move the job steps of items landed or withdrawn more than `days` ago into the gzip archive beside the board, keeping
 * each job's last step and the steps its receipts read, then rewrite the board file without the freed pages. The item,
 * event and job rows are never touched.
 *
 * Why: run telemetry has no retention, and a finished item's step-by-step log is read only by history. Each batch is
 * archived and made durable before its rows are deleted, so a crash leaves at worst a duplicate in the archive, which
 * the reader drops by step id; each batch is its own short write.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ days?: number, now?: number, dryRun?: boolean, vacuum?: boolean }} [options]
 * @returns {{ days: number, jobs: number, rows: number, payloadBytes: number, archive: string | null, archiveBytes: number, before: number, after: number, vacuumed: boolean, dryRun: boolean }}
 */
export function compactJobSteps(db, { days = COMPACT_AFTER_DAYS, now = Date.now(), dryRun = false, vacuum = true } = {}) {
  const file = boardFileOf(db);
  const archive = file ? stepArchivePath(file) : null;
  const report = { days, jobs: 0, rows: 0, payloadBytes: 0, archive, archiveBytes: 0, before: pageBytes(db), after: 0, vacuumed: false, dryRun };
  if (archive && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_step'").get()) {
    const cutoff = new Date(now - days * DAY_MS).toISOString();
    const jobs = oldJobs(db, cutoff, now);
    for (let start = 0; start < jobs.length; start += BATCH_JOBS) {
      const rows = jobs.slice(start, start + BATCH_JOBS).flatMap(job => archivable(db, job));
      if (!rows.length) continue;
      report.rows += rows.length;
      report.payloadBytes += rows.reduce((sum, row) => sum + Buffer.byteLength(row.job_step_payload), 0);
      report.jobs += new Set(rows.map(row => row.job_step_job)).size;
      if (dryRun) continue;
      appendMember(archive, rows);
      dropSteps(db, rows.map(row => row.job_step_id));
    }
  }
  if (!dryRun && report.rows && vacuum) report.vacuumed = compactBoard(db, { minFreeBytes: 1 }).compacted;
  report.after = pageBytes(db);
  if (archive && existsSync(archive)) report.archiveBytes = statSync(archive).size;
  return report;
}

/** Every archived step of the board at `boardFile`, oldest first, each once; empty when nothing was archived. */
function archivedRows(boardFile, job) {
  const archive = stepArchivePath(boardFile);
  if (!existsSync(archive)) return [];
  const seen = new Map();
  for (const line of gunzipSync(readFileSync(archive)).toString('utf8').split('\n')) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (job === undefined || row.job === job) seen.set(row.id, row);
  }
  return [...seen.values()].sort((a, b) => a.id - b.id);
}

/**
 * A job's view with its archived steps back in their places, for history reads; null when the job does not exist.
 * A job with nothing archived reads exactly as jobView reads it.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @returns {ReturnType<typeof jobView>}
 */
export function jobHistory(db, job) {
  const view = jobView(db, job);
  const file = boardFileOf(db);
  if (!view || !file) return view;
  const live = db.prepare('SELECT job_step_id AS id, job_step_name AS name, job_step_seq AS seq, job_step_payload AS payload, job_step_at AS at FROM job_step WHERE job_step_job = ?').all(job);
  const old = archivedRows(file, job).map(row => ({ id: row.id, name: row.name, seq: row.seq, payload: row.payload, at: row.at }));
  if (!old.length) return view;
  const steps = [...old, ...live].sort((a, b) => a.id - b.id)
    .map(row => ({ name: row.name, seq: row.seq, payload: readPayload(db, row.payload), at: row.at }));
  return { ...view, steps };
}
