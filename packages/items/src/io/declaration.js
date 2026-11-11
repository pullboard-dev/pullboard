/**
 * A seat's vendor family is ONE derived value (#1783): the first non-blank family ever recorded, in board order, by any
 * register, join, family or receipt record for that seat or for any seat sharing its original session. Nothing clears
 * it: a null, blank or later family is history, not a new declaration. Every family read and check goes through
 * `seatFamily`, so no decision reads the stored column (which only records the latest join's value for display and for
 * replaying engines older than the declaration engine) [V4,B26,H16].
 */
import { FAMILY_DECLARE_ENGINE } from "../../../state/light.js";
import { createHash } from 'node:crypto';

const ACTIVE = 'family_declare:active';
const LAST = Number.MAX_SAFE_INTEGER;
const RECEIPTS = new WeakMap();
/**
 * Limit a LIKE on board_meta keys to the keys starting with one letter, in either case. LIKE keeps its historical
 * case-insensitive match. Why: the two ranges are index seeks, where a bare LIKE scanned every row, and nearly
 * all of the board's 150,000 keys are `local:` ones that can never match.
 */
function startsWith(letter) {
  return `((meta_key >= '${letter}' AND meta_key < '${String.fromCharCode(letter.charCodeAt(0) + 1)}') OR (meta_key >= '${letter.toUpperCase()}' AND meta_key < '${String.fromCharCode(letter.toUpperCase().charCodeAt(0) + 1)}'))`;
}
const AGENT_KEY = startsWith('a');
const RECEIPT_KEY = startsWith('r');

/** The first ordered move at the declaration engine fences every later fresh registration to that engine. */
export function recordFamilyDeclareActivation(board, engine) {
  if (engine < FAMILY_DECLARE_ENGINE) return;
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO NOTHING').run(ACTIVE, String(FAMILY_DECLARE_ENGINE));
}

/** True for a family that names a vendor; null, empty and whitespace-only declare nothing. */
export function namesFamily(value) { return typeof value === 'string' && value.trim() !== ''; }

/** Parse one recorded JSON detail; an unreadable detail records nothing. */
function parsed(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** The session digest a registration declares, null when it names none, or undefined when its value cannot be read. */
function declaredSession(who) {
  // The same digest domain and validation as parent-session.js, read without importing the registration module graph.
  if (who?.sessionDigest != null) return typeof who.sessionDigest === 'string' && /^[a-f0-9]{64}$/u.test(who.sessionDigest) ? who.sessionDigest : undefined;
  if (who?.session != null) {
    if (typeof who.session !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(who.session)) return undefined;
    return createHash('sha256').update(JSON.stringify(['parent-session', who.session])).digest('hex');
  }
  return null;
}

/** A seat's original session: its recorded session identity, or the one this join declares when none is recorded. */
export function originalSession(board, id, declared = null) {
  return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`agent_session:${id}`)?.meta_value ?? declared ?? null;
}

/**
 * The family each seat path's first ordered registration receipt named. Receipts are immutable once recorded, so
 * the index is rebuilt only when more receipts exist; it is read only for seats whose join event predates the
 * family field and whose family has since been changed, which is when the receipt is the first record.
 */
function receiptRegistrations(board) {
  const count = board.db.prepare(`SELECT COUNT(*) AS n FROM board_meta WHERE ${RECEIPT_KEY} AND meta_key LIKE 'relay\\_receipt\\_%' ESCAPE '\\'`).get().n;
  const cached = RECEIPTS.get(board.db);
  if (cached?.count === count) return cached.paths;
  const rows = [];
  for (const row of board.db.prepare(`SELECT meta_value FROM board_meta WHERE ${RECEIPT_KEY} AND meta_key LIKE 'relay\\_receipt\\_%' ESCAPE '\\' ORDER BY rowid`).all()) {
    const receipt = parsed(row.meta_value);
    const move = typeof receipt?.move === 'string' ? parsed(receipt.move) : null;
    if (move?.operation !== 'register' || receipt.outcome?.error || typeof move.args?.[0]?.path !== 'string') continue;
    rows.push({ sequence: receipt.sequence, path: move.args[0].path, family: move.args[0].family, seat: receipt.outcome?.result ?? null });
  }
  const paths = new Map();
  for (const row of rows.sort((left, right) => left.sequence - right.sequence)) if (!paths.has(row.path)) paths.set(row.path, row);
  RECEIPTS.set(board.db, { count, paths });
  return paths;
}

