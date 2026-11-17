import { CAPACITY_VERSION } from '../../../../stats/light.js';
import { emptyCapacityCounter } from '../../../../stats/light.js';
import { appendCapacityCounter } from '../../../../stats/light.js';
import { refreshCapacity } from '../../../../stats/light.js';
import { appendReportCounter } from '../../../../stats/light.js';
import { emptyReportCounter } from '../../../../stats/light.js';
import { reportEvent } from '../../../../stats/light.js';
import { newReportPolicy } from '../../../../stats/light.js';
import { NATIVE_FLAKE_ENGINE } from '../../../../state/light.js';
/** Rebuildable, local proof projections maintained with the event that produced them [R1,R2]. */
import { moveFlowItem } from '../../../../stats/light.js';
import { roleOf } from '../../../../stats/light.js';
import { appendRuleProof } from '../rule/proof/append.js';
import { deleteDerived } from './derived.js';
import { derivedOn } from './derived.js';
import { derivedText } from './derived.js';
import { derivedTextRows } from './derived.js';
import { writeDerived } from './derived.js';

export const PROOF_COUNTER_PREFIX = 'local:proof-stats:';
const PREFIX = `${PROOF_COUNTER_PREFIX}v2:`;
/** This code's flow report namespace: each FLOW_REPORT_VERSION keeps its projections and cursor under its own folder, so writers on different versions never touch each other's keys (#2288). It sits inside PROOF_COUNTER_PREFIX, so the board exchange treats it as local derived state and never exports it. */
const REPORT_FOLDER = `report-v${FLOW_REPORT_VERSION}:`;

/** The stored key of a counter: the report's `report-*` keys live in this version's folder, every other key as named. */
function stored(key) {
  return PREFIX + (key.startsWith('report-') ? REPORT_FOLDER + key.slice('report-'.length) : key);
}
const REPLAYING = new WeakSet();

/**
 * Whether a shard is plain JSON data with only finite numbers: such a shard encodes with one stringify and no copy [C7].
 * A non-finite number or an object with its own JSON form (a date) takes the copying path.
 */
function plain(field) {
  if (typeof field === 'number') return Number.isFinite(field);
  if (field === null || typeof field !== 'object') return true;
  if (Array.isArray(field)) { for (const child of field) if (!plain(child)) return false; return true; }
  const proto = Object.getPrototypeOf(field);
  if (proto !== Object.prototype && proto !== null || typeof field.toJSON === 'function') return false;
  for (const key in field) if (!plain(field[key])) return false;
  return true;
}

