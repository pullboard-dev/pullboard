/**
 * Gather the pipeline ledger's inputs from this machine, read only [C7]: the board's pipeline events, proof-run
 * receipts and landing batches, the gate and landing span files, the agents' session logs, and the joined seats.
 */
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { gateSpanFolder } from '../../../jobs/index.js';
import { readGateSpans } from '../../../jobs/index.js';
import { readLandingSpans } from '../../../resources/index.js';
import { pipelineLedger } from '../logic/pipeline/ledger.js';
import { readSessions } from './logs.js';

/** Events that move an item through the loop. */
const PIPELINE_KINDS = ['claim', 'renew', 'submit-handoff', 'submit', 'reserve', 'accept', 'reject', 'merged', 'release', 'withdraw'];

/** Events that say which item a seat is working on, and as what. */
const SEAT_KINDS = ['claim', 'renew', 'submit', 'submit-handoff', 'reserve', 'accept', 'reject', 'release'];

/** How far before the window an item's cycle may have started: its claim is usually within a day. */
const LOOKBACK_MS = 24 * 3_600_000;

/**
 * The first event id at or after an instant, by binary search over the id order (ids grow with time), so no query
 * scans the event table by its timestamp.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} at
 * @returns {number}
 */
export function firstEventIdAt(db, at) {
  const iso = new Date(at).toISOString();
  const top = db.prepare('SELECT max(event_id) AS id FROM event').get()?.id ?? 0;
  const atId = db.prepare('SELECT event_id, event_at FROM event WHERE event_id >= ? ORDER BY event_id LIMIT 1');
  let low = 0, high = top + 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const row = atId.get(mid);
    if (!row || row.event_at >= iso) high = mid; else low = row.event_id + 1;
  }
  return low;
}

/** A SQL list of quoted kinds. */
function kinds(list) {
  return list.map(kind => `'${kind}'`).join(', ');
}

/**
 * Read every input and build the ledger.
 *
 * @param {import('node:sqlite').DatabaseSync} db - the board, opened for reading
 * @param {object} options
 * @param {string} options.commonDir
 * @param {number} options.since
 * @param {number} options.now
 * @param {number|null} [options.item]
 * @param {string} [options.home] - where the session logs live; the user's home by default
 * @param {import('./logs.js').SessionCache|null} [options.cache] - the keyed store for parsed session logs
 * @returns {ReturnType<typeof pipelineLedger> & { read: object }}
 */
export function readPipelineLedger(db, { commonDir, since, now, item = null, home, cache = null }) {
  const started = Date.now();
  let windowStart = since;
  if (item !== null) {
    const first = db.prepare(`SELECT min(event_at) AS at FROM event WHERE item_id = ? AND event_kind IN (${kinds(['claim', 'merged', 'submit'])})`).get(item)?.at;
    const last = db.prepare("SELECT max(event_at) AS at FROM event WHERE item_id = ? AND event_kind = 'claim'").get(item)?.at;
    windowStart = Math.min(first ? Date.parse(first) : now - LOOKBACK_MS, last ? Date.parse(last) : now);
  }
  const lookbackId = firstEventIdAt(db, windowStart - (item === null ? LOOKBACK_MS : 0));
  const sinceId = firstEventIdAt(db, windowStart);
  const items = item !== null ? [item]
    : db.prepare(`SELECT DISTINCT item_id AS id FROM event WHERE event_kind IN (${kinds(PIPELINE_KINDS)}) AND event_id >= ? AND item_id IS NOT NULL`).all(sinceId).map(row => row.id);
  const list = JSON.stringify(items);
  const events = db.prepare(`SELECT event_at, event_by, event_kind, item_id, CASE WHEN event_kind = 'submit-handoff' THEN json_extract(event_detail, '$.state') END AS state
    FROM event WHERE item_id IN (SELECT value FROM json_each(?)) AND event_kind IN (${kinds(PIPELINE_KINDS)}) AND event_id >= ? ORDER BY event_id`).all(list, item === null ? lookbackId : 0)
    .map(row => ({ at: Date.parse(row.event_at), by: row.event_by, kind: row.event_kind, item: row.item_id, state: row.state ?? null }));
  const seatEvents = db.prepare(`SELECT event_at, event_by, event_kind, item_id FROM event WHERE event_kind IN (${kinds(SEAT_KINDS)}) AND event_id >= ? ORDER BY event_id`)
    .all(lookbackId).map(row => ({ at: Date.parse(row.event_at), by: row.event_by, kind: row.event_kind, item: row.item_id }));
  const seen = new Set();
  const receipts = db.prepare(`SELECT item_id, event_at, json_extract(event_detail, '$.receipt.id') AS id, json_extract(event_detail, '$.receipt.runner') AS runner,
    json_extract(event_detail, '$.receipt.durationMs') AS duration, json_array_length(event_detail, '$.receipt.testRuntimes') AS files, json_extract(event_detail, '$.receipt.kind') AS kind
    FROM event WHERE event_kind = 'proof-run' AND item_id IN (SELECT value FROM json_each(?)) AND event_id >= ? AND json_valid(event_detail) ORDER BY event_id`).all(list, item === null ? lookbackId : 0)
    .filter(row => !row.id || (!seen.has(row.id) && seen.add(row.id)))
    .map(row => ({ item: row.item_id, at: Date.parse(row.event_at), runner: row.runner ?? null, durationMs: Number(row.duration) || 0, files: Number(row.files) || 0, kind: row.kind ?? null }));
  const batches = new Map();
  for (const row of db.prepare(`SELECT event_at, json_extract(event_detail, '$.batch.id') AS id, json_extract(event_detail, '$.batch.startedAt') AS startedAt,
    (SELECT json_group_array(json_extract(value, '$.id')) FROM json_each(event_detail, '$.batch.candidates')) AS candidates
    FROM event WHERE event_kind = 'landing_batch' AND event_id >= ? AND json_valid(event_detail) ORDER BY event_id`).all(lookbackId)) {
    if (!row.id) continue;
    let candidates = [];
    try { candidates = JSON.parse(row.candidates ?? '[]'); } catch { /* a batch without candidates names no item */ }
    const batch = batches.get(row.id) ?? { id: row.id, startedAt: Date.parse(row.startedAt), at: 0, candidates: [] };
    batch.at = Math.max(batch.at, Date.parse(row.event_at));
    batch.candidates = [...new Set([...batch.candidates, ...candidates])];
    batches.set(row.id, batch);
  }
  const agents = db.prepare('SELECT agent_id AS id, agent_path AS path, agent_lane AS lane FROM agent').all().filter(agent => agent.path);
  const spanSince = windowStart - (item === null ? LOOKBACK_MS : 0);
  const gateSpans = readGateSpans(gateSpanFolder(commonDir), { since: spanSince, now });
  const landingSpans = readLandingSpans(commonDir, { since: spanSince, now });
  const boardMs = Date.now() - started;
  // The main checkout is the folder that holds the common Git directory; seats sit in it or beside it.
  const root = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
  const keep = cwd => typeof cwd === 'string' && (cwd.startsWith(root) || agents.some(agent => cwd === agent.path || cwd.startsWith(agent.path + '/')));
  const sessions = readSessions({ root, since: windowStart, now, keep, home, cache });
  const ledger = pipelineLedger({ since: windowStart, now, item, events, seatEvents, gateSpans, landingSpans, batches: [...batches.values()], receipts, sessions, agents });
  return { ...ledger, read: { boardMs, sessionsMs: Date.now() - started - boardMs, sessionFilesParsed: sessions.parsed, segments: sessions.segments.length, buckets: sessions.buckets.length } };
}
