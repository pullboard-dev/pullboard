import { appendReportCounter } from './flow-report-counter.js';
import { emptyReportCounter } from './flow-report-counter.js';
import { reportEvent } from './stats-flow-report.js';
import { newReportPolicy } from './stats-flow-report.js';
import { NATIVE_FLAKE_ENGINE } from './flake-engine.js';
/** Rebuildable, local proof projections maintained with the event that produced them [R1,R2]. */
import { moveFlowItem } from './stats-flow.js';
import { roleOf } from './stats-flow.js';
import { appendRuleProof } from './rule-proof-index.js';

export const PROOF_COUNTER_PREFIX = 'local:proof-stats:';
const PREFIX = `${PROOF_COUNTER_PREFIX}v2:`;

/** Encode non-finite timestamps with external paths, so user detail objects cannot collide with markers. */
function encode(value) {
  const numbers = [];
  /** Copy a small shard while recording only non-JSON numeric values. */
  const visit = (field, path) => {
    if (typeof field === 'number' && !Number.isFinite(field)) { numbers.push([path, String(field)]); return null; }
    if (Array.isArray(field)) return field.map((child, index) => visit(child, [...path, index]));
    if (field && typeof field === 'object') return Object.fromEntries(Object.entries(field).map(([key, child]) => [key, visit(child, [...path, key])]));
    return field;
  };
  return JSON.stringify({ data: visit(value, []), numbers });
}

/** Restore exactly the projection-owned numeric paths, leaving arbitrary user detail shapes intact. */
function decode(text) {
  const { data, numbers } = JSON.parse(text);
  for (const [path, number] of numbers) {
    let parent = data;
    for (const key of path.slice(0, -1)) parent = parent[key];
    parent[path.at(-1)] = Number(number);
  }
  return data;
}

/** Read a single small derived record; none of these keys is exported native state. */
export function proofCounter(board, key) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(PREFIX + key);
  return row ? decode(row.meta_value) : null;
}

/** Replace one affected shard without rewriting the board's accumulated history. */
function put(board, key, value) {
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run(PREFIX + key, encode(value));
}

/** Read one kind of projection in event insertion order, preserving historical tie ordering. */
export function proofCounterRows(board, kind) {
  return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key GLOB ? ORDER BY rowid').all(`${PREFIX}${kind}:*`)
    .map(row => decode(row.meta_value));
}

/** Remove local projections without modifying any native event or verdict. */
export function clearProofCounters(board) {
  board.db.prepare('DELETE FROM board_meta WHERE meta_key GLOB ?').run(`${PROOF_COUNTER_PREFIX}*`);
}

/** Start a bounded all-time aggregate; window-specific contributions live in separate event shards. */
function emptySummary() {
  return { last: 0, submissions: 0, rejections: 0, merged: 0, mergedWithoutAccept: 0,
    firstEventAt: null, lastEventAt: null, invalid: false };
}

/** Advance an item's acceptance audit separately from its flow lifecycle, whose rules differ. */
function countItem(summary, item, event, detail) {
  const selected = { submitted: false, rejected: false, merged: false, anomaly: false };
  if (event.event_kind === 'submit') {
    item.submitted = detail.commit; delete item.accepted; summary.submissions += 1; selected.submitted = true;
  } else if (event.event_kind === 'accept') {
    if (detail.commit && detail.commit === item.submitted) item.accepted = detail.commit;
  } else if (event.event_kind === 'reject') {
    delete item.accepted; summary.rejections += 1; selected.rejected = true;
  } else if (event.event_kind === 'merged') {
    selected.merged = true;
    selected.anomaly = !item.accepted;
    if (!item.merged) { item.merged = true; summary.merged += 1; }
    if (selected.anomaly && !item.anomaly) { item.anomaly = true; summary.mergedWithoutAccept += 1; }
  }
  return selected;
}

/** Update recorded family totals and latest flow role with only the acting seat's records. */
function countActor(board, event, detail, at) {
  const id = event.event_by;
  if (['board', 'person'].includes(id)) return null;
  const key = `actor:${encodeURIComponent(id)}`;
  const actor = proofCounter(board, key) ?? { id, moves: 0, families: [], declared: 'unknown', flow: { id, lane: 'unknown', role: 'unknown' } };
  if (Object.hasOwn(detail, 'family')) actor.declared = typeof detail.family === 'string' && detail.family.trim() ? detail.family : 'unknown';
  const familyName = actor.declared;
  const familyKey = `family:${encodeURIComponent(familyName)}`;
  const family = proofCounter(board, familyKey) ?? { name: familyName, agents: 0, moves: 0 };
  if (!actor.families.includes(familyName)) { actor.families.push(familyName); family.agents += 1; }
  actor.moves += 1; family.moves += 1;
  if (event.event_kind === 'join' && detail.lane) actor.flow.lane = detail.lane;
  actor.flow.role = id === 'coordinator' ? 'coordinator' : roleOf(event.event_kind, detail) ?? actor.flow.role;
  actor.flow.lastAt = at;
  put(board, key, actor); put(board, familyKey, family);
  return familyName;
}

/** Retain only catch-bearing events, with decoded details rather than another full raw-event replay. */
function keepCatch(event, detail) {
  return event.event_kind === 'reject' || event.event_kind === 'test-quarantine' ||
    event.event_kind === 'reopen' && (detail.conflict || detail.landingFailure) ||
    event.event_kind === 'flake-observation' && detail.engine === NATIVE_FLAKE_ENGINE && detail.observation?.classification === 'flake' || event.event_kind === 'health-failure' && event.event_by === 'sentinel';
}

