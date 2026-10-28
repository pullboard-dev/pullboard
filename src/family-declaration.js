/** A declared vendor family is sticky: modern moves record it once, and an older engine cannot be sent to undo it [V4,B26,H16]. */
import { FAMILY_DECLARE_ENGINE } from './family-declare-engine.js';

const ACTIVE = 'family_declare:active';
const WITNESS = 'agent_family_declared:';

/** The first ordered move at the declaration engine fences every later fresh registration to that engine. */
export function recordFamilyDeclareActivation(board, engine) {
  if (engine < FAMILY_DECLARE_ENGINE) return;
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO NOTHING').run(ACTIVE, String(FAMILY_DECLARE_ENGINE));
}

/**
 * The engine a fresh registration needs. Once a modern prefix is recorded, a registration that rejoins a seat with
 * a declared family must run the family rule, so an older engine cannot clear or replace it. Registrations of new
 * seats, and boards with no modern prefix, keep their recorded engine's rules.
 */
export function familyDeclareFloor(board, who) {
  if (!board?.db?.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(ACTIVE) || typeof who?.path !== 'string') return 1;
  const seat = board.db.prepare('SELECT agent_id FROM agent WHERE agent_path = ?').get(who.path);
  return seat && declaredFamily(board, seat.agent_id) ? FAMILY_DECLARE_ENGINE : 1;
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
