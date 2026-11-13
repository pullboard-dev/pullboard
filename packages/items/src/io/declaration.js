/**
 * A seat's vendor family is ONE derived value (#1783): the first non-blank family ever recorded, in board order, by any
 * register, join, family or receipt record for that seat or for any seat sharing its original session. Nothing clears
 * it: a null, blank or later family is history, not a new declaration. Every family read and check goes through
 * `seatFamily`, so no decision reads the stored column (which only records the latest join's value for display and for
 * replaying engines older than the declaration engine) [V4,B26,H16].
 */
import { FAMILY_DECLARE_ENGINE } from "../../../state/light.js";
import { createHash } from 'node:crypto';
import { ACTIVE } from '../logic/declaration/derived.js';
import { AGENT_KEY } from '../logic/declaration/derived.js';
import { FAMILY_SCOPES } from '../logic/declaration/derived.js';
import { derivedFamily } from '../logic/declaration/derived.js';
import { prepared } from '../logic/declaration/derived.js';
import { familySnapshot } from '../logic/declaration/derived.js';
import { namesFamily } from '../logic/declaration/derived.js';
import { parsed } from '../logic/declaration/derived.js';
import { seatRecords } from '../logic/declaration/derived.js';
import { sessionSnapshot } from '../logic/declaration/derived.js';
import { familyDeclareFloor as declareFloor } from '../logic/declaration/derived.js';
export { derivedFamily, namesFamily, originalSession, withFamilyReads } from '../logic/declaration/derived.js';

/** The first ordered move at the declaration engine fences every later fresh registration to that engine. */
export function recordFamilyDeclareActivation(board, engine) {
  if (engine < FAMILY_DECLARE_ENGINE) return;
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO NOTHING').run(ACTIVE, String(FAMILY_DECLARE_ENGINE));
}

/**
 * The family every read and check uses. At and after the declaration engine it is the one derived value; a move
 * replaying under an older engine keeps that engine's recorded semantics, which read the seat row.
 */
export function seatFamily(board, id) {
  // Unset, the board runs this code's own engine, which includes the declaration engine.
  if ((board.executionEngineVersion ?? Infinity) >= FAMILY_DECLARE_ENGINE) {
    // Inside a read scope the bulk snapshot already holds every seat's family, so no per-seat projection query is needed (#3251).
    if (id && FAMILY_SCOPES.has(board.db)) return derivedFamily(board, id);
    const stored = storedFamily(board, id);
    if (stored !== undefined) return stored;
    const family = derivedFamily(board, id);
    // Only inside a transaction this command already holds, so recording never makes a read wait for the write lock.
    if (board.db.isTransaction === true) recordFamily(board, id, family);
    return family;
  }
  return board.db.prepare('SELECT agent_family AS family FROM agent WHERE agent_id = ?').get(id)?.family ?? null;
}

/** The registration floor with this host's SHA-256 behind the pure port. */
export function familyDeclareFloor(board, who) {
  return declareFloor(board, who, text => createHash('sha256').update(text).digest('hex'));
}

/**
 * Where a seat's declared family is recorded once it is known: a machine-local board key, so it is never exported
 * or relayed, and every board rebuilds it from the same ordered records.
 * Why: deriving it scans the seat's session peers, events and registration receipts, and every claim, renew and
 * review routing read it, several times per command on a board of a thousand seats (#2559).
 */
export const FAMILY_RECORD_PREFIX = 'local:family:';

/**
 * A seat's recorded family, or undefined when none is recorded for this exact seat row. A non-blank derived family
 * is final (nothing clears or replaces it), so a record never goes stale; it is tied to the seat's path so a forgotten
 * seat whose id is reused never inherits it.
 */
function storedFamily(board, id) {
  if (!id) return undefined;
  const value = prepared(board.db, 'SELECT meta_value FROM board_meta WHERE meta_key=?').get(FAMILY_RECORD_PREFIX + id)?.meta_value;
  if (value === undefined) return undefined;
  const record = parsed(value);
  if (!(record?.family === null || namesFamily(record?.family)) || typeof record.path !== 'string') return undefined;
  const path = prepared(board.db, 'SELECT agent_path FROM agent WHERE agent_id=?').get(id)?.agent_path;
  return path === record.path ? record.family : undefined;
}

/** Read a bounded group of projections with one query per SQLite parameter chunk. */
function storedFamilies(board, rows) {
  const result = new Map(), ids = [...new Set(rows.map(row => row?.agent_id).filter(Boolean))];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500), marks = chunk.map(() => '?').join(',');
    const values = board.db.prepare(`SELECT a.agent_id, a.agent_path, m.meta_value FROM agent a
      LEFT JOIN board_meta m ON m.meta_key = ? || a.agent_id WHERE a.agent_id IN (${marks})`).all(FAMILY_RECORD_PREFIX, ...chunk);
    for (const row of values) {
      const record = parsed(row.meta_value);
      if ((record?.family === null || namesFamily(record?.family)) && record.path === row.agent_path) result.set(row.agent_id, record.family);
    }
  }
  return result;
}

/**
 * Record a seat's family once it names one. A read-only board, or a read that cannot take the write lock now, leaves
 * it for the next writer: the family is the same whenever it is recorded.
 */
export function recordFamily(board, id, family) {
  if (!id || !(family === null || namesFamily(family))) return;
  try {
    const path = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(id)?.agent_path;
    if (typeof path !== 'string') return;
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
      .run(FAMILY_RECORD_PREFIX + id, JSON.stringify({ family, path }));
  } catch { /* A read-only or busy board records it on a later write. */ }
}

