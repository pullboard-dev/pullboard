import { submitAdmission as checkedSubmitAdmission } from '../packages/state/src/core/submit-admission.js';
import { firstRefusal } from './board-item-read.js';
import * as itemDependencies from './item-dependencies.js';
import { AGENT_GRANT_ENGINE } from './agent-grant-engine.js';
import { AUTOMATIC_DISPATCH_ENGINE } from './automatic-dispatch-engine.js';
import { pendingRefreeze } from './board-read-auxiliary.js';
import { pendingRefreezeProblem } from './board-read-auxiliary.js';
import * as capacity from './line-capacity-board.js';
import { outsideBuildProblem } from './outside-source.js';
import { barReadyProblem } from './bar-readiness.js';
import { now } from './board-query.js';
import { isHeld } from './board-query.js';
import { current } from './board-query.js';
import { itemById } from './board-query.js';
import { itemHold } from './board-query.js';
import { laneHold } from './board-query.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { COORDINATOR } from './config.js';
import { firstRefusalProblem } from './claims.js';
import { ENGINE_VERSION } from './machine.js';
import { REOPEN_FIRST_REFUSAL_ENGINE } from './machine.js';
import { IN_STATE } from './machine.js';
import { VERIFIER_STANDING_ENGINE } from './machine.js';
import { Refused } from './refused.js';
import { canTake } from './route-escalation.js';
import { routeOf } from './seats.js';
import { foreignBlockers } from './board.js';
import { moveItem } from './board.js';
import { reviewReleaseCooldown } from './board.js';
import { reviewerChecks } from './board.js';

/**
 * Claim an item, or renew your own claim (B4, B5, B12, V2).
 *
 * One live top-level claim per agent, so nobody hoards; child items are free, which is how
 * sub-agents share a lane. A lapsed claim can be taken. Every item is built in its own lane, the
 * coordinator's included, so no agent can build another lane's work from the main checkout. The
 * first claim freezes the criterion: `freeze` returns the text and digest the verdict will later be
 * held to. A fresh claim also records `head`, the commit the work starts from, so submit can name
 * the files the item changed (N21). A held lane takes no new claims (N22); renewals go on.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, lane: string, leaseMs: number, freeze: (item: any) => { text: string, digest: string }, head?: string | null, reviewSkipped?: object | null }} who
 * @returns {{ leaseUntil: string, digest: string, renewed: boolean }}
 */
