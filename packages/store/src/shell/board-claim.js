import { EXIT_RULES_ENGINE } from "../../../state/index.js";
import { capturedExitRules } from "../core/exit-rules-state.js";
import {
  exitContinuationSummary,
  exitContinuationProblem,
} from "../core/exit-rules-continuation.js";
import { pendingSubmitHandoff } from "./submit-handoff-read.js";
/** Native claim preparation and mutation preserve the same declared guards [B2,C7,V2]. */
import {
  boardWriteSnapshot,
  requireBoardWriteSnapshot,
} from "./board-write-preparation.js";
import { checkedSubmitOutcome } from "./submit-outcome.js";
import { submitAdmission as checkedSubmitAdmission } from "../../../state/src/core/submit-admission.js";
import { AUTOMATIC_DISPATCH_ENGINE } from "../../../../src/automatic-dispatch-engine.js";
import {
  ENGINE_VERSION,
  REOPEN_FIRST_REFUSAL_ENGINE,
  VERIFIER_STANDING_ENGINE,
  IN_STATE,
} from "../../../state/index.js";
import { AGENT_GRANT_ENGINE } from "../../../../src/agent-grant-engine.js";
import { CLAIM_IDLE_ENGINE } from "../../../../src/claim-idle-engine.js";
import {
  pendingRefreeze,
  pendingRefreezeProblem,
} from "./board-read-auxiliary.js";
import {
  isHeld,
  itemById,
  current,
  laneHold,
  itemHold,
  now,
  reviewHolder,
} from "./board-query.js";
import { outsideBuildProblem } from "../../../items/index.js";
import { barReadyProblem } from "../../../verify/index.js";
import { COORDINATOR } from "../../../config/index.js";
import { Refused } from "../../../kernel/index.js";
import { routeOf } from "../../../seats/index.js";
import { canTake } from "../../../seats/index.js";
import * as itemDependencies from "../../../items/index.js";
import { firstRefusalProblem } from "../../../items/index.js";
import { firstRefusal } from "../core/board-item-read.js";
import { rejectionReturnEnabled } from "../core/rework-family-routing.js";
import { reworkFamilyRoute } from "../core/rework-family-routing.js";
import { REWORK_SAME_FAMILY_ENGINE } from "../../../state/index.js";
import * as capacity from "../../../../src/line-capacity-board.js";
import {
  atomic,
  logEvent,
} from "./board-event-log.js";