/** Every family record of one seat, each with its board order: the join (its own field, else its insert), then family events. */
function seatRecords(board, id, { inserting = false } = {}, snapshot = null) {
  const seat = snapshot ? snapshot.seats.get(id) : board.db.prepare('SELECT agent_path FROM agent WHERE agent_id = ?').get(id);
  const join = snapshot ? snapshot.joins.get(id) : board.db.prepare("SELECT event_id, event_detail FROM event WHERE +event_kind='join' AND event_by=? ORDER BY event_id LIMIT 1").get(id);
  const families = snapshot ? snapshot.families.get(id) ?? [] : board.db.prepare("SELECT event_id, event_detail FROM event WHERE +event_kind='family' AND event_by=? ORDER BY event_id").all(id)
    .map(row => ({ order: row.event_id, family: parsed(row.event_detail)?.family }));
  const records = [];
  const joined = join ? parsed(join.event_detail) : null;
  if (joined && Object.hasOwn(joined, 'family')) records.push({ order: join.event_id, family: joined.family });
  else if (!inserting && seat) {
    // A join recorded before the family field: with no family event since, the seat row still holds its insert
    // value; after a change, the first ordered registration receipt for its path is the first record.
    const receipt = families.length ? (snapshot ? snapshot.receipts() : receiptRegistrations(board)).get(seat.agent_path) : null;
    const insert = families.length ? (receipt && (receipt.seat === null || receipt.seat === id) ? receipt.family : undefined)
      : snapshot ? seat.agent_family : board.db.prepare('SELECT agent_family AS family FROM agent WHERE agent_id = ?').get(id)?.family;
    records.push({ order: join?.event_id ?? LAST, family: insert });
  }
  return [...records, ...families].filter(record => namesFamily(record.family));
}

/**
 * The one derived family of a seat: the first non-blank family recorded for it or any seat of its original session,
 * in board order, or null when none was ever recorded. `session` names the original session for a seat whose session
 * is being recorded by this very move; `inserting` leaves out the seat row a registration has only just inserted.
 */
export function derivedFamily(board, id, { session = null, inserting = false } = {}) {
  const scope = id && !session && !inserting ? FAMILY_SCOPES.get(board.db) : null;
  if (scope) return scopedFamily(board, scope, id);
  const original = id ? originalSession(board, id, session) : session;
  const seats = new Set(id ? [id] : []);
  if (original) for (const row of board.db.prepare(`SELECT meta_key FROM board_meta WHERE ${AGENT_KEY} AND meta_key LIKE 'agent\\_session:%' ESCAPE '\\' AND meta_value=? ORDER BY rowid`).all(original)) {
    seats.add(row.meta_key.slice('agent_session:'.length));
  }
  let first = null;
  // A long-lived session spans many seats; one read of just those seats replaces a per-seat scan of each one's events (#2421).
  const snapshot = seats.size > 1 ? sessionSnapshot(board, [...seats]) : null;
  for (const seat of seats) {
    for (const record of seatRecords(board, seat, { inserting: inserting && seat === id }, snapshot)) {
      if (!first || record.order < first.order) first = record;
    }
  }
  return first?.family ?? null;
}

/** Read scopes by db handle: the one bulk snapshot and the family already derived per seat inside a synchronous read. */
const FAMILY_SCOPES = new WeakMap();

/**
 * Run a synchronous, write-free read with every seat's derived family served from one bulk snapshot.
 * Why: a loop over all agent rows calling seatFamily paid two or three event queries per seat (1,921 seats, #3251);
 * the snapshot is read at most once, on the first seat asked, and dies with the scope so no write is ever missed.
 */
export function withFamilyReads(board, work) {
  const db = board.db;
  if (FAMILY_SCOPES.has(db)) return work();
  FAMILY_SCOPES.set(db, { snapshot: null, records: new Map(), derived: new Map() });
  try { return work(); } finally { FAMILY_SCOPES.delete(db); }
}