/** Encode non-finite timestamps with external paths, so user detail objects cannot collide with markers. */
function encode(value) {
  if (value !== undefined && plain(value)) return `{"data":${JSON.stringify(value)},"numbers":[]}`;
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

/** Prepared statements by connection and text. Why: a counter catch-up reads and writes a shard several times per event, and preparing each statement afresh was most of a 230,000-event replay (#6357). */
const STATEMENTS = new WeakMap();

/** The connection's prepared statement for this SQL, prepared once. */
function statement(db, sql) {
  let known = STATEMENTS.get(db);
  if (!known) {
    known = new Map(); STATEMENTS.set(db, known);
    // A prepared statement holds its connection natively, so a cached one kept every closed connection, and everything cached on it, in memory: drop them as the connection closes.
    const close = db.close;
    db.close = function closeAndForget(...args) { STATEMENTS.delete(db); return close.apply(this, args); };
  }
  let prepared = known.get(sql);
  if (!prepared) { prepared = db.prepare(sql); known.set(sql, prepared); }
  return prepared;
}

/** Keys a replay keeps decoded in memory: the report policy grows with the whole board, and the cursors are read and written by every event, so decoding and encoding them per event was most of a replay (#8562, #8818). */
const HOT_KEYS = new Set(['report-policy', 'summary', 'report-summary', 'capacity-summary']);
/** Key prefixes held decoded and kept for the whole replay: one actor and one family shard per seat and model, a bounded few that every event reads and writes. */
const HOT_PREFIXES = ['actor:', 'family:'];
/** Key prefixes held decoded until the next batch store: an item's shards are read and written by each of its few events, and each reader reads one, folds the event into it and writes it back. */
const ITEM_PREFIXES = ['item:', 'capacity-item:', 'report-item:'];
/** How many held shards a replay stores at once, so memory stays bounded however long the history. */
const HOT_FLUSH = 20_000;
/** How many rows one store statement carries; SQLite's limit is 32,766 values per statement. */
const STORE_ROWS = 100;

/** Whether a replay keeps this key decoded for the whole replay. */
function retained(key) { return HOT_KEYS.has(key) || HOT_PREFIXES.some(prefix => key.startsWith(prefix)); }
/** Whether a replay keeps this key decoded and hands every reader the one object: each reader folds an event into it and writes it back. */
function hotDecoded(key) { return retained(key) || ITEM_PREFIXES.some(prefix => key.startsWith(prefix)); }
/** Per connection, only while a replay runs: each hot key's decoded value (or, for a text key, its stored text) and whether it was stored since. */
const HOT = new WeakMap();

/**
 * Run a replay with the hot keys held in memory, storing each once when the outermost replay ends [C7].
 * Why: the stored text is the last value written, so one store at the end leaves the same rows as one per event.
 * The store runs even when the replay fails, so the report cursor never gets ahead of the policy it was folded with.
 */
function replayHot(board, work) {
  const db = board.db;
  if (HOT.has(db)) return work();
  HOT.set(db, new Map());
  let failure;
  try { return work(); } catch (error) { failure = { error }; throw error; } finally {
    const held = HOT.get(db);
    HOT.delete(db);
    try { storeHeld(board, held); } catch (error) { if (!failure) throw error; }
  }
}

/** Store every changed held shard, in the order each was first held, so new rows keep their order of arrival. */
function storeHeld(board, held) {
  const changed = [];
  for (const [key, entry] of held) if (entry.dirty) changed.push(stored(key), entry.text ?? encode(entry.value));
  storeRows(board, changed);
}

/** Drop held shards whose key starts with this prefix, because the caller just deleted their rows. */
function dropHeld(board, prefix) {
  const held = HOT.get(board.db);
  if (held) for (const key of [...held.keys()]) if (key.startsWith(prefix)) held.delete(key);
}

/** Read a single small derived record; none of these keys is exported native state. */
export function proofCounter(board, key) {
  const held = HOT.get(board.db);
  if (held && hotDecoded(key)) {
    let entry = held.get(key);
    if (!entry) { entry = { value: readCounter(board, key), dirty: false }; held.set(key, entry); }
    return entry.value;
  }
  if (held) {
    let entry = held.get(key);
    if (!entry) {
      const text = storedText(board, key);
      if (text === null) return null;
      entry = { text, dirty: false }; held.set(key, entry);
    }
    return decode(entry.text);
  }
  return readCounter(board, key);
}

/** Read one counter from the derived database, decoded; null when the setting is off or the row is absent. Why: slice 2 moves readers here; board_meta still serves every ordinary read in this slice [C7]. */
export function derivedProofCounter(board, key) {
  const text = derivedText(board, stored(key));
  return text === null ? null : decode(text);
}

/** Read and decode one stored record. */
function readCounter(board, key) {
  const text = storedText(board, key);
  return text === null ? null : decode(text);
}

/** One counter's stored text, from the derived database when PULLBOARD_PROOF_DERIVED_DB is on and from board_meta otherwise; null when absent [C7]. */
function storedText(board, key) {
  if (derivedOn(board)) return derivedText(board, stored(key));
  return statement(board.db, 'SELECT meta_value FROM board_meta WHERE meta_key=?').get(stored(key))?.meta_value ?? null;
}

/** Replace one affected shard without rewriting the board's accumulated history. */
function put(board, key, value) {
  const held = HOT.get(board.db);
  if (held && hotDecoded(key)) { held.set(key, { value, dirty: true }); return; }
  if (held) {
    held.set(key, { text: encode(value), dirty: true });
    if (held.size > HOT_FLUSH) {
      // Store and release the shards read by key only; the policy, the cursors and the actors stay held.
      storeHeld(board, held);
      for (const [name, entry] of held) if (!retained(name)) held.delete(name); else entry.dirty = false;
    }
    return;
  }
  storeText(board, key, encode(value));
}

/** Store one shard's encoded text now. */
function storeText(board, key, text) { storeRows(board, [stored(key), text]); }

/** Store rows given as flat key, text pairs, many per statement: most of a replay's store time was the call into SQLite for each row. */
function storeRows(board, pairs) {
  const rows = pairs.length / 2;
  writeDerived(board, pairs);
  for (let at = 0; at < rows; at += STORE_ROWS) {
    const count = Math.min(STORE_ROWS, rows - at);
    statement(board.db, storeSql(count)).run(...(rows <= STORE_ROWS ? pairs : pairs.slice(at * 2, (at + count) * 2)));
  }
}

/** The store statement's text for this many rows, built once: assembling a 100-row statement per call cost as much as running it. */
const STORE_SQL = [];
function storeSql(count) {
  return STORE_SQL[count] ??= `INSERT INTO board_meta(meta_key,meta_value) VALUES ${Array(count).fill('(?,?)').join(',')} ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value`;
}

/** The kinds whose shards are written once, one per event, and never rewritten: what a reader may keep. */
const APPEND_ONLY_KINDS = new Set(['event']);
/** Each board file's kept append-only shards, decoded, with the rowid and key of the last one read. */
const keptShards = new Map();

/**
 * Read one kind of projection in event insertion order, preserving historical tie ordering.
 *
 * An append-only kind is kept decoded per board file and read again only past the last row kept [C7]. Why: the
 * per-event shards number one per board event, and decoding all of them on every state build cost most of a build.
 * The kept rows are checked by their first and last rowid and key, so a cleared and rebuilt projection is read anew.
 * Readers share the kept rows and only read them.
 */
export function proofCounterRows(board, kind) {
  const file = APPEND_ONLY_KINDS.has(kind) && typeof board.db.location === 'function' ? board.db.location() : null;
  const prefix = stored(`${kind}:`);
  if (derivedOn(board)) return derivedTextRows(board, prefix).map(decode);
  if (!file) return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key GLOB ? ORDER BY rowid').all(`${prefix}*`)
    .map(row => decode(row.meta_value));
  const id = `${file}\0${kind}`;
  let kept = keptShards.get(id);
  const at = board.db.prepare('SELECT meta_key FROM board_meta WHERE rowid = ?');
  if (kept && (at.get(kept.firstRowid)?.meta_key !== kept.firstKey || at.get(kept.lastRowid)?.meta_key !== kept.lastKey)) kept = null;
  if (!kept) kept = { rows: [], firstRowid: 0, firstKey: null, lastRowid: 0, lastKey: null };
  const added = board.db.prepare('SELECT rowid, meta_key, meta_value FROM board_meta WHERE rowid > ? AND meta_key GLOB ? ORDER BY rowid').all(kept.lastRowid, `${prefix}*`);
  if (added.length) {
    kept = { ...kept, rows: kept.rows.concat(added.map(row => decode(row.meta_value))), lastRowid: added.at(-1).rowid, lastKey: added.at(-1).meta_key };
    if (kept.firstKey === null) Object.assign(kept, { firstRowid: added[0].rowid, firstKey: added[0].meta_key });
  }
  keptShards.set(id, kept);
  return kept.rows.slice();
}

/**
 * Remove local projections without modifying any native event or verdict. Every flow report folder survives, this
 * version's and any other's: each belongs to the writers of its own version, and deleting one only to rebuild it made
 * mixed-version writers replay all history in turn (#2288).
 */
export function clearProofCounters(board) {
  board.db.prepare('DELETE FROM board_meta WHERE meta_key GLOB ? AND meta_key NOT GLOB ?').run(`${PROOF_COUNTER_PREFIX}*`, `${PREFIX}report-*`);
  deleteDerived(board, `${PROOF_COUNTER_PREFIX}*`, `${PREFIX}report-*`);
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
  const keepReport = ensureReportCounters(board, summary.last);
  ensureCapacityCounters(board, summary.last);
  board.onProofStatsEvent?.(event);
  let detail;
  try { detail = JSON.parse(event.event_detail); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; summary.invalid = true; }
  if (detail === null || detail === undefined) summary.invalid = true;
  const at = Date.parse(event.event_at);
  if (!Number.isFinite(at)) summary.invalid = true;
  summary.last = event.event_id;
  if (summary.invalid) { put(board, 'summary', summary); put(board, 'capacity-summary', { ...emptyCapacityCounter(), invalid: true, last: event.event_id }); return; }
  if (summary.firstEventAt === null || at < Date.parse(summary.firstEventAt)) summary.firstEventAt = event.event_at;
  if (summary.lastEventAt === null || at >= Date.parse(summary.lastEventAt)) summary.lastEventAt = event.event_at;
  if (keepReport) appendReportCounter(event, detail, at, key => proofCounter(board, key), (key, value) => put(board, key, value));
  appendCapacityCounter(event, detail, at, key => proofCounter(board, key), (key, value) => put(board, key, value));
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
  // The capacity forecast is derived off the write lock (#2578): refreshCapacityOutsideWrite, from background maintenance.
}

/** Refresh the derived forecast using bounded indexed sample dates, never native history. */
function refreshCapacityCache(board, options) {
  options = { presence: board.runtimePorts?.verification?.withLocalSeatPresence, ...options };
  refreshCapacity(board, key => proofCounter(board, key), (key, value) => put(board, key, value),
    (kind, from, to) => kind !== 'capacity-sample' ? proofCounterRows(board, kind) : board.db.prepare(
      'SELECT meta_value FROM board_meta WHERE meta_key>=? AND meta_key<? ORDER BY meta_key')
      .all(`${PREFIX}capacity-sample:${new Date(from).toISOString().slice(0, 10)}`, `${PREFIX}capacity-sample:${new Date(to).toISOString().slice(0, 10)}`)
      .map(row => decode(row.meta_value)), options);
}

/**
 * Refresh the capacity forecast without holding the board's write lock: plan from plain reads, then store the
 * few resulting rows in one short transaction through `atomic`. Why: the plan runs a Monte Carlo and a weekly
 * refit; inside a move it held every writer and reader's lock for seconds (#2578). Returns the keys it stored.
 */
export function refreshCapacityOutsideWrite(board, atomic, options) {
  const writes = new Map();
  const read = key => writes.has(key) ? writes.get(key) : proofCounter(board, key);
  options = { presence: board.runtimePorts?.verification?.withLocalSeatPresence, ...options };
  refreshCapacity(board, read, (key, value) => writes.set(key, value),
    (kind, from, to) => kind !== 'capacity-sample' ? proofCounterRows(board, kind) : board.db.prepare(
      'SELECT meta_value FROM board_meta WHERE meta_key>=? AND meta_key<? ORDER BY meta_key')
      .all(`${PREFIX}capacity-sample:${new Date(from).toISOString().slice(0, 10)}`, `${PREFIX}capacity-sample:${new Date(to).toISOString().slice(0, 10)}`)
      .map(row => decode(row.meta_value)), options);
  if (writes.size) atomic(board, () => { for (const [key, value] of writes) put(board, key, value); }, { reviewPolicy: false });
  return [...writes.keys()];
}

/** Optional capacity migration has its own cursor so older writers cannot silently omit events. */
function ensureCapacityCounters(board, until) {
  let summary = proofCounter(board, 'capacity-summary');
  if (!summary || summary.version !== CAPACITY_VERSION) {
    board.db.prepare('DELETE FROM board_meta WHERE meta_key GLOB ?').run(`${PREFIX}capacity-*`);
    deleteDerived(board, `${PREFIX}capacity-*`);
    dropHeld(board, 'capacity-');
    summary = emptyCapacityCounter(); put(board, 'capacity-summary', summary);
  }
  if (summary.last >= until || summary.invalid) return;
  const query = board.db.prepare('SELECT * FROM event WHERE event_id>? AND event_id<=? ORDER BY event_id LIMIT 256');
  let cursor = summary.last;
  while (true) {
    const batch = query.all(cursor, until);
    if (!batch.length) return;
    for (const event of batch) {
      let detail;
      try { detail = JSON.parse(event.event_detail); } catch { detail = null; }
      const at = Date.parse(event.event_at);
      if (detail === null || !Number.isFinite(at)) { put(board, 'capacity-summary', { ...summary, invalid: true }); return; }
      appendCapacityCounter(event, detail, at, key => proofCounter(board, key), (key, value) => put(board, key, value));
      cursor = event.event_id;
    }
  }
}

/** Fully consume bounded read batches before writing shards, including on Node22.13's SQLite API. */
function replayProofTail(board, cursor) {
  const nested = REPLAYING.has(board);
  REPLAYING.add(board);
  try {
    const read = board.db.prepare('SELECT * FROM event WHERE event_id>? ORDER BY event_id LIMIT 256');
    replayHot(board, () => {
      while (true) {
        const batch = read.all(cursor);
        if (!batch.length) break;
        for (const event of batch) { appendProofCounter(board, event); cursor = event.event_id; }
      }
    });
  } finally { if (!nested) REPLAYING.delete(board); }
}

/** Reset only this version's report folder; preserve established proof shards and every other version's report. */
function resetReportCounters(board) {
  board.db.prepare('DELETE FROM board_meta WHERE meta_key GLOB ?').run(`${PREFIX}${REPORT_FOLDER}*`);
  deleteDerived(board, `${PREFIX}${REPORT_FOLDER}*`);
  dropHeld(board, 'report-');
  put(board, 'report-summary', emptyReportCounter());
  put(board, 'report-policy', newReportPolicy());
}

/**
 * Catch up only the events this version's report folder missed, without recounting other statistics or touching another
 * version's folder, so old and new worktrees never replay history in turn under the board lock. Returns true: this code
 * always keeps its own report.
 */
function ensureReportCounters(board, until) {
  let summary = proofCounter(board, 'report-summary');
  if (!summary || summary.version !== FLOW_REPORT_VERSION) {
    resetReportCounters(board);
    summary = proofCounter(board, 'report-summary');
  }
  if (summary.last >= until || summary.invalid) return true;
  const read = board.db.prepare('SELECT * FROM event WHERE event_id>? AND event_id<=? ORDER BY event_id LIMIT 256');
  let cursor = summary.last;
  return replayHot(board, () => {
    while (true) {
      const batch = read.all(cursor, until);
      if (!batch.length) return true;
      for (const event of batch) {
        let detail;
        try { detail = JSON.parse(event.event_detail); } catch { detail = null; }
        const at = Date.parse(event.event_at);
        if (detail === null || !Number.isFinite(at)) {
          put(board, 'report-summary', { ...summary, invalid: true });
          return true;
        }
        board.onFlowReportEvent?.(event);
        appendReportCounter(event, detail, at, key => proofCounter(board, key), (key, value) => put(board, key, value));
        cursor = event.event_id;
      }
    }
  });
}

/**
 * Rebuild from authoritative history inside the caller's existing write transaction.
 * refresh: false leaves the capacity forecast to background maintenance, so a rebuild
 * under the write lock never runs the forecast (#2578).
 */
export function rebuildProofCounters(board, { refresh = true } = {}) {
  const { ensureRigorCounters } = board.runtimePorts.verification;
  clearProofCounters(board);
  ensureRigorCounters(board);
  put(board, 'summary', emptySummary());
  resetReportCounters(board);
  replayProofTail(board, 0);
  ensureCapacityCounters(board, proofCounter(board, 'summary').last);
  if (refresh) refreshCapacityCache(board, { force: true });
}

/** Catch up an older writer once; ordinary current-writer appends then decode only their new event. */
export function ensureProofCounters(board, { refresh = true } = {}) {
  const { ensureRigorCounters } = board.runtimePorts.verification;
  ensureRigorCounters(board);
  const summary = proofCounter(board, 'summary');
  if (!summary) { rebuildProofCounters(board, { refresh }); return; }
  ensureReportCounters(board, summary.last);
  ensureCapacityCounters(board, summary.last);
  replayProofTail(board, summary.last);
  if (refresh) refreshCapacityCache(board);
}

/** Readers never take a write lock to warm or repair a derived cache. */
export function currentProofCounters(board) {
  const summary = proofCounter(board, 'summary');
  const last = board.db.prepare('SELECT coalesce(max(event_id),0) AS id FROM event').get().id;
  return summary && !summary.invalid && summary.last === last ? summary : null;
}
import { FLOW_REPORT_VERSION } from '../../../../stats/light.js';
