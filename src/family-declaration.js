/**
 * A seat's vendor family is ONE derived value (#1783): the first non-blank family ever recorded, in board order, by any
 * register, join, family or receipt record for that seat or for any seat sharing its original session. Nothing clears
 * it: a null, blank or later family is history, not a new declaration. Every family read and check goes through
 * `seatFamily`, so no decision reads the stored column (which only records the latest join's value for display and for
 * replaying engines older than the declaration engine) [V4,B26,H16].
 */
import { FAMILY_DECLARE_ENGINE } from './family-declare-engine.js';
import { createHash } from 'node:crypto';

const ACTIVE = 'family_declare:active';
const LAST = Number.MAX_SAFE_INTEGER;
const RECEIPTS = new WeakMap();

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
  const count = board.db.prepare("SELECT COUNT(*) AS n FROM board_meta WHERE meta_key LIKE 'relay\\_receipt\\_%' ESCAPE '\\'").get().n;
  const cached = RECEIPTS.get(board.db);
  if (cached?.count === count) return cached.paths;
  const rows = [];
  for (const row of board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'relay\\_receipt\\_%' ESCAPE '\\'").all()) {
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
function seatRecords(board, id, { inserting = false } = {}) {
  const seat = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id = ?').get(id);
  const join = board.db.prepare("SELECT event_id, event_detail FROM event WHERE event_kind='join' AND event_by=? ORDER BY event_id LIMIT 1").get(id);
  const families = board.db.prepare("SELECT event_id, event_detail FROM event WHERE event_kind='family' AND event_by=? ORDER BY event_id").all(id)
    .map(row => ({ order: row.event_id, family: parsed(row.event_detail)?.family }));
  const records = [];
  const joined = join ? parsed(join.event_detail) : null;
  if (joined && Object.hasOwn(joined, 'family')) records.push({ order: join.event_id, family: joined.family });
  else if (!inserting && seat) {
    // A join recorded before the family field: with no family event since, the seat row still holds its insert
    // value; after a change, the first ordered registration receipt for its path is the first record.
    const receipt = families.length ? receiptRegistrations(board).get(seat.agent_path) : null;
    const insert = families.length ? (receipt && (receipt.seat === null || receipt.seat === id) ? receipt.family : undefined)
      : board.db.prepare('SELECT agent_family AS family FROM agent WHERE agent_id = ?').get(id)?.family;
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
  const original = id ? originalSession(board, id, session) : session;
  const seats = new Set(id ? [id] : []);
  if (original) for (const row of board.db.prepare("SELECT meta_key FROM board_meta WHERE meta_key LIKE 'agent\\_session:%' ESCAPE '\\' AND meta_value=?").all(original)) {
    seats.add(row.meta_key.slice('agent_session:'.length));
  }
  let first = null;
  for (const seat of seats) {
    for (const record of seatRecords(board, seat, { inserting: inserting && seat === id })) {
      if (!first || record.order < first.order) first = record;
    }
  }
  return first?.family ?? null;
}

/**
 * The family every read and check uses. At and after the declaration engine it is the one derived value; a move
 * replaying under an older engine keeps that engine's recorded semantics, which read the seat row.
 */
export function seatFamily(board, id) {
  // Unset, the board runs this code's own engine, which includes the declaration engine.
  if ((board.executionEngineVersion ?? Infinity) >= FAMILY_DECLARE_ENGINE) return derivedFamily(board, id);
  return board.db.prepare('SELECT agent_family AS family FROM agent WHERE agent_id = ?').get(id)?.family ?? null;
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