/** One seat's derived family from the scope's snapshot, with the same first-record rule as the per-seat read. */
function scopedFamily(board, scope, id) {
  if (scope.derived.has(id)) return scope.derived.get(id);
  scope.snapshot ??= familySnapshot(board);
  const snapshot = scope.snapshot, original = snapshot.sessions.get(id) ?? null;
  const seats = new Set([id]);
  if (original) for (const peer of snapshot.peers.get(original) ?? []) seats.add(peer);
  let first = null;
  for (const seat of seats) {
    if (!scope.records.has(seat)) scope.records.set(seat, seatRecords(board, seat, {}, snapshot));
    for (const record of scope.records.get(seat)) if (!first || record.order < first.order) first = record;
  }
  const family = first?.family ?? null;
  scope.derived.set(id, family);
  return family;
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
  const value = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(FAMILY_RECORD_PREFIX + id)?.meta_value;
  if (value === undefined) return undefined;
  const record = parsed(value);
  if (!(record?.family === null || namesFamily(record?.family)) || typeof record.path !== 'string') return undefined;
  const path = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(id)?.agent_path;
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

/**
 * The engine a fresh registration needs. Once a modern prefix is recorded, a registration must run the family rule
 * whenever it touches a derived family by any key: a seat it names by path or id, or a session (digest or raw id)
 * whose seats recorded one, whatever path, seat id or parent it carries. An unreadable session counts as declared.
 * Registrations of genuinely new seats and sessions, and boards with no modern prefix, keep their engine's rules.
 */
export function familyDeclareFloor(board, who) {
  if (!board?.db?.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(ACTIVE)) return 1;
  const seats = [
    typeof who?.path === 'string' ? board.db.prepare('SELECT agent_id FROM agent WHERE agent_path = ?').get(who.path)?.agent_id : null,
    typeof who?.id === 'string' ? board.db.prepare('SELECT agent_id FROM agent WHERE agent_id = ?').get(who.id)?.agent_id : null,
  ].filter(Boolean);
  if (seats.some(id => derivedFamily(board, id))) return FAMILY_DECLARE_ENGINE;
  const session = declaredSession(who);
  if (session === undefined || session && derivedFamily(board, null, { session })) return FAMILY_DECLARE_ENGINE;
  return 1;
}

/** An agent row as every reader sees it: its `agent_family` is the one derived family, never the stored column. */
export function withDerivedFamily(board, row) {
  return row ? { ...row, agent_family: seatFamily(board, row.agent_id) } : row;
}

/**
 * The family inputs of exactly these seats: their rows and their join and family events, by index.
 * Why: a seat's family read must not list every seat on the board, which every inbox and claim pays for (#2421).
 */
function sessionSnapshot(board, ids) {
  const seats = new Map(), joins = new Map(), families = new Map();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500), marks = chunk.map(() => '?').join(',');
    for (const row of board.db.prepare(`SELECT agent_id, agent_path, agent_family FROM agent WHERE agent_id IN (${marks})`).all(...chunk)) seats.set(row.agent_id, row);
    for (const row of board.db.prepare(`SELECT event_id, event_by, event_kind, event_detail FROM event WHERE event_kind IN ('join','family') AND event_by IN (${marks}) ORDER BY event_id`).all(...chunk)) {
      if (row.event_kind === 'join') { if (!joins.has(row.event_by) || joins.get(row.event_by).event_id > row.event_id) joins.set(row.event_by, row); }
      else {
        if (!families.has(row.event_by)) families.set(row.event_by, []);
        families.get(row.event_by).push({ order: row.event_id, family: parsed(row.event_detail)?.family });
      }
    }
  }
  for (const list of families.values()) list.sort((left, right) => left.order - right.order);
  let receipts;
  return { seats, joins, families,
    /** Read historical registration receipts at most once, only when a legacy changed seat needs them. */
    receipts() { return receipts ??= receiptRegistrations(board); } };
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

/** Collect read-local family inputs once; no derived authority survives this bulk read. */
function familySnapshot(board) {
  const seats = new Map(board.db.prepare('SELECT agent_id, agent_path, agent_family FROM agent').all().map(row => [row.agent_id, row]));
  const sessions = new Map(), peers = new Map(), joins = new Map(), families = new Map();
  for (const row of board.db.prepare(`SELECT meta_key, meta_value FROM board_meta WHERE ${AGENT_KEY} AND meta_key LIKE 'agent\\_session:%' ESCAPE '\\' ORDER BY rowid`).all()) {
    const id = row.meta_key.slice('agent_session:'.length);
    if (row.meta_key === 'agent_session:' + id) sessions.set(id, row.meta_value);
    if (!peers.has(row.meta_value)) peers.set(row.meta_value, []);
    peers.get(row.meta_value).push(id);
  }
  for (const row of board.db.prepare("SELECT event_id, event_by, event_kind, event_detail FROM event WHERE event_kind IN ('join','family') ORDER BY event_id").all()) {
    if (row.event_kind === 'join') { if (!joins.has(row.event_by)) joins.set(row.event_by, row); }
    else {
      if (!families.has(row.event_by)) families.set(row.event_by, []);
      families.get(row.event_by).push({ order: row.event_id, family: parsed(row.event_detail)?.family });
    }
  }
  let receipts;
  return { seats, sessions, peers, joins, families,
    /** Read historical registration receipts at most once, only when a legacy changed seat needs them. */
    receipts() { return receipts ??= receiptRegistrations(board); } };
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
