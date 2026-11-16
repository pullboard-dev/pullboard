/** Local, rebuildable per-cause Rigor projection with a bounded read-only compatibility tail [D1,N19]. */
import { advanceRigorCounter } from '../logic/counter.js';
import { rigorCounterChange } from '../logic/counter.js';
import { rigorCounterEligible } from '../logic/counter.js';
import { rigorCounterKeys } from '../logic/counter.js';
import { rigorCounterResult } from '../logic/counter.js';
import { sortRigorCounters } from '../logic/counter.js';
import { undraftedRigor } from '../logic/notices.js';
import { readRigorSource } from '../../../store/index.js';
import { automaticRigorNeeds } from '../../../store/index.js';
import { causeReading } from '../../../store/index.js';
import { rigorDerived } from './derived.js';
import { createHash } from 'node:crypto';

const PREFIX = 'local:proof-stats:rigor:v1:';
export const RIGOR_TAIL_LIMIT = 256;
export const RIGOR_COLD_NOTICE = 'The repeats are computed from the full history because this board has no current summary yet.';

/** Preserve legacy decoded numeric values; JSON-valid historical exponents can become non-finite in JavaScript. */
function encode(value) {
  const numbers = [];
  /** Keep non-finite markers outside user values, so no historical detail shape can collide with them. */
  const visit = (field, path) => {
    if (typeof field === 'number' && !Number.isFinite(field)) { numbers.push([path, String(field)]); return null; }
    if (Array.isArray(field)) return field.map((child, index) => visit(child, [...path, index]));
    if (field && typeof field === 'object') return Object.fromEntries(Object.entries(field).map(([key, child]) => [key, visit(child, [...path, key])]));
    return field;
  };
  return JSON.stringify({ data: visit(value, []), numbers });
}

