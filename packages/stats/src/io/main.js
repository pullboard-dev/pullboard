import { proofEventDetail } from '../../../kernel/light.js';
/** Public proof numbers derived from the append-only event log [R1,R2]. */
import { Refused } from '../../../kernel/light.js';
import { flowStats } from '../logic/flow.js';
import { barStats } from '../logic/bar.js';
import { caughtFrom } from '../../../items/light.js';

/** Identify a registered agent seat without counting board-owned actors. */
export function isProofAgent({ agent_id: id, agent_lane: lane }) {
  return lane !== 'coordinator' && !['board', 'person', 'clock', 'coordinator', 'rigor', 'sentinel'].includes(id);
}

/** Return registered agent seats, excluding the board's system actors. */
export function proofAgentIds(board) {
  return new Set(board.db.prepare('SELECT agent_id, agent_lane FROM agent').all().filter(isProofAgent).map(row => row.agent_id));
}

/** Parse an inclusive UTC date boundary, refusing malformed or impossible dates. */
export function sinceDate(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  const match = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/u.exec(text);
  const milliseconds = match ? Date.parse(text) : NaN;
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== match?.[1]) {
    throw new Refused('BAD_SINCE', 'the since date is invalid; use --since YYYY-MM-DD or an ISO UTC timestamp, for example --since 2026-10-08');
  }
  return new Date(milliseconds).toISOString();
}

/** Count moves in a window while auditing merges against their complete earlier history. */
function countsFrom(history, boundary) {
  const selected = history.filter((event) => !boundary || Date.parse(event.event_at) >= Date.parse(boundary));
  const selectedIds = new Set(selected.map((event) => event.event_id));
  let submissions = 0;
  let rejections = 0;
  const merged = new Set();
  const withoutAccept = new Set();
  const submitted = new Map();
  const accepted = new Map();
  for (const event of history) {
    const detail = proofEventDetail(event);
    if (event.event_kind === 'submit') {
      submitted.set(event.item_id, detail.commit);
      accepted.delete(event.item_id);
      if (selectedIds.has(event.event_id)) submissions += 1;
    } else if (event.event_kind === 'accept') {
      if (detail.commit && detail.commit === submitted.get(event.item_id)) accepted.set(event.item_id, detail.commit);
    } else if (event.event_kind === 'reject') {
      accepted.delete(event.item_id);
      if (selectedIds.has(event.event_id)) rejections += 1;
    } else if (event.event_kind === 'merged' && selectedIds.has(event.event_id)) {
      merged.add(event.item_id);
      if (!accepted.has(event.item_id)) withoutAccept.add(event.item_id);
    }
  }
  const dates = selected.map((event) => event.event_at).sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    since: boundary,
    submissions,
    rejections,
    rejectionShare: submissions ? rejections / submissions : 0,
    merged: merged.size,
    mergedWithoutAccept: withoutAccept.size,
    firstEventAt: dates[0] ?? null,
    lastEventAt: dates.at(-1) ?? null,
  };
}

/** Count lifecycle moves through the caller's explicit native history reader. */
export function eventCounts(board, { since } = {}, reads) {
  const boundary = sinceDate(since);
  if (typeof reads?.events !== 'function') throw new TypeError('eventCounts requires an explicit events read port');
  return countsFrom(reads.events(board), boundary);
}

/** Attribute only recorded actor families, retaining earlier declarations across date windows. */
function actorsFrom(history, boundary, seats) {
  const declared = new Map();
  const actors = new Map();
  const families = new Map();
  for (const event of history) {
    const id = event.event_by;
    if (!seats.has(id)) continue;
    const detail = proofEventDetail(event);
    if (Object.hasOwn(detail, 'family')) {
      declared.set(id, typeof detail.family === 'string' && detail.family.trim() ? detail.family : 'unknown');
    }
    if (boundary && Date.parse(event.event_at) < Date.parse(boundary)) continue;
    const name = declared.get(id) ?? 'unknown';
    if (!actors.has(id)) actors.set(id, { id, moves: 0, families: new Set() });
    const actor = actors.get(id);
    actor.moves += 1;
    actor.families.add(name);
    if (!families.has(name)) families.set(name, { name, agents: new Set(), moves: 0 });
    const family = families.get(name);
    family.moves += 1;
    family.agents.add(id);
  }
  const agents = [...actors.keys()].sort().map((id) => {
    const actor = actors.get(id);
    return { ...actor, families: [...actor.families].sort() };
  });
  const groups = [...families.keys()].sort().map((name) => {
    const family = families.get(name);
    return { ...family, agents: family.agents.size };
  });
  return { agentCount: agents.length, familyCount: groups.length, agents, families: groups };
}

/** Assemble statistics in one snapshot using the caller's history and counter read operations. */
export function proofStats(board, { since, now = Date.now(), onFallback } = {}, reads) {
  const boundary = sinceDate(since);
  if (typeof reads?.events !== 'function' || typeof reads?.counterProofStats !== 'function') {
    throw new TypeError('proofStats requires explicit events and counterProofStats read ports');
  }
  // A SAVEPOINT is read-only until a write occurs, and nests inside callers' transactions.
  // Hold one snapshot across the cursor, projection shards, and verdicts while other seats append.
  board.db.exec('SAVEPOINT proof_stats_read');
  try { return { ...proofStatsSnapshot(board, boundary, now, onFallback, reads), notesPerSubmit: notesPerSubmit(board, boundary), workFreeReleases: readWorkFreeReleases(board.db, { since: boundary }) }; }
  finally { board.db.exec('RELEASE proof_stats_read'); }
}

/** Assemble cached or legacy statistics within the caller's already established read snapshot. */
function proofStatsSnapshot(board, boundary, now, onFallback, reads) {
  const counted = reads.counterProofStats(board, boundary, now);
  if (counted) return counted;
  onFallback?.();
  const history = reads.events(board);
  const counts = countsFrom(history, boundary);
  const verdicts = board.db.prepare('SELECT * FROM verdict ORDER BY verdict_id').all();
  const seats = proofAgentIds(board);
  return { ...counts, ...actorsFrom(history, boundary, seats), bars: barStats(history, verdicts, boundary), caught: caughtFrom(history, verdicts, boundary), flow: flowStats(history, boundary, now, counts, { agentIds: seats }) };
}

/** Count holder notes and successful submissions per seat in the same stats snapshot [R1,R2]. */
function notesPerSubmit(board, boundary) {
  const seats = proofAgentIds(board);
  return board.db.prepare(`SELECT event_by AS seat,
    SUM(CASE WHEN event_kind='fact' THEN 1 ELSE 0 END) AS notes,
    SUM(CASE WHEN event_kind='submit' THEN 1 ELSE 0 END) AS submits
    FROM event WHERE (event_kind='submit' OR event_kind='fact' AND json_extract(event_detail,'$.kind')='note')
    AND event_by NOT IN ('board','person','clock','coordinator') AND (? IS NULL OR event_at>=?)
    GROUP BY event_by ORDER BY event_by`).all(boundary, boundary)
    .filter(row => seats.has(row.seat))
    .map(row => ({ ...row, notesPerSubmit: row.submits ? row.notes / row.submits : null }));
}
import { readWorkFreeReleases } from '../logic/work/free.js';
