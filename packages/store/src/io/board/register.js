import { seatFamily } from "../../../../verify/index.js";
import { AGENT_GRANT_ENGINE } from "../../../../state/light.js";
import { FAMILY_DECLARE_ENGINE } from "../../../../state/light.js";
import { heartbeatSeat } from "../presence.js";
import { now } from "./query.js";
import { atomic } from "./event/log.js";
import { afterBoardWrite } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { withDerivedFamily } from "../../../../items/index.js";
import { checkRoute } from "../../../../items/index.js";
import { COORDINATOR } from "../../../../config/index.js";
import { ENGINE_VERSION } from "../../../../state/index.js";
import { VERIFIER_STANDING_ENGINE } from "../../../../state/index.js";
import { Refused } from "../../../../kernel/index.js";
import { saveJoinedSession } from "../../../../items/index.js";
import { agentModel } from "./query.js";
import { newSeatId } from "../../../../seats/index.js";
import { saveAgentModel } from "../../../../seats/index.js";
import { seatLineage } from "../../../../seats/index.js";

/** The agent_path prefix of a seat joined over the API from another machine: it has no path on the board host [P7]. */
export const REMOTE_AGENT_PATH = 'remote:';

/** Whether an agent row's path is a remote marker rather than a worktree on the board host [P7]. */
export function isRemoteAgentPath(path) {
  return typeof path === 'string' && path.startsWith(REMOTE_AGENT_PATH);
}

/**
 * Register a worktree as an agent (B3): the main checkout as the one coordinator, any other
 * worktree as the next agent in its lane (`web-1`, `web-2`, ...), on a route: the tier of model
 * behind it, which decides the items it may take (B13). The optional family is free text supplied
 * by the agent; the board neither names nor infers it. Registering again preserves the agent id;
 * explicitly supplied family and model values update their declarations, while omission preserves them.
 *
 * From engine 35 a new seat records the seat that created it (`createdBy`: an agent id, or
 * `machine` for a join no seat made), so a linked board can tell a builder's own seats from
 * independent verifiers (#579). A creator may name the new seat (`id`, the lane's next form) when
 * the relay already issued a token for the next name; ids then skip taken names.
 *
 * @param {any} board
 * @param {{ lane: string, path: string, route?: string, family?: string | null, model?: string | null, parent?: string | null, session?: string | null, createdBy?: string, id?: string }} who
 * @returns {string} The agent's id.
 */