/** Restore only the projection-owned marker paths, following the existing proof-counter codec convention. */
function decode(text) {
  const { data, numbers } = JSON.parse(text);
  for (const [path, value] of numbers) {
    let parent = data;
    for (const key of path.slice(0, -1)) parent = parent[key];
    parent[path.at(-1)] = Number(value);
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

/** Read one projection-owned JSON record, separately from authoritative board metadata. Why: with the derived-database setting on, the rows live there and board_meta holds none (#8911). */
function get(board, key) {
  const derived = rigorDerived(board);
  if (derived) {
    const row = statement(board.db, `SELECT meta_value FROM ${derived}.rigor_counter WHERE meta_key=?`).get(PREFIX + key);
    return row ? decode(row.meta_value) : null;
  }
  const row = statement(board.db, 'SELECT meta_value FROM board_meta WHERE meta_key=?').get(PREFIX + key);
  return row ? decode(row.meta_value) : null;
}

/** Replace only the cause affected by a new event, not the accumulated event log. */
function put(board, key, value) {
  const derived = rigorDerived(board);
  if (derived) {
    statement(board.db, `INSERT INTO ${derived}.rigor_counter(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value`)
      .run(PREFIX + key, encode(value));
    return;
  }
  statement(board.db, 'INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run(PREFIX + key, encode(value));
}

/** Version two excludes legacy conflict pseudo-tests; an old writer cannot make that stale summary current. */
function emptySummary(person) { return { version: 2, person, last: 0, active: [], invalid: false }; }

/** Writer and reader agree on the projection version and its structurally valid recorded cursor. */
function validSummary(summary, person) {
  return summary?.version === 2 && summary.person === person && Number.isSafeInteger(summary.last) && summary.last >= 0
    && Array.isArray(summary.active) && summary.active.every(key => typeof key === 'string');
}

/** Separate scalar qualification from per-item and per-commit history, which grows independently. */
function emptyHeader(key) {
  return { key, reads: causeReading(key), occurrences: 0, healthOccurrences: 0, flakeOccurrences: 0,
    neverAgain: false, itemCount: 0, multiCommit: false, latestItemAt: 0, declinedAt: null };
}

/** JSON preserves every accepted JavaScript cause string, including a historical lone surrogate. */
function shardKey(key) { return `cause:${encodeURIComponent(JSON.stringify(key))}`; }

/** Decode only our own derived metadata key, never infer cause identity from surrounding prose. */
function causeFromShard(key) { return JSON.parse(decodeURIComponent(key.slice('cause:'.length))); }

/** A cursor makes the person's decline exact without rewriting a growing set of old item ids. */
function headerEligible(header) {
  return Boolean((header.neverAgain || header.healthOccurrences >= 2 || header.flakeOccurrences >= 2
    || header.itemCount >= 2 || header.multiCommit) && (header.declinedAt === null || header.latestItemAt > header.declinedAt));
}

/** Primitive commit identity matches Set; distinct decoded historical objects remain distinct occurrences. */
function commitKey(value, eventId) {
  return typeof value === 'object' ? `event:${eventId}`
    : createHash('sha256').update(encode([typeof value, value])).digest('hex');
}

/** Fold one durable event with only scalar/header and affected item/commit writes. */
function persist(board, summary, event, person) {
  let keys = [];
  if (!summary.invalid) {
    try { keys = rigorCounterKeys(event, person); }
    catch (error) {
      // Only malformed historical JSON or an actual null detail can make this derived fold unusable.
      // Database and programming failures remain visible; the legacy reader retains its original failure.
      if (!(error instanceof SyntaxError) && !(error instanceof TypeError && JSON.parse(event.event_detail) === null)) throw error;
      summary.invalid = true;
    }
  }
  for (const key of keys) {
    const base = shardKey(key) + ':';
    const header = get(board, base + 'header') ?? emptyHeader(key);
    const change = rigorCounterChange(key, event, person);
    if ((change.never || change.caused) && event.item_id !== null) {
      const itemKey = base + `item:${event.item_id}`;
      let item = get(board, itemKey);
      if (!item) {
        item = { id: event.item_id, firstSeenAt: event.event_id, commits: 0 };
        header.itemCount += 1;
        header.latestItemAt = event.event_id;
      }
      if (change.caused && !change.never && change.commit) {
        const identity = base + `commit:${event.item_id}:` + commitKey(change.commit, event.event_id);
        if (!get(board, identity)) {
          put(board, identity, { id: event.item_id, value: change.commit });
          item.commits += 1;
          if (item.commits >= 2) header.multiCommit = true;
        }
      }
      put(board, itemKey, item);
    }
    if (change.never) header.neverAgain = true;
    else if (change.caused) {
      header.occurrences += 1;
      if (event.event_kind === 'flake-observation') header.flakeOccurrences += 1;
      if (['health-failure', 'sentinel-failure'].includes(event.event_kind)) header.healthOccurrences += 1;
    }
    if (change.declined) header.declinedAt = event.event_id;
    put(board, base + 'header', header);
    const index = summary.active.indexOf(key);
    if (headerEligible(header)) { if (index < 0) summary.active.push(key); }
    else if (index >= 0) summary.active.splice(index, 1);
  }
  summary.last = event.event_id;
  put(board, 'summary', summary);
}

/** Keep only currently actionable cause keys on the hot path; single failures remain separate shards. */
function fold(summary, event, read, write, person, drafted = new Set()) {
  for (const key of rigorCounterKeys(event, person)) {
    if (drafted.has(key)) continue;
    const shard = shardKey(key);
    const cause = advanceRigorCounter(read(shard), key, event, person);
    write(shard, cause);
    const index = summary.active.indexOf(key);
    if (rigorCounterEligible(cause)) { if (index < 0) summary.active.push(key); }
    else if (index >= 0) summary.active.splice(index, 1);
  }
  summary.last = event.event_id;
}

/** Append alongside the native event; replayed proof-counter history cannot double-count a cause. */
export function appendRigorCounter(board, event, person = 'person') {
  let summary = get(board, 'summary');
  // A first current-writer append on an old board must include all earlier events, not skip them.
  if (!validSummary(summary, person)) { ensureRigorCounters(board, person); summary = get(board, 'summary'); }
  if (event.event_id <= summary.last) return;
  const first = statement(board.db, 'SELECT event_id FROM event WHERE event_id>? ORDER BY event_id LIMIT 1').get(summary.last);
  if (first?.event_id !== event.event_id) {
    // A present older-writer summary also needs its entire gap before this new append can be current.
    ensureRigorCounters(board, person);
    return;
  }
  persist(board, summary, event, person);
}

/** Rebuild batches on an existing writable initialization/import path, never a steady resume read. */
export function ensureRigorCounters(board, person = 'person') {
  board.db.exec('SAVEPOINT rigor_projection');
  try {
    let summary = get(board, 'summary');
    const last = board.db.prepare('SELECT coalesce(max(event_id),0) AS id FROM event').get().id;
    if (!validSummary(summary, person) || summary.last > last) {
      const derived = rigorDerived(board);
      if (derived) board.db.prepare(`DELETE FROM ${derived}.rigor_counter WHERE meta_key GLOB ?`).run(PREFIX + '*');
      board.db.prepare('DELETE FROM board_meta WHERE meta_key GLOB ?').run(PREFIX + '*');
      summary = emptySummary(person);
      put(board, 'summary', summary);
    }
    const query = board.db.prepare('SELECT * FROM event WHERE event_id>? ORDER BY event_id LIMIT 256');
    while (true) {
      const batch = query.all(summary.last);
      if (!batch.length) break;
      for (const event of batch) persist(board, summary, event, person);
    }
    board.db.exec('RELEASE rigor_projection');
  } catch (error) {
    board.db.exec('ROLLBACK TO rigor_projection; RELEASE rigor_projection');
    throw error;
  }
}

/** Read one indexed metadata prefix; arbitrary cause text is never interpreted as a glob pattern. */
function records(board, prefix) {
  const derived = rigorDerived(board);
  if (derived) {
    return statement(board.db, `SELECT meta_value FROM ${derived}.rigor_counter WHERE meta_key>=? AND meta_key<? ORDER BY meta_key`)
      .all(PREFIX + prefix, PREFIX + prefix + '\uffff').map(row => decode(row.meta_value));
  }
  return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key>=? AND meta_key<? ORDER BY rowid')
    .all(PREFIX + prefix, PREFIX + prefix + '\uffff').map(row => decode(row.meta_value));
}

/** Materialize item/commit history only for an actionable output cause or a cause touched by the bounded tail. */
function readCause(board, key) {
  const base = shardKey(key) + ':';
  const header = get(board, base + 'header');
  if (!header) return null;
  const rows = records(board, base + 'item:');
  const items = rows.map(row => ({ id: row.id, commits: [] }));
  const byId = new Map(items.map(item => [item.id, item]));
  for (const commit of records(board, base + 'commit:')) byId.get(commit.id)?.commits.push(commit.value);
  return { ...header, items, seen: rows.map(row => row.id),
    declined: header.declinedAt === null ? null : rows.filter(row => row.firstSeenAt <= header.declinedAt).map(row => row.id) };
}

/** Live or approved typed rows suppress the exact cause; standard doctrine is not a local draft. */
function draftedCauses(state, drafts, decisions) {
  const rows = [...(state.spec ?? []), ...(state.practice ?? []).filter(row => row.origin !== 'standard')];
  const keys = new Set(rows.filter(row => row.decision?.decision === 'approve'
    || (!row.decision && ['draft', 'pending', 'approved'].includes(row.status)))
    .map(row => readRigorSource(row.source)?.key).filter(Boolean));
  for (const need of automaticRigorNeeds(state, drafts, decisions)) keys.add(need.cause);
  return keys;
}

/** A cold or beyond-bound older-writer board remains complete and visibly outside the steady bound. */
function coldRigor(board, state, options) {
  const history = board.db.prepare('SELECT event_id,event_at,event_by,event_kind,item_id,event_detail FROM event ORDER BY event_id').all();
  return { causes: undraftedRigor(history, state, options), notice: RIGOR_COLD_NOTICE };
}

/** Read eligible compact shards plus at most 256 indexed events; never silently extend an unbounded tail. */
function readResumeRigorCounters(board, state, { person = 'person', drafts = [], decisions = [] } = {}) {
  const options = { person, drafts, decisions };
  const stored = get(board, 'summary');
  if (!validSummary(stored, person) || stored.invalid) return coldRigor(board, state, options);
  const summary = structuredClone(stored);
  const last = board.db.prepare('SELECT coalesce(max(event_id),0) AS id FROM event').get().id;
  if (summary.last > last) return coldRigor(board, state, options);
  const tail = board.db.prepare('SELECT * FROM event WHERE event_id>? ORDER BY event_id LIMIT 257').all(summary.last);
  if (tail.length > RIGOR_TAIL_LIMIT) return coldRigor(board, state, options);
  const changed = new Map();
  const drafted = draftedCauses(state, drafts, decisions);
  /** Read a cause once from the database and thereafter from this bounded in-memory tail. */
  const read = key => changed.has(key) ? changed.get(key) : readCause(board, causeFromShard(key));
  for (const event of tail) fold(summary, event, read, (key, value) => changed.set(key, value), person, drafted);
  const causes = [];
  for (const key of summary.active) {
    if (drafted.has(key)) continue;
    const cause = read(shardKey(key));
    if (!cause) return coldRigor(board, state, options);
    if (rigorCounterEligible(cause)) causes.push(rigorCounterResult(cause));
  }
  return { causes: sortRigorCounters(causes), notice: null };
}

/** Cursor, cause shards and bounded tail must belong to one read snapshot even during another writer's append. */
export function resumeRigorCounters(board, state, options) {
  board.db.exec('SAVEPOINT rigor_read');
  try {
    const result = readResumeRigorCounters(board, state, options);
    board.db.exec('RELEASE rigor_read');
    return result;
  } catch (error) {
    board.db.exec('ROLLBACK TO rigor_read; RELEASE rigor_read');
    throw error;
  }
}
