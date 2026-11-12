import { lightDiagnosisProblem } from '../../logic/item/diagnosis.js';
import { builderFamilyProblem } from '../builder/family.js';
import { EXPECTED_BUILD_ENGINE } from '../../../../state/light.js';
import { expectedBuildProblem } from '../../../../items/index.js';
import { UNTOUCHED_CLAIM_ENGINE } from '../../../../state/light.js';
import { BLOCKED_DEPENDENCIES_ENGINE } from '../../../../state/light.js';
import { EXIT_RULES_ENGINE } from "../../../../state/index.js";
import { capturedExitRules } from "../../logic/exit/rules/claim.js";
import {
  exitContinuationSummary,
  exitContinuationProblem,
} from "../../logic/exit/rules/continuation.js";
import { pendingSubmitHandoff } from "../submit/handoff/records.js";
import { awaitingGateOrReview } from "../submit/handoff/records.js";
/** Native claim preparation and mutation preserve the same declared guards [B2,C7,V2]. */
import {
  boardWriteSnapshot,
  boardWriteSnapshotChanged,
  staleBoardRefusal,
} from "./write/preparation.js";
import { checkedSubmitOutcome } from "../submit/outcome.js";
import { submitAdmission as checkedSubmitAdmission } from "../../../../state/light.js";
import { AUTOMATIC_DISPATCH_ENGINE } from "../../../../state/light.js";
import {
  ENGINE_VERSION,
  REOPEN_FIRST_REFUSAL_ENGINE,
  VERIFIER_STANDING_ENGINE,
  IN_STATE,
} from "../../../../state/index.js";
import { ITEM_FOLDER_ENGINE } from "../../../../state/light.js";
import { AGENT_GRANT_ENGINE } from "../../../../state/light.js";
import { CLAIM_IDLE_ENGINE } from "../../../../state/light.js";
import {
  pendingRefreeze,
  pendingRefreezeProblem,
} from "./read/shouts.js";
import {
  isHeld,
  itemById,
  current,
  laneHold,
  itemHold,
  now,
  reviewHolder,
} from "./query.js";
import { outsideBuildProblem } from "../../../../items/index.js";
import { barReadyProblem } from "../../../../verify/index.js";
import { COORDINATOR } from "../../../../config/index.js";
import { Refused } from "../../../../kernel/index.js";
import { routeOf } from "../../../../seats/index.js";
import { canTake } from "../../../../seats/index.js";
import { cappedRoute } from "../../../../seats/index.js";
import * as itemDependencies from "../../../../items/index.js";
import { firstRefusalProblem } from "../../../../items/index.js";
import { seatGone } from "../presence.js";
import { firstRefusal } from "../../logic/board/item/lookup.js";
import { rejectionReturnEnabled } from "../../logic/rework.js";
import { reworkFamilyRoute } from "../../logic/rework.js";
import { REWORK_SAME_FAMILY_ENGINE } from "../../../../state/index.js";
import { CLAIM_RETURNS_ENGINE } from "../../../../state/index.js";
import { claimProblem } from "../../../../seats/index.js";
import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { loadConfig } from "../../../../config/index.js";
import { withLocalSeatPresence } from "../presence.js";
import {
  atomic,
  logEvent,
} from "./event/log.js";

