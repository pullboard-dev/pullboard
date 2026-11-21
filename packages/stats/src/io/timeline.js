/** Read one item's, or the fleet's, events, gate and landing jobs and job steps through their indexes, read only [C7,#12143]. */
import { TIMELINE_JOB_KINDS } from '../logic/timeline.js';
import { timelineOf } from '../logic/timeline.js';

/** The job kinds the reader asks for, as the job_kind_item index key. */
const JOB_KINDS = Object.keys(TIMELINE_JOB_KINDS);
/** The single indexed read shared by an item or fleet timeline call. */
export const GATE_QUEUE_SQL = 'SELECT event_id AS id, event_at AS at, event_detail AS detail FROM event WHERE event_kind = ? AND event_id BETWEEN ? AND ? ORDER BY event_id';

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
  const gateQueue = readGateQueueRows(db);
  return timelineOf({ item: id, events, jobs, steps, gateQueue, ...(now === undefined ? {} : { now }) });
}

/** Read gate-queue snapshots through event_kind_id; the fold keeps only rows inside each item's queued stretch. */
function readGateQueueRows(db) {
  const latest = db.prepare('SELECT event_id AS high FROM event ORDER BY event_id DESC LIMIT 1').get();
  if (!latest) return [];
  return db.prepare(GATE_QUEUE_SQL)
    .all('gate-queue', 0, latest.high).map(row => {
      let detail = {};
      try { detail = JSON.parse(row.detail) ?? {}; } catch { /* damaged advisory data is ignored */ }
      return { id: row.id, at: Date.parse(row.at), detail };
    });
}

/** The first event row at or after an event id, or undefined past the end. */
function firstFrom(db, id) { return db.prepare('SELECT event_id AS id, event_at AS at FROM event WHERE event_id >= ? ORDER BY event_id LIMIT 1').get(id); }

/**
 * The lowest event id whose time is at or after since, by binary search on event_id (the primary key; event_at has no index of its own).
 * Why: event ids grow with time, so the window's start costs about 25 primary-key probes instead of a scan of every event.
 */
function firstEventSince(db, since) {
  const lowest = db.prepare('SELECT event_id AS id FROM event WHERE event_id >= 0 ORDER BY event_id LIMIT 1').get(), highest = db.prepare('SELECT event_id AS id FROM event WHERE event_id >= 0 ORDER BY event_id DESC LIMIT 1').get();
  if (!lowest) return null;
  const bounds = { low: lowest.id, high: highest.id };
  let low = bounds.low, high = bounds.high + 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2), found = firstFrom(db, mid);
    if (!found || Date.parse(found.at) >= since) high = mid; else low = found.id + 1;
  }
  return low > bounds.high ? null : low;
}

/**
 * Every item with an event at or after since, each with its full timeline, plus the fleet rows (api_stall events, which name no item) in the window.
 * Why: the fleet rows are read once and shared, never copied into each item.
 *
 * @param {{ db: import('node:sqlite').DatabaseSync } | import('node:sqlite').DatabaseSync} board - An open board, or its database.
 * @param {{ since: number, now?: number }} options - since is the window start in ms.
 * @returns {{ since: number, timelines: { item: number, rows: object[], summary: object, unmapped: object[] }[], fleetRows: { kind: string, at: number, ms: number, route: string|null }[] }}
 */
export function readFleetTimelines(board, { since, now }) {
  const db = board.db ?? board;
  const first = firstEventSince(db, since);
  const touched = new Set(), fleetRows = [];
  if (first !== null) {
    for (const row of db.prepare('SELECT item_id AS item, event_kind AS kind, event_at AS at, event_detail AS detail FROM event WHERE event_id >= ?').iterate(first)) {
      if (row.item !== null) touched.add(row.item);
      else if (row.kind === 'api_stall') {
        let detail = {};
        try { detail = JSON.parse(row.detail) ?? {}; } catch { /* a damaged detail reads as empty */ }
        fleetRows.push({ kind: 'api_stall', at: Date.parse(row.at), ms: Number(detail.lagMs) || 0, route: detail.route ?? null });
      }
    }
  }
  const gateQueue = readGateQueueRows(db);
  const timelines = [...touched].sort((a, b) => a - b).map(id => ({ item: id, ...readItemTimelineWithQueue(db, id, gateQueue, now) }));
  return { since, timelines, fleetRows };
}

/** Read one item's indexed sources while reusing the fleet call's one shared snapshot query. */
function readItemTimelineWithQueue(db, id, gateQueue, now) {
  const events = db.prepare('SELECT event_id AS id, event_at AS at, event_by AS by, event_kind AS kind, item_id AS item, event_detail AS detail FROM event WHERE item_id = ? ORDER BY event_id').all(id);
  const jobs = db.prepare(`SELECT job_id AS id, job_kind AS kind, job_created AS created FROM job WHERE job_kind IN (${JOB_KINDS.map(() => '?').join(', ')}) AND job_item = ? ORDER BY job_created, job_id`).all(...JOB_KINDS, id);
  const stepsOf = db.prepare('SELECT job_step_job AS job, job_step_name AS name, job_step_at AS at, job_step_payload AS payload FROM job_step WHERE job_step_job = ? ORDER BY job_step_at, job_step_id');
  const steps = jobs.flatMap(job => stepsOf.all(job.id));
  return timelineOf({ item: id, events, jobs, steps, gateQueue, ...(now === undefined ? {} : { now }) });
}