/** Forget only unresolved projections in the session whose first family was just declared. */
export function invalidateUnknownFamilies(board, session) {
  if (!session) return [];
  const ids = board.db.prepare(`SELECT meta_key FROM board_meta WHERE ${AGENT_KEY}
    AND meta_key LIKE 'agent\\_session:%' ESCAPE '\\' AND meta_value=? ORDER BY rowid`).all(session)
    .map(row => row.meta_key.slice('agent_session:'.length));
  const remove = board.db.prepare(`DELETE FROM board_meta WHERE meta_key=? AND json_valid(meta_value)
    AND json_type(meta_value, '$.family') = 'null'`);
  return ids.filter(id => Number(remove.run(FAMILY_RECORD_PREFIX + id).changes) > 0);
}

/** An agent row as every reader sees it: its `agent_family` is the one derived family, never the stored column. */
export function withDerivedFamily(board, row) {
  return row ? { ...row, agent_family: seatFamily(board, row.agent_id) } : row;
}

/** A few rows read only their own seats and session peers; larger sets read every seat in one pass. */
const SCOPED_ROWS = 512;

/** The snapshot shape familySnapshot returns, holding only these rows' seats, their sessions and their session peers. */
function scopedSnapshot(board, rows) {
  const sessions = new Map(), peers = new Map(), ids = new Set();
  const requested = [...new Set(rows.map(row => row?.agent_id).filter(Boolean))];
  for (let offset = 0; offset < requested.length; offset += 500) {
    const chunk = requested.slice(offset, offset + 500), marks = chunk.map(() => '?').join(',');
    for (const row of board.db.prepare(`SELECT meta_key, meta_value FROM board_meta WHERE meta_key IN (${marks})`).all(...chunk.map(id => 'agent_session:' + id))) {
      sessions.set(row.meta_key.slice('agent_session:'.length), row.meta_value);
    }
  }
  const members = board.db.prepare(`SELECT meta_key FROM board_meta WHERE ${AGENT_KEY} AND meta_key LIKE 'agent\\_session:%' ESCAPE '\\' AND meta_value=? ORDER BY rowid`);
  for (const row of rows) {
    const id = row?.agent_id;
    if (!id) continue;
    ids.add(id);
    const original = sessions.get(id);
    if (!original) continue;
    if (!peers.has(original)) peers.set(original, members.all(original).map(entry => entry.meta_key.slice('agent_session:'.length)));
    for (const peer of peers.get(original)) ids.add(peer);
  }
  return { ...sessionSnapshot(board, [...ids]), sessions, peers };
}

/** Agent rows share one read snapshot while retaining the ordinary single-seat and older-engine semantics. */
export function withDerivedFamilies(board, rows) {
  if (!rows.length) return [];
  if ((board.executionEngineVersion ?? Infinity) < FAMILY_DECLARE_ENGINE) return rows.map(row => {
    const derived = withDerivedFamily(board, row);
    return derived ? { ...derived, family: derived.agent_family } : derived;
  });
  const stored = storedFamilies(board, rows);
  // Seats whose family is recorded need no derivation; only the rest build a snapshot.
  if (rows.every(row => !row || stored.get(row.agent_id) !== undefined)) {
    return rows.map(row => row && { ...row, agent_family: stored.get(row.agent_id), family: stored.get(row.agent_id) });
  }
  const mayRecord = board.db.isTransaction === true && !board.readOnly;
  board.db.exec('SAVEPOINT family_bulk_read');
  try {
    const snapshot = rows.length <= SCOPED_ROWS ? scopedSnapshot(board, rows) : familySnapshot(board), records = new Map();
    return rows.map(row => {
      if (!row) return row;
      if (stored.get(row.agent_id) !== undefined) return { ...row, agent_family: stored.get(row.agent_id), family: stored.get(row.agent_id) };
      const id = row.agent_id, original = id ? snapshot.sessions.get(id) ?? null : null;
      // The requested seat comes first even when legacy records tie at LAST; ghost peer ids remain evidence.
      const seats = new Set(id ? [id] : []);
      if (original) for (const peer of snapshot.peers.get(original) ?? []) seats.add(peer);
      let first = null;
      for (const seat of seats) {
        if (!records.has(seat)) records.set(seat, seatRecords(board, seat, {}, snapshot));
        for (const record of records.get(seat)) if (!first || record.order < first.order) first = record;
      }
      const family = first?.family ?? null;
      if (mayRecord) recordFamily(board, id, family);
      return { ...row, agent_family: family, family };
    });
  } finally { board.db.exec('RELEASE family_bulk_read'); }
}

const FAMILY_PROJECTION_MARKER = FAMILY_RECORD_PREFIX + '@projection-v1';

/** Whether the family projection is already warm, so opening a current board needs no write lock (#2578). */
export function familyProjectionCurrent(board) {
  return !!board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(FAMILY_PROJECTION_MARKER);
}

/** Populate the local projection once on a writable board, including seats imported from older histories. */
export function warmFamilyProjection(board) {
  const marker = FAMILY_PROJECTION_MARKER;
  if (familyProjectionCurrent(board)) return;
  const rows = board.db.prepare('SELECT agent_id, agent_path, agent_family FROM agent').all();
  withDerivedFamilies(board, rows);
  const stored = storedFamilies(board, rows);
  if (rows.some(row => !stored.has(row.agent_id))) throw new Error('family projection was not recorded');
  board.db.prepare('INSERT INTO board_meta(meta_key, meta_value) VALUES (?, ?)').run(marker, '1');
}
