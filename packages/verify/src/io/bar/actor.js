import { COORDINATOR } from '../../../../config/index.js';
import { barReadySetting } from './readiness.js';
import { agentParent } from '../../../../seats/index.js';
/** Current bar authorship survives native takeover without rewriting historical seats [V1,H16]. */
import {
  runtimeSessionIdentity,
  parentSessionDigest,
} from '../../../../items/index.js';
import { Refused } from '../../../../kernel/index.js';

/** Capture only this runtime's own session and discovered parent before sealing an ordered move. */
export function nativeBarActor(environment = process.env, registered = {}) {
  const identity = runtimeSessionIdentity(environment);
  if (!identity) return null;
  const session = parentSessionDigest(identity.session);
  if (!identity.parent && registered.session && registered.session !== session && registered.parent && registered.parent !== registered.session) {
    throw new Refused('BAR_PARENT_UNKNOWN', 'this helper seat belongs to an earlier native session and its current parent is unknown; join a fresh worktree with the current parent before authoring or signing a bar');
  }
  const declared = registered.session === session ? registered.parent : null;
  const parent = identity.parent ? parentSessionDigest(identity.parent) : declared ?? session;
  if (identity.parent && declared && parent !== declared) throw new Refused('BAR_PARENT_UNKNOWN', 'the native parent and this session’s joined declaration disagree; use a fresh correctly joined worktree before authoring or signing a bar');
  return { session, parent };
}

/** A declared parent is usable only for the exact current native session that joined that seat. */
export function nativeBarActorForSeat(board, agent, environment = process.env) {
  const session = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`agent_session:${agent}`)?.meta_value ?? null;
  return nativeBarActor(environment, { session, parent: agentParent(board, agent) });
}
/** Unknown provenance stays unknown; a replay never consults another process's runtime. */
export function normalizeBarActor(value) {
  if (value == null) return { session: null, parent: null };
  if (value.authority === 'person' && value.session === null && value.parent === null) return { authority: 'person', session: null, parent: null };
  if (!/^[a-f0-9]{64}$/u.test(value.session) || !/^[a-f0-9]{64}$/u.test(value.parent)) {
    throw new Refused('BAR_PARENT_UNKNOWN', 'bar authorship needs the current native session and its parent; run this move from the real runtime session, without borrowing another seat');
  }
  return { session: value.session, parent: value.parent };
}

/** Capture bar provenance only at author/sign commands, never during unrelated lifecycle dispatch. */
export function barActorForCommand(ctx, board, { asPerson = false } = {}, { agentAt, requirePersonChannel }) {
  if (!barReadySetting(board).enabled) return null;
  const actor = ctx.info.isMain ? COORDINATOR : agentAt(board, ctx.info.root)?.agent_id;
  const phone = ctx.io.personRequest?.phase === 'execute';
  if (asPerson || phone || ctx.io.personChannel === 'view' && actor === COORDINATOR) {
    if (!phone) requirePersonChannel(ctx.io.personChannel);
    if (!ctx.info.isMain || actor !== COORDINATOR) throw new Refused('B26_PERSON_ANSWER', 'the person authors or signs a bar from the main checkout or its authenticated view');
    return { authority: 'person', session: null, parent: null };
  }
  if (ctx.io.personChannel === 'view' || ctx.io.personRequest) return null;
  return nativeBarActorForSeat(board, actor);
}
