/** A declared vendor family is sticky: modern moves record it once, and an older engine cannot be sent to undo it [V4,B26,H16]. */
import { FAMILY_DECLARE_ENGINE } from './family-declare-engine.js';
import { createHash } from 'node:crypto';

const ACTIVE = 'family_declare:active';
const WITNESS = 'agent_family_declared:';

/** The first ordered move at the declaration engine fences every later fresh registration to that engine. */
export function recordFamilyDeclareActivation(board, engine) {
  if (engine < FAMILY_DECLARE_ENGINE) return;
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO NOTHING').run(ACTIVE, String(FAMILY_DECLARE_ENGINE));
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

/**
 * The engine a fresh registration needs. Once a modern prefix is recorded, a registration must run the family rule,
 * so an older engine cannot clear or replace a declaration, whenever it touches a declared family by any key:
 * it rejoins a seat (by path or named id) with a declared family, or it names a session whose seats already
 * declared one, whatever path, seat id or parent it carries. An identity that cannot be read counts as declared.
 * Registrations of genuinely new seats and sessions, and boards with no modern prefix, keep their engine's rules.
 */
export function familyDeclareFloor(board, who) {
  if (!board?.db?.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(ACTIVE)) return 1;
  const seats = [
    typeof who?.path === 'string' ? board.db.prepare('SELECT agent_id FROM agent WHERE agent_path = ?').get(who.path)?.agent_id : null,
    typeof who?.id === 'string' ? board.db.prepare('SELECT agent_id FROM agent WHERE agent_id = ?').get(who.id)?.agent_id : null,
  ].filter(Boolean);
  if (seats.some(id => declaredFamily(board, id))) return FAMILY_DECLARE_ENGINE;
  for (const id of seats) if (sessionDeclaredFamily(board, originalSession(board, id), id)) return FAMILY_DECLARE_ENGINE;
  const session = declaredSession(who);
  if (session === undefined || sessionDeclaredFamily(board, session, null)) return FAMILY_DECLARE_ENGINE;
  return 1;
}

/** True for a family that names a vendor; null, empty and whitespace-only declare nothing. */
function names(value) { return typeof value === 'string' && value.trim() !== ''; }

/**
 * The family a seat has declared, if any: the recorded first declaration, else its current family, else any
 * family it was ever recorded with. A cleared column never makes a declared seat undeclared.
 */
export function declaredFamily(board, id) {
  const witness = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`${WITNESS}${id}`)?.meta_value;
  if (names(witness)) return witness;
  const current = board.db.prepare('SELECT agent_family FROM agent WHERE agent_id = ?').get(id)?.agent_family;
  if (names(current)) return current;
  for (const row of board.db.prepare("SELECT event_detail FROM event WHERE event_kind='family' AND event_by=? ORDER BY event_id").all(id)) {
    let detail;
    try { detail = JSON.parse(row.event_detail); } catch { detail = null; }
    if (names(detail?.family)) return detail.family;
  }
  return null;
}

/** Record a seat's first declared family once; a later call never replaces it. */
export function saveFamilyWitness(board, id, family) {
  if (!names(family)) return;
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO NOTHING').run(`${WITNESS}${id}`, family);
}

const SESSION_WITNESS = 'session_family_declared:';

/** A seat's original session: its recorded session identity, or the one this join declares when none is recorded. */
export function originalSession(board, id, declared = null) {
  return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`agent_session:${id}`)?.meta_value ?? declared ?? null;
}

/**
 * The family any seat of this original session already declared: the session's recorded first declaration, else any
 * other seat recorded with this session that has a declared family. A new seat of that session inherits it.
 */
export function sessionDeclaredFamily(board, session, exceptId) {
  if (!session) return null;
  const witness = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`${SESSION_WITNESS}${session}`)?.meta_value;
  if (names(witness)) return witness;
  for (const row of board.db.prepare("SELECT meta_key FROM board_meta WHERE meta_key LIKE 'agent_session:%' AND meta_value=? ORDER BY meta_key").all(session)) {
    const id = row.meta_key.slice('agent_session:'.length);
    if (id === exceptId) continue;
    const family = declaredFamily(board, id);
    if (family) return family;
  }
  return null;
}

/** Record a session's first declared family once, beside the seat's own record. */
export function saveSessionWitness(board, session, family) {
  if (!session || !names(family)) return;
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO NOTHING').run(`${SESSION_WITNESS}${session}`, family);
}