/** Fold exactly this event into affected item/actor shards and the small aggregate. */
export function appendProofCounter(board, event) {
  const { appendRigorCounter } = board.runtimePorts.verification;
  appendRigorCounter(board, event);
  const summary = proofCounter(board, 'summary') ?? emptySummary();
  ensureReportCounters(board, summary.last);
  board.onProofStatsEvent?.(event);
  let detail;
  try { detail = JSON.parse(event.event_detail); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; summary.invalid = true; }
  if (detail === null || detail === undefined) summary.invalid = true;
  const at = Date.parse(event.event_at);
  if (!Number.isFinite(at)) summary.invalid = true;
  summary.last = event.event_id;
  if (summary.invalid) { put(board, 'summary', summary); return; }
  if (summary.firstEventAt === null || at < Date.parse(summary.firstEventAt)) summary.firstEventAt = event.event_at;
  if (summary.lastEventAt === null || at >= Date.parse(summary.lastEventAt)) summary.lastEventAt = event.event_at;
  appendReportCounter(event, detail, at, key => proofCounter(board, key), (key, value) => put(board, key, value));
  const key = `item:${event.item_id}`;
  const item = proofCounter(board, key) ?? { id: event.item_id, flow: { id: event.item_id, lane: 'unknown' } };
  const contribution = countItem(summary, item, event, detail);
  const family = countActor(board, event, detail, at);
  if (event.item_id !== null && event.item_id !== undefined) {
    if (event.event_kind === 'add') item.creator = event.event_by;
    if (event.event_kind === 'add' || event.event_kind === 'merged' && item.flow.mergeAt === undefined) {
      put(board, `daily:${event.event_id}`, { at, kind: event.event_kind === 'add' ? 'added' : 'merged' });
    }
    if (reportEvent(event, detail)) moveFlowItem(item.flow, event, detail, at);
    put(board, key, item);
  } else if (['submit', 'accept', 'reject', 'merged'].includes(event.event_kind)) {
    // Legacy counts also audit a null item id, while flow deliberately excludes it.
    put(board, key, item);
  }
  put(board, `event:${event.event_id}`, { at, date: event.event_at, by: event.event_by, family, item: event.item_id, ...contribution });
  if (event.event_kind === 'edit' && detail.barCorrection) {
    put(board, `bar:${event.event_id}`, { event_id: event.event_id, event_at: event.event_at, event_by: event.event_by, item_id: event.item_id, detail: { barCorrection: detail.barCorrection } });
  }
  if (keepCatch(event, detail)) {
    put(board, `catch:${event.event_id}`, { event_id: event.event_id, event_at: event.event_at, event_by: event.event_by, event_kind: event.event_kind, item_id: event.item_id, detail });
  }
  appendRuleProof(board, event, detail, key => proofCounter(board, key), (key, value) => put(board, key, value));
  put(board, 'summary', summary);
}

/** Fully consume bounded read batches before writing shards, including on Node22.13's SQLite API. */
function replayProofTail(board, cursor) {
  const read = board.db.prepare('SELECT * FROM event WHERE event_id>? ORDER BY event_id LIMIT 256');
  while (true) {
    const batch = read.all(cursor);
    if (!batch.length) return;
    for (const event of batch) { appendProofCounter(board, event); cursor = event.event_id; }
  }
}

/** Reset only the optional report when its representation changes; preserve established proof shards. */
function resetReportCounters(board) {
  board.db.prepare('DELETE FROM board_meta WHERE meta_key GLOB ?').run(`${PREFIX}report-*`);
  put(board, 'report-summary', emptyReportCounter());
  put(board, 'report-policy', newReportPolicy());
}

/** Catch up only missed report events after an older writer, without recounting other statistics. */
function ensureReportCounters(board, until) {
  let summary = proofCounter(board, 'report-summary');
  if (!summary || summary.version !== FLOW_REPORT_VERSION) {
    resetReportCounters(board);
    summary = proofCounter(board, 'report-summary');
  }
  if (summary.last >= until || summary.invalid) return;
  const read = board.db.prepare('SELECT * FROM event WHERE event_id>? AND event_id<=? ORDER BY event_id LIMIT 256');
  let cursor = summary.last;
  while (true) {
    const batch = read.all(cursor, until);
    if (!batch.length) return;
    for (const event of batch) {
      let detail;
      try { detail = JSON.parse(event.event_detail); } catch { detail = null; }
      const at = Date.parse(event.event_at);
      if (detail === null || !Number.isFinite(at)) {
        put(board, 'report-summary', { ...summary, invalid: true });
        return;
      }
      board.onFlowReportEvent?.(event);
      appendReportCounter(event, detail, at, key => proofCounter(board, key), (key, value) => put(board, key, value));
      cursor = event.event_id;
    }
  }
}

/** Rebuild from authoritative history inside the caller's existing write transaction. */
export function rebuildProofCounters(board) {
  const { ensureRigorCounters } = board.runtimePorts.verification;
  clearProofCounters(board);
  ensureRigorCounters(board);
  put(board, 'summary', emptySummary());
  resetReportCounters(board);
  replayProofTail(board, 0);
}

/** Catch up an older writer once; ordinary current-writer appends then decode only their new event. */
export function ensureProofCounters(board) {
  const { ensureRigorCounters } = board.runtimePorts.verification;
  ensureRigorCounters(board);
  const summary = proofCounter(board, 'summary');
  if (!summary) { rebuildProofCounters(board); return; }
  ensureReportCounters(board, summary.last);
  replayProofTail(board, summary.last);
}

/** Readers never take a write lock to warm or repair a derived cache. */
export function currentProofCounters(board) {
  const summary = proofCounter(board, 'summary');
  const last = board.db.prepare('SELECT coalesce(max(event_id),0) AS id FROM event').get().id;
  return summary && !summary.invalid && summary.last === last ? summary : null;
}
import { FLOW_REPORT_VERSION } from './stats-flow-report.js';
