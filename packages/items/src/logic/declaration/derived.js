/**
 * The read side of the one derived vendor family (#1783), with no node: built-in: the family a seat derives and the
 * engine floor a fresh registration needs. Why here: move declarations read the floor, and they must reach no
 * writer or process launcher; the hash is an explicit sha256 port [C7,V4,B26,H16].
 */
import { FAMILY_DECLARE_ENGINE } from "../../../../state/light.js";
export const ACTIVE = 'family_declare:active';
const LAST = Number.MAX_SAFE_INTEGER;
const RECEIPTS = new WeakMap();
const STATEMENTS = new WeakMap();
/**
 * One prepared statement per connection and SQL text. Why: seatFamily runs on every check, and preparing four or
 * five statements per call cost more than running them; a statement re-plans itself if the schema changes.
 */
export function prepared(db, sql) {
  let byText = STATEMENTS.get(db);
  if (!byText) STATEMENTS.set(db, byText = new Map());
  let statement = byText.get(sql);
  if (!statement) byText.set(sql, statement = db.prepare(sql));
  return statement;
}
/**
 * Limit a LIKE on board_meta keys to the keys starting with one letter, in either case. LIKE keeps its historical
 * case-insensitive match. Why: the two ranges are index seeks, where a bare LIKE scanned every row, and nearly
 * all of the board's 150,000 keys are `local:` ones that can never match.
 */
function startsWith(letter) {
  return `((meta_key >= '${letter}' AND meta_key < '${String.fromCharCode(letter.charCodeAt(0) + 1)}') OR (meta_key >= '${letter.toUpperCase()}' AND meta_key < '${String.fromCharCode(letter.toUpperCase().charCodeAt(0) + 1)}'))`;
}
export const AGENT_KEY = startsWith('a');
const RECEIPT_KEY = startsWith('r');

/** True for a family that names a vendor; null, empty and whitespace-only declare nothing. */
export function namesFamily(value) { return typeof value === 'string' && value.trim() !== ''; }

/** Parse one recorded JSON detail; an unreadable detail records nothing. */
export function parsed(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** The session digest a registration declares, null when it names none, or undefined when its value cannot be read. */
function declaredSession(who, sha256) {
  // The same digest domain and validation as parent-session.js, read without importing the registration module graph.
  if (who?.sessionDigest != null) return typeof who.sessionDigest === 'string' && /^[a-f0-9]{64}$/u.test(who.sessionDigest) ? who.sessionDigest : undefined;
  if (who?.session != null) {
    if (typeof who.session !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(who.session)) return undefined;
    return sha256(JSON.stringify(['parent-session', who.session]));
  }
  return null;
}

/** A seat's original session: its recorded session identity, or the one this join declares when none is recorded. */
export function originalSession(board, id, declared = null) {
  return prepared(board.db, 'SELECT meta_value FROM board_meta WHERE meta_key=?').get(`agent_session:${id}`)?.meta_value ?? declared ?? null;
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
export function seatRecords(board, id, { inserting = false } = {}, snapshot = null) {
  const seat = snapshot ? snapshot.seats.get(id) : prepared(board.db, 'SELECT agent_path FROM agent WHERE agent_id = ?').get(id);
  const join = snapshot ? snapshot.joins.get(id) : prepared(board.db, "SELECT event_id, event_detail FROM event WHERE +event_kind='join' AND event_by=? ORDER BY event_id LIMIT 1").get(id);
  const families = snapshot ? snapshot.families.get(id) ?? [] : prepared(board.db, "SELECT event_id, event_detail FROM event WHERE +event_kind='family' AND event_by=? ORDER BY event_id").all(id)
    .map(row => ({ order: row.event_id, family: parsed(row.event_detail)?.family }));
  const records = [];
  const joined = join ? parsed(join.event_detail) : null;
  if (joined && Object.hasOwn(joined, 'family')) records.push({ order: join.event_id, family: joined.family });
  else if (!inserting && seat) {
    // A join recorded before the family field: with no family event since, the seat row still holds its insert
    // value; after a change, the first ordered registration receipt for its path is the first record.
    const receipt = families.length ? (snapshot ? snapshot.receipts() : receiptRegistrations(board)).get(seat.agent_path) : null;
    const insert = families.length ? (receipt && (receipt.seat === null || receipt.seat === id) ? receipt.family : undefined)
      : snapshot ? seat.agent_family : prepared(board.db, 'SELECT agent_family AS family FROM agent WHERE agent_id = ?').get(id)?.family;
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
  if (original) for (const row of prepared(board.db, `SELECT meta_key FROM board_meta WHERE ${AGENT_KEY} AND meta_key LIKE 'agent\\_session:%' ESCAPE '\\' AND meta_value=? ORDER BY rowid`).all(original)) {
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
export const FAMILY_SCOPES = new WeakMap();

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
 * The engine a fresh registration needs. Once a modern prefix is recorded, a registration must run the family rule
 * whenever it touches a derived family by any key: a seat it names by path or id, or a session (digest or raw id)
 * whose seats recorded one, whatever path, seat id or parent it carries. An unreadable session counts as declared.
 * Registrations of genuinely new seats and sessions, and boards with no modern prefix, keep their engine's rules.
 */
export function familyDeclareFloor(board, who, sha256) {
  if (typeof sha256 !== 'function') throw new TypeError('the family floor needs its explicit sha256 port');
  if (!board?.db?.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(ACTIVE)) return 1;
  const seats = [
    typeof who?.path === 'string' ? board.db.prepare('SELECT agent_id FROM agent WHERE agent_path = ?').get(who.path)?.agent_id : null,
    typeof who?.id === 'string' ? board.db.prepare('SELECT agent_id FROM agent WHERE agent_id = ?').get(who.id)?.agent_id : null,
  ].filter(Boolean);
  if (seats.some(id => derivedFamily(board, id))) return FAMILY_DECLARE_ENGINE;
  const session = declaredSession(who, sha256);
  if (session === undefined || session && derivedFamily(board, null, { session })) return FAMILY_DECLARE_ENGINE;
  return 1;
}

/**
 * The family inputs of exactly these seats: their rows and their join and family events, by index. The event read
 * searches by seat (`+` keeps it off the kind index, which lists every join on the board for each call).
 * Why: a seat's family read must not list every seat on the board, which every inbox and claim pays for (#2421).
 */
export function sessionSnapshot(board, ids) {
  const seats = new Map(), joins = new Map(), families = new Map();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500), marks = chunk.map(() => '?').join(',');
    for (const row of prepared(board.db, `SELECT agent_id, agent_path, agent_family FROM agent WHERE agent_id IN (${marks})`).all(...chunk)) seats.set(row.agent_id, row);
    for (const row of prepared(board.db, `SELECT event_id, event_by, event_kind, event_detail FROM event WHERE +event_kind IN ('join','family') AND event_by IN (${marks}) ORDER BY event_id`).all(...chunk)) {
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

/** Collect read-local family inputs once; no derived authority survives this bulk read. */
export function familySnapshot(board) {
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
