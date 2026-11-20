/** Read one item's events, gate and landing jobs and job steps through their indexes, read only [C7,#12143]. */
import { TIMELINE_JOB_KINDS } from '../logic/timeline.js';
import { timelineOf } from '../logic/timeline.js';

/** The job kinds the reader asks for, as the job_kind_item index key. */
const JOB_KINDS = Object.keys(TIMELINE_JOB_KINDS);

/**
 * The rows of one item's timeline, folded by timelineOf.
 *
 * Why: every query uses an index (event by item_id, job by kind and item, steps by job), so reading one item never scans a table that holds the whole fleet's history.
 *
 * @param {{ db: import('node:sqlite').DatabaseSync } | import('node:sqlite').DatabaseSync} board - An open board, or its database.
 * @param {number} id - The item id.
 * @param {{ now?: number }} [options] - now closes a still-open item's last stretch.
 * @returns {{ rows: object[], summary: object, unmapped: { kind: string, count: number }[] }}
 */
export function readItemTimeline(board, id, { now } = {}) {
  const db = board.db ?? board;
  const events = db.prepare('SELECT event_id AS id, event_at AS at, event_by AS by, event_kind AS kind, item_id AS item, event_detail AS detail FROM event WHERE item_id = ? ORDER BY event_id').all(id);
  const jobs = db.prepare(`SELECT job_id AS id, job_kind AS kind, job_created AS created FROM job WHERE job_kind IN (${JOB_KINDS.map(() => '?').join(', ')}) AND job_item = ? ORDER BY job_created, job_id`).all(...JOB_KINDS, id);
  const stepsOf = db.prepare('SELECT job_step_job AS job, job_step_name AS name, job_step_at AS at, job_step_payload AS payload FROM job_step WHERE job_step_job = ? ORDER BY job_step_at, job_step_id');
  const steps = jobs.flatMap(job => stepsOf.all(job.id));
  return timelineOf({ item: id, events, jobs, steps, ...(now === undefined ? {} : { now }) });
}