/** Build the original claim guards once; only a successful preflight captures source bytes. */
function claimPlan(board, id, { agentId, lane, leaseMs, freeze, head = null, reviewSkipped = null, reviewPolicy = 'any', familyPolicy = 'off', submitAdmission = null, submitOutcome = null, adoptCorrection = false, reworkRoutingPolicy = null }, { reviewerChecks, reviewReleaseCooldown, foreignBlockers }) {
  const admission = checkedSubmitAdmission(board, id, agentId, submitAdmission);
  const outcome = checkedSubmitOutcome(board, id, agentId, submitOutcome, admission);
  if (adoptCorrection && (board.executionEngineVersion ?? ENGINE_VERSION) < AUTOMATIC_DISPATCH_ENGINE) {
    throw new Refused('ENGINE_VERSION', `automatic correction adoption requires engine ${AUTOMATIC_DISPATCH_ENGINE}; upgrade Pullboard`);
  }
  const adopts = adoptCorrection && pendingRefreeze(board, id).length > 0;
  const leaseUntil = new Date(board.clock.now().getTime() + leaseMs).toISOString();
  const isRenewal = (item) => item.item_owner === agentId && isHeld(board, item);
  // Reworking your own rejected item is a claim of its own, beside the one live claim (B5): the
  // builder fixing what a verifier found need not drop its other work to do it.
  const isRework = (item) => item.item_verdict === 'REJECT' && item.item_built_by === agentId;
  let reworkRouting = null;
  let frozen = null;
  let prepared = false;
  const how = {
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
        // A claim released while it waited on an unlanded item stays held until that item lands (#1225).
        if ((board.executionEngineVersion ?? ENGINE_VERSION) >= CLAIM_IDLE_ENGINE) {
          let waits = [];
          try { waits = JSON.parse(board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`claim_waiting:${id}`)?.meta_value ?? '[]'); }
          catch { waits = []; /* Unreadable wait metadata holds nothing; the dependency check above still applies. */ }
          const open = (Array.isArray(waits) ? waits : []).filter(dependency => {
            const row = board.db.prepare('SELECT item_status,item_merged_commit FROM item WHERE item_id=?').get(dependency);
            return row && row.item_status !== 'withdrawn' && !row.item_merged_commit;
          });
          if (open.length) return new Refused('BLOCKED', `#${id} is waiting on ${open.map(dependency => `#${dependency}`).join(', ')} to land; it returns to the queue when that lands`);
        }
        return null;
      },
      notHeldByAnother: (found) => (isHeld(board, found) && found.item_owner !== agentId ? new Refused('HELD', `item #${id} is held by ${found.item_owner} until ${found.item_lease_until}`) : null),
      builderFirstRefusal: (found) => {
        const continuation = exitContinuationProblem(board, id, agentId);
        if (continuation) return continuation;
        if (firstRefusal(board, id)?.otherSeatFirst) return firstRefusalProblem(board, id, agentId, { firstRefusal });
        if (rejectionReturnEnabled(board) || reworkRoutingPolicy && (board.executionEngineVersion ?? ENGINE_VERSION) >= REWORK_SAME_FAMILY_ENGINE) {
          reworkRouting = reworkFamilyRoute(board, found, { agentId, listAgents: board.nativePorts.listAgents,
            routeOf, canTake, seatFamily: board.nativePorts.seatFamily, canonicalFamily: board.nativePorts.canonicalFamily,
            policy: reworkRoutingPolicy, now: board.clock.now().getTime() });
          if (reworkRouting.applies) {
            if (reworkRouting.mode === 'policy-unknown') return new Refused('NO_POLICY', `item #${id} needs the accepted takeover and maintenance windows sealed into its claim; retry through the current CLI`);
            if (reworkRouting.allowed !== null && !reworkRouting.allowed.includes(agentId)) {
              return new Refused('REOPEN_HELD_FOR_BUILDER', reworkRouting.mode === 'builder'
                ? `item #${id} waits for its live builder ${reworkRouting.builder}`
                : `item #${id} waits for a live ${reworkRouting.builderFamily} family seat`);
            }
            return null;
          }
        }
        return (board.executionEngineVersion ?? ENGINE_VERSION) >= REOPEN_FIRST_REFUSAL_ENGINE ? firstRefusalProblem(board, id, agentId, { firstRefusal }) : null;
      },
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
      lineCapacity: found => capacity.claimProblem(board, isRenewal(found), { agentId, policy: reviewPolicy, familyPolicy }, { reviewerChecks, reviewReleaseCooldown, reviewHolder }),
      oneLiveClaim: (found) => {
        if (found.item_parent_id !== null || isRework(found) || isRenewal(found) && pendingSubmitHandoff(board, found)) return null;
        const other = board.db
          .prepare(
            `SELECT item_id FROM item WHERE item_owner = ? AND item_status = 'claimed'
               AND item_lease_until > ? AND item_id != ? AND item_parent_id IS NULL
               AND NOT (COALESCE(item_verdict, '') = 'REJECT' AND COALESCE(item_built_by, '') = ?)`,
          )
          .all(agentId, now(board), id, agentId)
          .find(row => !pendingSubmitHandoff(board, itemById(board, row.item_id)));
        return other ? new Refused('ONE_CLAIM', `you already hold #${other.item_id}; submit or release it first (child items are free)`) : null;
      },
      rowsInForce: (found) => {
        // Declared: checked only where the criterion freezes, so a renewal or a reclaim keeps its bar.
        if (found.item_frozen_digest !== null && !adopts) return null;
        try {
          if (!prepared) { frozen = freeze(found); prepared = true; }
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
  };
  return { how, leaseUntil, isRenewal, admission, outcome, adopts, frozen: () => frozen, reworkRouting: () => reworkRouting };
}

const PREPARED_CLAIMS = new WeakMap();

/**
 * Prepare a native claim before any enclosing writer takes its lock. The private binding never
 * travels over the wire; replicas still execute their existing sealed, constant criterion callback.
 * @param {any} board
 * @param {number} id
 * @param {any} options
 * @returns {any} Immutable options bound to this exact connection, target and database snapshot.
 */
export function prepareClaim(board, id, options, ports) {
  const { checkedItemMove } = ports;
  const known = PREPARED_CLAIMS.get(options);
  if (known?.board === board && known.id === id) return options;
  // A baseline worker can publish while freeze reads source. Rebuild the entire plan from the
  // new board, outside BEGIN, rather than certifying the old plan against a newer snapshot.
  // Bound preparation so a continuously changing board still reports its contention.
  for (let attempt = 0; ; attempt++) {
    const snapshot = boardWriteSnapshot(board);
    const plan = claimPlan(board, id, options, ports);
    checkedItemMove(board, id, 'claim', plan.how.checks);
    try { requireBoardWriteSnapshot(board, snapshot, 'claim'); }
    catch (error) {
      if (!(error instanceof Refused) || error.code !== 'BOARD_BUSY' || attempt >= 2) throw error;
      continue;
    }
    const prepared = Object.freeze({ ...options });
    PREPARED_CLAIMS.set(prepared, { board, id, snapshot, plan });
    return prepared;
  }
}

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
export function claim(board, id, options, ports) {
  const { moveItem } = ports;
  const prepared = prepareClaim(board, id, options, ports);
  const { snapshot, plan } = PREPARED_CLAIMS.get(prepared);
  const { agentId, head = null, reviewSkipped = null } = prepared;
  const { leaseUntil, isRenewal, admission, outcome, adopts } = plan;
  return atomic(board, () => {
    requireBoardWriteSnapshot(board, snapshot, 'claim');
    const item = moveItem(board, id, 'claim', plan.how);
    const frozen = plan.frozen();
    const renewed = isRenewal(item);
    const digest = frozen ? frozen.digest : item.item_frozen_digest;
    // A linked coordinator claim records which machine's coordinator lineage builds it (#579).
    if (board.verifierStanding && agentId === COORDINATOR && (board.executionEngineVersion ?? ENGINE_VERSION) >= VERIFIER_STANDING_ENGINE) {
      board.db.prepare('DELETE FROM board_meta WHERE meta_key = ?').run(`item_lineage:${id}`);
      if (board.verifierStanding.lineage) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`item_lineage:${id}`, board.verifierStanding.lineage);
    }
    const exitRules = capturedExitRules(options.exitRules);
    if (exitRules && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(options.exitClaimKey ?? ''))
      throw new Refused('EXIT_USAGE', 'an enabled exit policy requires its native immutable claim key');
    if (exitRules && (board.executionEngineVersion ?? ENGINE_VERSION) < EXIT_RULES_ENGINE)
      throw new Refused('ENGINE_VERSION', 'upgrade every writer before capturing claim exit budgets');
    if (!renewed && exitRules) {
      const key = `exit-claim-key:${options.exitClaimKey}`;
      if (board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(key))
        throw new Refused('EXIT_USAGE', 'a native claim key is single-use; preserve the prior claim and capture a fresh key');
      board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?)').run(key, JSON.stringify({ item: id, agent: agentId }));
    }
    const continuationSummary = !renewed ? exitContinuationSummary(board, id) : null;
    if (!renewed && continuationSummary) board.db.prepare('DELETE FROM board_meta WHERE meta_key=?').run(`exit-handoff:${id}`);
    logEvent(board, agentId, renewed ? 'renew' : 'claim', id, { leaseUntil, digest, ...(!renewed && exitRules ? { exitRules, exitClaimKey: options.exitClaimKey } : {}), ...(adopts ? { adoptedCorrection: digest } : {}), ...(!renewed && reviewSkipped ? { reviewSkipped } : {}),
      ...(admission ? { submitAdmission: admission } : {}),
      ...(outcome ? { submitOutcome: outcome } : {}),
      ...((board.executionEngineVersion ?? ENGINE_VERSION) >= AGENT_GRANT_ENGINE ? { grantEngine: AGENT_GRANT_ENGINE } : {}) });
    const route = plan.reworkRouting();
    if (!renewed && route?.applies && route.mode === 'fallback') {
      const factId = prepared.reworkRoutingPolicy?.factId;
      if (typeof factId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(factId)) {
        throw new Refused('RELAY_MOVE', 'the fallback routing fact identity was not sealed into this claim; retry through the current CLI');
      }
      if (!board.db.prepare("SELECT 1 FROM event WHERE event_kind='fact' AND json_valid(event_detail) AND json_extract(event_detail,'$.id')=? LIMIT 1").get(factId)) {
        logEvent(board, 'board', 'fact', id, { id: factId, kind: 'note', text: `No live ${route.builderFamily} family seat was available for rework #${id}; checked families: ${route.checkedFamilies.join(', ') || 'none'}. The ordinary queue assigned it to ${agentId}.`, ref: null, supersedes: null });
      }
    }
    return { leaseUntil, digest, renewed, ...(continuationSummary ? { continuationSummary } : {}) };
  });
}

