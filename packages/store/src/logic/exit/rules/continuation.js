import {
  familyName,
  familyAliasesOf,
} from "../../../../../verify/index.js";
import { EXIT_RULES_ENGINE } from "../../../../../state/index.js";
import { ENGINE_VERSION } from "../../../../../state/index.js";
/** Native family/session continuation metadata has no store writer dependency [B3,C7]. */
import { createHash } from 'node:crypto';
import {
  originalSession,
  seatFamily,
} from "../../../../../items/index.js";
import { Refused } from "../../../../../kernel/index.js";

/** Only a native board's original session record supplies continuation identity. */
export function exitSessionIdentity(board, actor) {
  const value = originalSession(board, actor);
  return typeof value === 'string' && value ? createHash('sha256').update(value).digest('hex') : null;
}

/** Refuse the exited native session across later seats, while leaving summary and release recovery possible. */
export function exitedSession(board, actor) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < EXIT_RULES_ENGINE) return null;
  const identity = exitSessionIdentity(board, actor);
  const rows = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key GLOB 'exit-session:*'").all();
  return rows.map(row => JSON.parse(row.meta_value)).find(row => row.agent === actor || identity && row.session === identity) ?? null;
}

/** A fresh same-family session may continue; old sessions and unknown families never gain reservation authority. */
export function exitContinuationProblem(board, id, actor) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < EXIT_RULES_ENGINE) return null;
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`exit-handoff:${id}`);
  if (!row) return null;
  const handoff = JSON.parse(row.meta_value), identity = exitSessionIdentity(board, actor), family = seatFamily(board, actor);
  if (actor === handoff.agent || !identity || identity === handoff.session || !family || familyName(family, familyAliasesOf(board)) !== familyName(handoff.family, familyAliasesOf(board)))
    return new Refused('REOPEN_HELD_FOR_BUILDER', `item #${id} is reserved for a fresh ${handoff.family} session; read its summary and use a new native seat`);
  return null;
}

/** Offer the durable handoff summary without changing the historical item schema. */
export function exitContinuationSummary(board, id) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < EXIT_RULES_ENGINE) return null;
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`exit-handoff:${id}`);
  return row ? JSON.parse(row.meta_value).summary : null;
}


/** A fresh join's native captured session is checked before it can create another seat. */
export function exitedSessionIdentity(board, canonicalIdentity) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < EXIT_RULES_ENGINE || typeof canonicalIdentity !== 'string' || !canonicalIdentity) return null;
  const key = createHash('sha256').update(canonicalIdentity).digest('hex');
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`exit-session:${key}`);
  return row ? JSON.parse(row.meta_value) : null;
}