export function claim(board, id, { agentId, lane, leaseMs, freeze, head = null, reviewSkipped = null, reviewPolicy = 'any', familyPolicy = 'off', submitAdmission = null, adoptCorrection = false }) {
  return atomic(board, () => {
    const admission = checkedSubmitAdmission(board, id, agentId, submitAdmission);
    if (adoptCorrection && (board.executionEngineVersion ?? ENGINE_VERSION) < AUTOMATIC_DISPATCH_ENGINE) {
      throw new Refused('ENGINE_VERSION', `automatic correction adoption requires engine ${AUTOMATIC_DISPATCH_ENGINE}; upgrade Pullboard`);
    }
    const adopts = adoptCorrection && pendingRefreeze(board, id).length > 0;
    const leaseUntil = new Date(board.clock.now().getTime() + leaseMs).toISOString();
    const isRenewal = (item) => item.item_owner === agentId && isHeld(board, item);
    // Reworking your own rejected item is a claim of its own, beside the one live claim (B5): the
    // builder fixing what a verifier found need not drop its other work to do it.
    const isRework = (item) => item.item_verdict === 'REJECT' && item.item_built_by === agentId;
    let frozen = null;
    const item = moveItem(board, id, 'claim', {
      checks: {
        joined: null, checkProvesSomething: null,
        barReady: found => barReadyProblem(board, found),
        [IN_STATE]: (found) => new Refused('NOT_CLAIMABLE', `item #${id} is ${found.item_status}`),
        inLane: (found) => {
          const outside = outsideBuildProblem(board, found);
          if (outside) return outside;
          if (found.item_lane === lane) return null;
          return new Refused(
            'WRONG_LANE',
            lane === COORDINATOR
              ? `item #${id} is in the ${found.item_lane} lane, and lane items are built from that lane's worktree, never the main checkout. An agent runs: cd <its own worktree> && pullboard claim ${id}`
              : `item #${id} is in the ${found.item_lane} lane; you are in ${lane}`,
          );
        },
        routeAllows: (found) => {
          const route = routeOf(board, agentId);
          return canTake(route, found.item_route) ? null : new Refused('ROUTE', `item #${id} needs a ${found.item_route} model; you joined on the ${route} route. Take your next item: pullboard next`);
        },
        dependenciesVerified: (found) => {
          const foreign = foreignBlockers(board, found)[0];
          if (foreign) return new Refused('BLOCKED', `#${id} waits on ${itemDependencies.dependencyLabel(foreign)} (${foreign.status} on its own board); refresh that board before claiming`);
          for (const dependency of itemDependencies.localDependencyIds(found)) {
            const before = itemById(board, dependency);
            if (before.item_status !== 'verified') {
              return new Refused(
                'BLOCKED',
                `#${id} waits on #${dependency} (${current(board, before).item_status}, ${before.item_lane} lane); claim another item, or shout ${before.item_lane} if it is stuck`,
              );
            }
          }
          return null;
        },
        notHeldByAnother: (found) => (isHeld(board, found) && found.item_owner !== agentId ? new Refused('HELD', `item #${id} is held by ${found.item_owner} until ${found.item_lease_until}`) : null),
        builderFirstRefusal: () => (board.executionEngineVersion ?? ENGINE_VERSION) >= REOPEN_FIRST_REFUSAL_ENGINE ? firstRefusalProblem(board, id, agentId, { firstRefusal }) : null,
        correctionRefrozen: () => adopts ? null : pendingRefreezeProblem(board, id),
        laneOpen: (found) => {
          // Declared: not checked when the caller renews its own live claim.
          const paused = laneHold(board, found.item_lane);
          return paused && !isRenewal(found)
            ? new Refused('LANE_HELD', `${paused.hold_by} holds the ${found.item_lane} lane: ${paused.hold_reason}. Wait for it: pullboard next --wait 9 (minutes)`)
            : null;
        },
        itemNotHeld: (found) => {
          const held = itemHold(board, found.item_id);
          return held && !isRenewal(found)
            ? new Refused('ITEM_HELD', `item #${id} is held by coordinator: ${held.item_hold_reason}; wait for the coordinator to lift it with pullboard hold ${id} --off`)
            : null;
        },
        lineCapacity: found => capacity.claimProblem(board, isRenewal(found), { agentId, policy: reviewPolicy, familyPolicy }, { reviewerChecks, reviewReleaseCooldown }),
        oneLiveClaim: (found) => {
          if (found.item_parent_id !== null || isRework(found)) return null;
          const other = board.db
            .prepare(
              `SELECT item_id FROM item WHERE item_owner = ? AND item_status = 'claimed'
                 AND item_lease_until > ? AND item_id != ? AND item_parent_id IS NULL
                 AND NOT (COALESCE(item_verdict, '') = 'REJECT' AND COALESCE(item_built_by, '') = ?)`,
            )
            .get(agentId, now(board), id, agentId);
          return other ? new Refused('ONE_CLAIM', `you already hold #${other.item_id}; submit or release it first (child items are free)`) : null;
        },
        rowsInForce: (found) => {
          // Declared: checked only where the criterion freezes, so a renewal or a reclaim keeps its bar.
          if (found.item_frozen_digest !== null && !adopts) return null;
          try {
            frozen = freeze(found);
            return null;
          } catch (error) {
            if (error instanceof Refused) return error;
            throw error;
          }
        },
      },
      set: (found) => ({
        ...(frozen ? { item_frozen: frozen.text, item_frozen_digest: frozen.digest } : {}),
        ...(!isRenewal(found) && head ? { item_claim_head: head } : {}),
        item_owner: agentId,
        item_lease_until: leaseUntil,
      }),
    });
    const renewed = isRenewal(item);
    const digest = frozen ? frozen.digest : item.item_frozen_digest;
    // A linked coordinator claim records which machine's coordinator lineage builds it (#579).
    if (board.verifierStanding && agentId === COORDINATOR && (board.executionEngineVersion ?? ENGINE_VERSION) >= VERIFIER_STANDING_ENGINE) {
      board.db.prepare('DELETE FROM board_meta WHERE meta_key = ?').run(`item_lineage:${id}`);
      if (board.verifierStanding.lineage) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`item_lineage:${id}`, board.verifierStanding.lineage);
    }
    logEvent(board, agentId, renewed ? 'renew' : 'claim', id, { leaseUntil, digest, ...(adopts ? { adoptedCorrection: digest } : {}), ...(!renewed && reviewSkipped ? { reviewSkipped } : {}),
      ...(admission ? { submitAdmission: admission } : {}),
      ...((board.executionEngineVersion ?? ENGINE_VERSION) >= AGENT_GRANT_ENGINE ? { grantEngine: AGENT_GRANT_ENGINE } : {}) });
    return { leaseUntil, digest, renewed };
  });
}