/** Free pulled test-run slots: jobs each recently claiming runner declared, less live jobs; null when no runner serves. */
function runnerSlots(board) {
  if (!board.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_step'").get()) return null;
  const at = board.clock.now().getTime(), serves = new Map();
  for (const row of board.db.prepare("SELECT job_step_payload AS payload FROM job_step WHERE job_step_name = 'claimed' AND job_step_at >= ?").all(at - 600_000)) {
    let step = null;
    try { step = JSON.parse(row.payload); } catch { /* an unreadable step declares nothing */ }
    if (typeof step?.runner === 'string' && Number.isSafeInteger(step.jobs) && step.jobs >= 1) serves.set(step.runner, Math.max(serves.get(step.runner) ?? 0, step.jobs));
  }
  if (serves.size === 0) return null;
  const busy = board.db.prepare("SELECT count(*) AS n FROM job WHERE job_lease_owner IS NOT NULL AND job_lease_until >= ? AND job_step <> 'done'").get(at).n;
  return Math.max(0, [...serves.values()].reduce((sum, jobs) => sum + jobs, 0) - busy);
}

/**
 * How many live top-level build claims one seat may hold, and one line saying how N was found [C7].
 * Why: a seat builds its next item while the last one's tests run; free test-run slots per live seat bound that.
 */
function claimsPerSeat(board, perSeat = null) {
  let set = perSeat;
  if (set === null && board.gitRoot) { try { set = loadConfig(board.gitRoot).claims?.perSeat ?? null; } catch { set = null; } }
  if (Number.isSafeInteger(set) && set >= 1) return { n: set, how: `claims.perSeat sets ${set}` };
  const runners = runnerSlots(board);
  const slots = runners ?? availableParallelism();
  const seats = Math.max(1, withLocalSeatPresence(board, board.db.prepare('SELECT agent_id FROM agent').all()).filter(seat => seat.presence === 'live').length);
  const n = Math.min(5, Math.max(1, Math.floor(slots / seats)));
  return { n, how: `N = clamp(1, 5, floor(${slots} free ${runners === null ? 'local cores' : 'runner slots'} / ${seats} live seats)) = ${n}; claims.perSeat overrides it` };
}

/** Build the original claim guards once; only a successful preflight captures source bytes. */
function claimPlan(board, id, { agentId, lane, leaseMs, freeze, head = null, reviewSkipped = null, reviewPolicy = 'any', familyPolicy = 'off', submitAdmission = null, submitOutcome = null, adoptCorrection = false, refreshPolicy = false, reworkRoutingPolicy = null, itemFolder = false, buildBudgetMinutes = 30, routeCap = null, perSeat = null }, { reviewerChecks, reviewReleaseCooldown, foreignBlockers }) {
  const admission = checkedSubmitAdmission(board, id, agentId, submitAdmission);
  const outcome = checkedSubmitOutcome(board, id, agentId, submitOutcome, admission);
  if (adoptCorrection && (board.executionEngineVersion ?? ENGINE_VERSION) < AUTOMATIC_DISPATCH_ENGINE) {
    throw new Refused('ENGINE_VERSION', `automatic correction adoption requires engine ${AUTOMATIC_DISPATCH_ENGINE}; upgrade Pullboard`);
  }
  const adopts = adoptCorrection && pendingRefreeze(board, id).length > 0;
  if (refreshPolicy && (board.executionEngineVersion ?? ENGINE_VERSION) < AUTOMATIC_DISPATCH_ENGINE) {
    throw new Refused('ENGINE_VERSION', `a lane policy refresh requires engine ${AUTOMATIC_DISPATCH_ENGINE}; upgrade Pullboard`);
  }
  const refreshes = refreshPolicy === true && !adopts;
  const leaseUntil = new Date(board.clock.now().getTime() + leaseMs).toISOString();
  const isRenewal = (item) => item.item_owner === agentId && isHeld(board, item);
  // Reworking your own rejected item is a claim of its own, beside the one live claim (B5): the
  // builder fixing what a verifier found need not drop its other work to do it.
  const isRework = (item) => item.item_verdict === 'REJECT' && item.item_built_by === agentId;
  let reworkRouting = null;
  let frozen = null;
  let policyRefreeze = null;
  let prepared = false;
  const how = {
    checks: {
      joined: null, checkProvesSomething: null,
      barReady: found => builderFamilyProblem(board, found, agentId, familyPolicy) ?? barReadyProblem(board, found),
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
        // The CLI caps the route by the model this session declared (#3678); the cap only narrows the joined route.
        const route = cappedRoute(routeOf(board, agentId), routeCap);
        // Only light work needs a diagnosis; a light seat reaching above its route is refused ROUTE (#2886).
        const diagnosisProblem = route === 'light' && found.item_route === 'light' ? lightDiagnosisProblem(board, found, 'light') : null;
        if (diagnosisProblem) return diagnosisProblem;
        return canTake(route, found.item_route) ? null : new Refused('ROUTE', `item #${id} needs a ${found.item_route} model; ${route === routeOf(board, agentId) ? 'you joined on' : 'the model this session declared serves'} the ${route} route. Take your next item: pullboard next`);
      },
      buildScopeFits: found => isRenewal(found) || (board.executionEngineVersion ?? ENGINE_VERSION) < EXPECTED_BUILD_ENGINE ? null : expectedBuildProblem(found, buildBudgetMinutes),
      dependenciesVerified: (found) => {
        const foreign = foreignBlockers(board, found)[0];
        if (foreign) return new Refused('BLOCKED', `#${id} waits on ${itemDependencies.dependencyLabel(foreign)} (${foreign.status} on its own board); refresh that board before claiming`);
        for (const dependency of itemDependencies.localDependencyIds(found)) {
          const before = itemById(board, dependency);
          if (before.item_status !== 'verified' && !((board.executionEngineVersion ?? ENGINE_VERSION) >= BLOCKED_DEPENDENCIES_ENGINE && before.item_status === 'withdrawn')) {
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
        if (firstRefusal(board, id)?.otherSeatFirst) return firstRefusalProblem(board, id, agentId, { firstRefusal, otherBuilderFirst: (board.executionEngineVersion ?? ENGINE_VERSION) >= CLAIM_RETURNS_ENGINE });
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
        return (board.executionEngineVersion ?? ENGINE_VERSION) >= REOPEN_FIRST_REFUSAL_ENGINE ? firstRefusalProblem(board, id, agentId, { firstRefusal, seatGone }) : null;
      },
      correctionRefrozen: () => adopts ? null : pendingRefreezeProblem(board, id),
      laneOpen: (found) => {
        // Declared: not checked when the caller renews its own live claim.
        const paused = laneHold(board, found.item_lane);
        return paused && !isRenewal(found)
          ? new Refused('LANE_HELD', `${paused.hold_by} holds the ${found.item_lane} lane: ${paused.hold_reason}; take other available work with pullboard next, or end your turn if none is offered`)
          : null;
      },
      itemNotHeld: (found) => {
        const held = itemHold(board, found.item_id);
        return held && !isRenewal(found)
          ? new Refused('ITEM_HELD', `item #${id} is held by coordinator: ${held.item_hold_reason}; take another eligible item with pullboard next, or end your turn if none is offered`)
          : null;
      },
      lineCapacity: found => claimProblem(board, isRenewal(found), { agentId, policy: reviewPolicy, familyPolicy }, { reviewerChecks, reviewReleaseCooldown, reviewHolder }),
      oneLiveClaim: (found) => {
        // Every modern-engine claim respects the cap, including legacy-shaped children and reworks.
        const modern = (board.executionEngineVersion ?? ENGINE_VERSION) >= ITEM_FOLDER_ENGINE;
        if (modern && !isRenewal(found)) {
          const held = board.db.prepare("SELECT item_id, item_parent_id, item_verdict, item_built_by FROM item WHERE item_owner = ? AND item_status = 'claimed' AND item_lease_until > ? AND item_id != ?")
            .all(agentId, now(board), id).filter(row => !awaitingGateOrReview(board, itemById(board, row.item_id)));
          if (held.length >= 10) return new Refused('ONE_CLAIM', 'you already hold ten live claims; submit or release one before claiming another');
          if (found.item_parent_id !== null || isRework(found)) return null;
          const top = held.filter(row => row.item_parent_id === null && !isRework(row));
          const { n, how } = claimsPerSeat(board, perSeat);
          return top.length >= n ? new Refused('ONE_CLAIM', `you already hold ${top.map(row => `#${row.item_id}`).join(', ')}; a seat holds up to ${n} (${how}); submit or release one first (child items are free)`) : null;
        }
        if (modern) return null;
        if (found.item_parent_id !== null || isRework(found) || isRenewal(found) && pendingSubmitHandoff(board, found)) return null;
        const other = board.db
          .prepare(
            `SELECT item_id FROM item WHERE item_owner = ? AND item_status = 'claimed'
               AND item_lease_until > ? AND item_id != ? AND item_parent_id IS NULL
               AND NOT (COALESCE(item_verdict, '') = 'REJECT' AND COALESCE(item_built_by, '') = ?)`,
          )
          .all(agentId, now(board), id, agentId)
          .find(row => !awaitingGateOrReview(board, itemById(board, row.item_id)));
        return other ? new Refused('ONE_CLAIM', `you already hold #${other.item_id}; submit or release it first (child items are free)`) : null;
      },
      rowsInForce: (found) => {
        // Declared: checked only where the criterion freezes, so a renewal or a reclaim keeps its bar.
        if (found.item_frozen_digest !== null && !adopts && !refreshes) return null;
        try {
          if (!prepared) { frozen = freeze(found); prepared = true; }
          policyRefreeze = frozen?.policyRefreeze ?? null;
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
  return { how, leaseUntil, isRenewal, admission, outcome, adopts, refreshes, frozen: () => frozen,
    policyRefreeze: () => policyRefreeze, reworkRouting: () => reworkRouting };
}

const PREPARED_CLAIMS = new WeakMap();

/** Preparations of one claim before a board whose claim rows keep changing is reported BOARD_BUSY. */
const CLAIM_PREPARE_ATTEMPTS = 5;

/**
 * The rows a prepared claim depends on: the item (its holder, lease, bar and after-links), the state of each
 * dependency, its own events and item-keyed metadata (check baseline, bar revision and sign-off, machine
 * verification), its pending re-freeze, and the spec decisions and bar setting the freeze reads. Every guard runs
 * again under the writer lock, so only these rows can make a prepared plan (its frozen bar above all) stale; a write
 * anywhere else on the board cannot (#6016).
 * @param {any} board
 * @param {number} id
 * @returns {string}
 */
function claimRows(board, id) {
  const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(id) ?? null;
  const dependencies = item ? itemDependencies.localDependencyIds(item).map(dependency =>
    board.db.prepare('SELECT item_id,item_status,item_merged_commit FROM item WHERE item_id=?').get(dependency) ?? null) : [];
  const lastEvent = board.db.prepare('SELECT MAX(event_id) AS id FROM event WHERE item_id=?').get(id)?.id ?? null;
  const meta = board.db.prepare(`SELECT meta_key,meta_value FROM board_meta WHERE meta_key IN ('row_decisions','bar_ready_setting')
    OR meta_key LIKE '%:' || ? OR meta_key LIKE '%\\_' || ? ESCAPE '\\' ORDER BY meta_key`).all(String(id), String(id));
  return JSON.stringify({ item, dependencies, lastEvent, meta, refreeze: pendingRefreeze(board, id) });
}

/**
 * Whether a prepared claim still holds: nothing wrote, or nothing it depends on changed. A typed submit admission or
 * outcome reads beyond those rows, so it keeps the whole-board check.
 */
function claimStillPrepared(board, id, { snapshot, rows, strict }) {
  if (!boardWriteSnapshotChanged(board, snapshot)) return true;
  return !strict && claimRows(board, id) === rows;
}

/** Wait a few random milliseconds outside any transaction, so contending preparations stop colliding in step. */
function jitter(attempt) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.floor(Math.random() * 20 * (attempt + 1)));
}

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
  // Only the claim's own rows count: unrelated writes at fleet rate no longer refuse it (#6016).
  // Bound preparation so a claim whose own rows keep changing still reports its contention.
  const strict = options.submitAdmission != null || options.submitOutcome != null;
  for (let attempt = 0; ; attempt++) {
    const snapshot = boardWriteSnapshot(board);
    const rows = claimRows(board, id);
    const plan = claimPlan(board, id, options, ports);
    checkedItemMove(board, id, 'claim', plan.how.checks);
    if (!claimStillPrepared(board, id, { snapshot, rows, strict })) {
      if (attempt >= CLAIM_PREPARE_ATTEMPTS - 1) throw staleBoardRefusal(board, snapshot, 'claim');
      jitter(attempt);
      continue;
    }
    const prepared = Object.freeze({ ...options });
    PREPARED_CLAIMS.set(prepared, { board, id, snapshot, rows, strict, plan });
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
  const binding = PREPARED_CLAIMS.get(prepared);
  const { snapshot, plan } = binding;
  const { agentId, head = null, reviewSkipped = null } = prepared;
  const { leaseUntil, isRenewal, admission, outcome, adopts, refreshes } = plan;
  return atomic(board, () => {
    // Under the lock only the claim's own rows are compared; the guards below read the current board (#6016).
    if (!claimStillPrepared(board, id, binding)) throw staleBoardRefusal(board, snapshot, 'claim');
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
    logEvent(board, agentId, renewed ? 'renew' : 'claim', id, { leaseUntil, digest, ...(!renewed && (board.executionEngineVersion ?? ENGINE_VERSION) >= UNTOUCHED_CLAIM_ENGINE && options.autoNext === true && options.autoNextSnapshot?.head === head && /^[0-9a-f]{64}$/u.test(options.autoNextSnapshot?.digest ?? '') ? { autoNextSnapshot: options.autoNextSnapshot } : {}), ...(!renewed && options.itemFolder === true ? { itemFolder: true } : {}), ...(!renewed && exitRules ? { exitRules, exitClaimKey: options.exitClaimKey } : {}), ...(adopts ? { adoptedCorrection: digest } : {}), ...(refreshes && frozen ? { policyRefreshed: digest } : {}), ...(!renewed && reviewSkipped ? { reviewSkipped } : {}),
      ...(!renewed && item.item_expected_build_minutes != null && (board.executionEngineVersion ?? ENGINE_VERSION) >= EXPECTED_BUILD_ENGINE ? { buildBudgetMinutes: options.buildBudgetMinutes ?? 30, expectedBuildMinutes: item.item_expected_build_minutes ?? null } : {}),
      ...(admission ? { submitAdmission: admission } : {}),
      ...(outcome ? { submitOutcome: outcome } : {}),
      ...((board.executionEngineVersion ?? ENGINE_VERSION) >= AGENT_GRANT_ENGINE ? { grantEngine: AGENT_GRANT_ENGINE } : {}) });
    const policyRefreeze = plan.policyRefreeze();
    if (!renewed && policyRefreeze) logEvent(board, agentId, 'fact', id, {
      id: randomUUID(), kind: 'note',
      text: `policy re-frozen automatically: ${policyRefreeze.before} -> ${policyRefreeze.after}; only ${policyRefreeze.changed.join(', ')} changed`,
      ref: null, supersedes: null,
    });
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

