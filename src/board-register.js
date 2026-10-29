import * as reviewRouting from './review-routing.js';
import { AGENT_GRANT_ENGINE } from './agent-grant-engine.js';
import { heartbeatSeat } from './seat-presence.js';
import { now } from './board-query.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { checkRoute } from './item-routing.js';
import { COORDINATOR } from './config.js';
import { ENGINE_VERSION } from './machine.js';
import { VERIFIER_STANDING_ENGINE } from './machine.js';
import { Refused } from './refused.js';
import { saveJoinedSession } from './parent-session.js';
import { agentAt } from './seats.js';
import { newSeatId } from './seats.js';
import { saveAgentModel } from './seats.js';
import { seatLineage } from './seats.js';

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
  return atomic(board, () => {
    const existing = agentAt(board, path);
    if (existing) {
      if (existing.agent_lane !== lane || existing.agent_route !== route) {
        throw new Refused(
          'ALREADY_JOINED',
          `this worktree is ${existing.agent_id} in the ${existing.agent_lane} lane, routed ${existing.agent_route}; use another worktree for ${lane} routed ${route}`,
        );
      }
      const locked = saveJoinedSession(board, existing.agent_id, who);
      if (family !== undefined && family !== reviewRouting.seatFamily(board, existing.agent_id) && !locked) {
        board.db.prepare('UPDATE agent SET agent_family = ? WHERE agent_id = ?').run(family, existing.agent_id);
        logEvent(board, existing.agent_id, 'family', null, { family });
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
    board.db
      .prepare(
        'INSERT INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_family, agent_created_at) VALUES (?, ?, ?, ?, ?, ?)',
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
      ...(engine >= AGENT_GRANT_ENGINE ? { grantEngine: AGENT_GRANT_ENGINE } : {}), ...(recordsFamily ? { family: family ?? null } : {}) });
    if (board.executionEngineVersion === undefined) heartbeatSeat(board, id);
    return id;
  });
}