export function register(board, who) {
  let { lane, path, route = 'strong', family, model, createdBy, id: named } = who;
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  if (engine < 8) model = undefined;
  if (engine < VERIFIER_STANDING_ENGINE) { createdBy = undefined; named = undefined; }
  checkRoute(route);
  if (lane === COORDINATOR && route !== 'strong') {
    throw new Refused('BAD_ROUTE', 'the coordinator plans, merges and verifies; it is always strong');
  }
  let fresh = false;
  const registered = atomic(board, () => {
    const row = withDerivedFamily(board, board.db.prepare('SELECT * FROM agent WHERE agent_path = ?').get(path));
    const existing = row && { ...row, agent_model: agentModel(board, row.agent_id) };
    if (existing) {
      if (who.moveLane && existing.agent_lane !== lane && lane !== COORDINATOR && existing.agent_lane !== COORDINATOR) {
        // next re-joins this same seat to a lane with takeable work: same id, same worktree, route unchanged (GH #27).
        board.db.prepare('UPDATE agent SET agent_lane = ? WHERE agent_id = ?').run(lane, existing.agent_id);
        logEvent(board, existing.agent_id, 'join', null, { lane, moved: true, from: existing.agent_lane });
        return existing.agent_id;
      }
      if (existing.agent_lane !== lane || existing.agent_route !== route) {
        throw new Refused(
          'ALREADY_JOINED',
          `this worktree is ${existing.agent_id} in the ${existing.agent_lane} lane, routed ${existing.agent_route}; use another worktree for ${lane} routed ${route}`,
        );
      }
      // Read before saveJoinedSession records this join's declaration, which would make the comparison below always equal.
      const priorFamily = seatFamily(board, existing.agent_id);
      if (who.lockLane) logEvent(board, existing.agent_id, 'join', null, { lane, lockLane: true });
      const locked = saveJoinedSession(board, existing.agent_id, who);
      const stored = board.db.prepare('SELECT agent_family AS family FROM agent WHERE agent_id = ?').get(existing.agent_id)?.family;
      const storedBlank = typeof stored !== 'string' || stored.trim() === '';
      // The stored column is compared, not the derived value: a seat whose session already derived this family still
      // gets the column written, so a join that names it is never a silent no-op (#2889).
      if (family !== undefined && !locked && family !== priorFamily) {
        board.db.prepare('UPDATE agent SET agent_family = ? WHERE agent_id = ?').run(family, existing.agent_id);
        logEvent(board, existing.agent_id, 'family', null, { family });
      } else if (locked && storedBlank && typeof family === 'string' && family.trim() !== '' && engine >= FAMILY_DECLARE_ENGINE) {
        // The session already derived this vendor (saveJoinedSession refused any other); record it on the seat row too.
        board.db.prepare('UPDATE agent SET agent_family = ? WHERE agent_id = ?').run(family, existing.agent_id);
      }
      if (model !== undefined && model !== existing.agent_model) {
        saveAgentModel(board, existing.agent_id, model);
        logEvent(board, existing.agent_id, 'model', null, { model: model ?? 'unknown' });
      }
      return existing.agent_id;
    }
    const { total } = board.db
      .prepare('SELECT COUNT(*) AS total FROM agent WHERE agent_lane = ?')
      .get(lane);
    if (lane === COORDINATOR && total > 0) {
      throw new Refused('ONE_COORDINATOR', 'the coordinator is the main checkout; it already has one');
    }
    if (createdBy !== undefined && createdBy !== 'machine' && createdBy !== COORDINATOR && !board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(createdBy)) {
      throw new Refused('NO_AGENT', `the creating seat ${createdBy} is not registered; create new seats from a joined worktree or the main checkout`);
    }
    const id = lane === COORDINATOR ? COORDINATOR
      : engine < VERIFIER_STANDING_ENGINE ? `${lane}-${total + 1}` : newSeatId(board, lane, total, named);
    // Delivery cursors are local-only; a new inbox starts at this join's current shout high-water mark.
    board.db
      .prepare(
        'INSERT INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_family, agent_created_at, agent_last_shout_id) VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(shout_id), 0) FROM shout))',
      )
      .run(id, lane, path, route, family ?? null, now(board));
    const recordsFamily = saveJoinedSession(board, id, { ...who, inserting: true });
    if ((board.executionEngineVersion ?? ENGINE_VERSION) >= 8) saveAgentModel(board, id, model);
    if (createdBy !== undefined) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`agent_creator:${id}`, createdBy);
    // Only a relay replica replaying a receipt-bound registration marks the seat enrolled.
    if (board.relayEnrollment === id && createdBy !== undefined && createdBy !== 'machine') {
      board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`agent_enrolled:${id}`, createdBy);
      // The seat's machine lineage: the creating coordinator token's, or its creator seat's.
      const lineage = createdBy === COORDINATOR ? board.verifierStanding?.lineage ?? null : seatLineage(board, createdBy);
      if (lineage) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`agent_lineage:${id}`, lineage);
    }
    logEvent(board, id, 'join', null, { lane, ...(route === 'strong' ? {} : { route }), // From the declaration engine a join records its family (#1783).
      ...(engine >= AGENT_GRANT_ENGINE ? { grantEngine: AGENT_GRANT_ENGINE } : {}), ...(recordsFamily ? { family: family ?? null } : {}),
      ...(who.lockLane ? { lockLane: true } : {}) });
    fresh = true;
    return id;
  });
  if (fresh && board.executionEngineVersion === undefined) afterBoardWrite(board, () => {
    try { heartbeatSeat(board, registered); }
    catch (error) {
      // Registration has committed; a display-only sidecar cannot turn it into an apparent refusal.
      process.emitWarning(`seat heartbeat could not be recorded after registration: ${error.message}`, { code: 'PRESENCE_WRITE_FAILED' });
    }
  });
  return registered;
}
