import { seatAt } from '../item-folder-identity.js';
import { claimWorktreeSnapshot } from '../untouched-claim-observation.js';
import {
  submitHandoffActor,
  isSubmitHandoffWorker,
} from '../submit-handoff-origin.js';
import { captureLapsedClaims } from '../../packages/health/index.js';
/** Helpers for `pullboard claim`: ordered moves and the criterion freeze. Split from src/cli.js, which re-exports it [C7]. */
import { itemCheckBaseline } from '../../packages/store/index.js';
import { writeBoardCommand } from '../board-command-write.js';
import { verifiedPasskeyRowDecision } from '../../packages/person/index.js';
import { laneSeatContext } from '../../packages/seats/index.js';
import { nextSessionSeats } from '../../packages/seats/index.js';
import { seatRoutingPorts } from './seat-ports.js';
import { sessionSeatReaders } from './seat-ports.js';
import { agentSessionDigest } from '../../packages/person/index.js';
import { requireHandoffActive } from '../../packages/state/src/core/handoff-state.js';
import { requestedCommandMove } from '../../packages/state/index.js';
import { barReadinessRequired } from '../../packages/verify/index.js';
import { barReadiness } from '../../packages/verify/index.js';
import { barCoverageCommand } from '../../packages/verify/index.js';
import { barCoverageForPolicy } from '../../packages/verify/index.js';
import { gitSyncLinked } from '../../packages/store/index.js';
import { gitSyncRecoveryNeeded } from '../../packages/config/index.js';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import * as itemSessions from '../../packages/items/index.js';
import * as store from '../board.js';
import { cdTo } from '../cli-context.js';
import { context } from '../cli-context.js';
import { CHECKOUT_BOARD_ONLY } from '../cli-main.js';
import { CHECKOUT_LEASES } from '../cli-main.js';
import { main } from '../cli-main.js';
import { CONFIG_FILE } from '../../packages/config/index.js';
import { COORDINATOR } from '../../packages/config/index.js';
import { configFromSource } from '../../packages/config/index.js';
import { loadDoctrine } from '../doctrine.js';
import { agentDoctrine } from '../../packages/doctrine/index.js';
import { signedMoveProblem } from '../../packages/person/index.js';
import { bindLocalSession } from '../../packages/seats/index.js';
import { localSessionMatches } from '../../packages/seats/index.js';
import { headCommit } from '../git.js';
import { Refused } from '../../packages/kernel/index.js';
import { frozenCriterion } from '../../packages/spec/index.js';
import { mainCriterionFacts } from '../main-criterion-facts.js';
import { liveCriterionSpec } from '../main-criterion-facts.js';
import { foreignNodeOptions } from '../../packages/gate/index.js';
import { loadSpec } from '../../packages/spec/index.js';
import { refuseAgentApprovedRows } from '../../packages/spec/index.js';
import { ensureSpecApprovalCoordinator } from '../../packages/spec/index.js';
import { initialSpecApprovalBaseline } from '../../packages/spec/index.js';
import { refuseClaimProvesNothing } from '../../packages/verify/index.js';
import { firstRefusalArgs } from '../../packages/items/index.js';
import { mainPolicy } from '../../packages/sandbox/index.js';
import { policyAt } from '../../packages/sandbox/index.js';
import { itemPolicy } from '../../packages/sandbox/index.js';
import { relayLinked } from '../../packages/link/index.js';
import { relayOperation } from '../../packages/link/index.js';
import { relayRecovered } from '../../packages/link/index.js';
import { coordinatorFile } from './spec.js';
import { isReturnedRework } from '../rework-family-routing.js';
import { sealReworkRoutingPolicy } from '../rework-family-routing.js';
import { SEAT_LIVE_WINDOW_MS } from '../../packages/store/index.js';
import { maintenanceDurations } from '../../packages/config/index.js';

/** Capture accepted coordinator retirement grace beside the native line takeover window. */
export function currentReworkRoutingPolicy(ctx, board) {
  if (store.lineSettings(board).reworkSameFamily !== true) return null;
  const takeoverMinutes = store.lineSettings(board).takeoverMinutes;
  const takeoverMs = typeof takeoverMinutes === 'number' ? takeoverMinutes * 60_000 : SEAT_LIVE_WINDOW_MS;
  let graceMs;
  try { graceMs = maintenanceDurations(mainPolicy(ctx.info.root).config?.worktreeMaintenance).graceMs; }
  catch { return null; }
  if (!Number.isSafeInteger(takeoverMs) || takeoverMs < 0 || !Number.isSafeInteger(graceMs) || graceMs <= 0) return null;
  return { takeoverMs, graceMs };
}

/** Note the session behind a claim or submit (#921): its ledger must be writable before the move, and record after it. */
async function withItemSession(info, operation, args, move) { const noted = operation === 'claim' || operation === 'submit'; if (noted) itemSessions.requireLedger(info, agentSessionDigest()); const result = await move(); if (noted) itemSessions.recordItemSession(info, args[0], operation, agentSessionDigest()); return result; }

/**
 * Whether the board's committed relay.outbox setting queues moves while the relay is down (#922, H21).
 * Why: absent means enabled for existing boards; an explicit false is the shared opt-out.
 */
export function relayOutboxSetting(root) {
  try { return configFromSource(coordinatorFile(root, CONFIG_FILE).stdout).relay?.outbox !== false; } catch { return false; }
}

const LAPSE_MAINTENANCE = new WeakSet();

/** Capture bounded native liveness once before a requested write; nested bootstrap and maintenance never recurse. */
async function maintainLapsedBeforeWrite(ctx, board, operation, args, actor) {
  if (!actor || LAPSE_MAINTENANCE.has(board) || ['maintainStaleState', 'recordSpecApprovalBaseline'].includes(operation)
    || operation === 'release' && args[3]?.staleClaim) return;
  LAPSE_MAINTENANCE.add(board);
  try {
    const snapshot = captureLapsedClaims(ctx, board, actor);
    if (!snapshot) return;
    const io = { ...ctx.io, personRequest: undefined, personRequestMoveId: undefined, relayCommand: undefined, requestedCommand: undefined };
    try { await ordered({ ...ctx, io }, board, 'maintainStaleState', [{ agentId: actor, snapshot, health: ctx.config.health ?? {}, claimsOnly: true }]); }
    catch (error) {
      if (error.code !== 'STALE_STATE_CHANGED') throw error;
      ctx.io.err('Lapsed-claim observation changed; untouched claims will be observed on the next write.');
    }
  } finally { LAPSE_MAINTENANCE.delete(board); }
}

export async function ordered(ctx, board, operation, args) {
  // With signed person moves on, a person-only move counts only as a passkey-confirmed request [E22].
  const unsigned = signedMoveProblem(board, board.enginePorts.personAuthority({ operation, args }), ctx.io.personRequest, { strict: true });
  if (unsigned) throw unsigned;
  const initialBaseline = initialSpecApprovalBaseline(ctx, board, operation, { relayRecovered: (root, options) => relayRecovered(root, options, ctx.io), specApprovalBaselineExists: store.specApprovalBaselineExists });
  // Only a reject or a reopen can open a builder's first-refusal window (#954), so an accept never reads the coordinator's policy.
  if (operation === 'reopen' || operation === 'verify' && args[1]?.decision === 'REJECT') args = firstRefusalArgs(operation, args, configFromSource(coordinatorFile(ctx.info.root, CONFIG_FILE).stdout));
  ctx.io.relayOutbox ??= () => relayOutboxSetting(ctx.info.root);
  // Every engine-27 registration records the seat that made it: the coordinator from the main
  // checkout, the joined agent from its worktree, or `machine` for a join no seat made (#579).
  if (operation === 'register' && args[0] && args[0].createdBy === undefined) {
    const joined = seatAt(board, ctx.info.root)?.agent_id;
    args = [{ ...args[0], createdBy: ctx.info.isMain ? COORDINATOR : joined ?? 'machine' }, ...args.slice(1)];
  }
  const command = ['add', 'companion', 'patch', 'edit', 'merged', 'move'].includes(ctx.io.relayCommand?.cliOperation) ? ctx.io.relayCommand : undefined;
  /** Dispatch while this session holds the checkout, including long-running next/run loops. */
  const execute = async () => {
    /** Keep bootstrap in the same authenticated seat, without borrowing a person's action receipt. */
    const recordBaseline = async (agentId) => {
      const values = [{ agentId, baseline: initialBaseline }];
      const baselineIo = ctx.io.personRequest || ctx.io.personRequestMoveId
        ? { ...ctx.io, personRequest: undefined, personRequestMoveId: undefined } : ctx.io;
      return ctx.privateBoard
        ? store.recordSpecApprovalBaseline(board, ...values)
        : gitSyncLinked(ctx.info.root)
        ? (await import('../sync.js')).gitBoardOperation(ctx.info.root, board, 'recordSpecApprovalBaseline', values, baselineIo)
        : relayLinked(ctx.info.root) || relayRecovered(ctx.info.root, {}, ctx.io)
        ? relayOperation(ctx.info.root, 'recordSpecApprovalBaseline', values, baselineIo, undefined,
          () => store.recordSpecApprovalBaseline(board, ...values))
        : store.recordSpecApprovalBaseline(board, ...values);
    };
    const actor = ctx.info.isMain ? COORDINATOR : (submitHandoffActor(ctx, board, operation, args) ?? seatAt(board, ctx.info.root))?.agent_id;
    requireHandoffActive(board, actor, operation, args);
    if (!ctx.privateBoard && gitSyncRecoveryNeeded(ctx.info.root)) {
      await (await import('../../packages/sync/index.js')).repairGitSync(ctx.info.root, board, ctx.io);
    }
    ensureSpecApprovalCoordinator(ctx, board, initialBaseline, { relayLinked, relayRecovered: (root, options) => relayRecovered(root, options, ctx.io), gitSyncLinked, ensureCoordinator: store.ensureCoordinator });
    const write = () => writeBoardCommand(board, operation, args, actor);
    if (initialBaseline && actor) await recordBaseline(actor);
    await maintainLapsedBeforeWrite(ctx, board, operation, args, actor);
    const requestedCommand = ctx.io.relayCommand?.cliOperation ?? (ctx.privateBoard ? ctx.io.requestedCommand : undefined);
    const requested = requestedCommandMove(requestedCommand, operation);
    const heartbeat = requested ? (await import('../cli-presence.js')).heartbeatCommand : null;
    if (requested && operation === 'submit') heartbeat(ctx.io, { ctx, board });
    /** Observe a committed requested write before its relay checkpoint captures the presentation. */
    const observeRequested = () => {
      ctx.io.recordedMove = true;
      heartbeat(ctx.io, { ctx, board });
    };
    /** Called only for this requested operation, after its store transaction commits, never for bootstrap. */
    const applyRequested = () => {
      const before = board.lastEvent;
      const firstEvent = board.emittedEvents?.length ?? 0;
      const result = write();
      if (requested && board.lastEvent !== before) observeRequested();
      ctx.io.onOrderedMove?.({ operation, events: (board.emittedEvents?.slice(firstEvent) ?? []).map(event => ({ ...event })) });
      return result;
    };
    // Select transport before the acknowledged write; a later damaged marker cannot undo its receipt.
    const gitLinked = !ctx.privateBoard && gitSyncLinked(ctx.info.root);
    const result = await withItemSession(ctx.info, operation, args, async () => ctx.privateBoard
      ? applyRequested()
      : gitLinked
        ? (await import('../sync.js')).gitBoardOperation(ctx.info.root, board, operation, args, ctx.io)
        : relayLinked(ctx.info.root) || relayRecovered(ctx.info.root, {}, ctx.io)
          ? relayOperation(ctx.info.root, operation, args, ctx.io, command, applyRequested,
            requested ? observeRequested : undefined) : applyRequested());
    if (requested && gitLinked) ctx.io.recordedMove = true;
    await (await import('../cli-recorded-effects.js')).afterOrderedMove(ctx, board, { requested, operation, args, actor, ordered });
    return result;
  };
  const digest = agentSessionDigest();
  const boardOnly = CHECKOUT_BOARD_ONLY.get(ctx.io);
  const boardOnlyOperation = (boardOnly === 'shout' && operation === 'shout') || (boardOnly === 'fact' && operation === 'appendFact');
  const boardOnlyAgent = ctx.info.isMain ? COORDINATOR : seatAt(board, ctx.info.root)?.agent_id ?? 'unjoined agent';
  if (boardOnlyOperation && digest && localSessionMatches(ctx.info, { agent: boardOnlyAgent, digest })) return execute();
  if (isSubmitHandoffWorker(ctx) || CHECKOUT_LEASES.has(ctx.io) || !digest || ctx.io.personChannel === 'view' || ctx.io.personRequest) return execute();
  const agent = ctx.info.isMain ? COORDINATOR : seatAt(board, ctx.info.root)?.agent_id ?? 'unjoined agent';
  const lease = await bindLocalSession(ctx.info, { agent, digest, keepLease: true });
  try { return await execute(); }
  finally { lease.release(); }
}

/** Order a claim on every route (claim, next, run) only after a check green on main is not held [V4]. */
export async function claimOrdered(ctx, board, args) {
  refuseClaimProvesNothing(ctx.info.root, board, args[0], { mainPolicy });
  const adoptCorrection = store.pendingRefreeze(board, args[0]).length > 0;
  const returnedRework = store.lineSettings(board).reworkSameFamily === true && isReturnedRework(board, args[0]);
  const routingWindows = returnedRework ? currentReworkRoutingPolicy(ctx, board) : null;
  if (returnedRework && !routingWindows) throw new Refused('NO_POLICY', 'the accepted coordinator takeover and maintenance windows are unavailable; restore the current main policy before claiming returned work');
  const routingPolicy = sealReworkRoutingPolicy(routingWindows);
  const accepted = mainPolicy(ctx.info.root).config;
  const exitRules = accepted.exitRules;
  const estimate = store.getItem(board, args[0]).item_expected_build_minutes;
  const autoNextSnapshot = args[1].autoNext ? claimWorktreeSnapshot(ctx.info.root) : null;
  const result = await ordered(ctx, board, 'claim', [args[0], { ...args[1], ...(estimate == null ? {} : { buildBudgetMinutes: accepted.itemBuildBudgetMinutes ?? 30 }), ...(autoNextSnapshot ? { autoNextSnapshot } : {}), ...(exitRules?.enabled ? { exitRules, exitClaimKey: randomUUID() } : {}),
    ...(adoptCorrection ? { adoptCorrection: true, freeze: freezer(ctx, { captureVerifyPolicy: true, board }) } : {}),
    ...(routingPolicy ? { reworkRoutingPolicy: routingPolicy } : {}),
    reviewPolicy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family }]);
  if (!result.renewed && exitRules?.enabled) (await import('../exit-rules-runtime.js')).captureExitAnchor(ctx, board, args[0], args[1].agentId);
  return result;
}

/**
 * Freeze a criterion from committed policy, refreshing trunk policy only on an explicit refreeze.
 *
 * @param {any} ctx
 * @param {{ captureVerifyPolicy?: boolean }} [options]
 * @returns {(item: any) => { text: string, digest: string }}
 */
export function freezer(ctx, { captureVerifyPolicy = false, board, applyingDecisions = [] } = {}) {
  const cacheEligible = () => !foreignNodeOptions(process.env.NODE_OPTIONS);
  /** Freeze the criterion and, when requested, the trunk lane and verifier policy. */
  return (item) => {
    // Derivation starts only inside the actual callback, after prepared claim guards [B2,C7].
    const readsMain = board && !(ctx.info.isMain && !headCommit(ctx.info.root));
    let sourcePolicy = null;
    if (readsMain) {
      try { sourcePolicy = mainPolicy(ctx.info.root); }
      catch (error) {
        if (!(error instanceof Refused) || error.code !== 'NO_POLICY') throw error;
        // A primary detached for review still has its retained accepted trunk; never use candidate rows as authority.
      }
    }
    const facts = readsMain ? mainCriterionFacts(ctx.info.root,
      { ...(sourcePolicy ? { commit: sourcePolicy.commit } : {}), cacheEligible }) : null;
    const prior = item.item_frozen ? JSON.parse(item.item_frozen) : null;
    const needsPinnedPolicy = !prior || captureVerifyPolicy;
    let policy = prior?.policy ?? null;
    if (needsPinnedPolicy && !(ctx.info.isMain && !headCommit(ctx.info.root))) {
      policy = { version: 1, commit: sourcePolicy?.commit ?? mainPolicy(ctx.info.root).commit };
    }
    let config;
    if (policy && needsPinnedPolicy) {
      const commit = /^[0-9a-f]{40,64}$/.test(policy.commit ?? '')
        ? policy.commit
        : (/^[0-9a-f]{40,64}$/.test(item.item_claim_head ?? '') ? item.item_claim_head : mainPolicy(ctx.info.root).commit);
      config = policyAt(ctx.info.root, commit).config;
      policy = { version: 1, commit, verify: { policy: config.verify.policy, family: config.verify.family,
        ...(Number.isSafeInteger(config.verify.familyRelaxAt) && config.verify.familyRelaxAt > 0 ? { familyRelaxAt: config.verify.familyRelaxAt } : {}) } };
    } else {
      config = policy ? itemPolicy(ctx.info.root, { ...item, item_frozen: JSON.stringify({ policy }) }).config : ctx.config;
    }
    // Only spec apply's already validated native decision events are being materialized now [S18,V2].
    const applying = new Map(applyingDecisions.map(record => [record.event, record]));
    const decisions = board ? store.rowDecisions(board).map(record => {
      const planned = applying.get(record.event);
      const exact = planned && ['kind', 'file', 'id', 'source', 'replacement', 'text', 'decision'].every(key => planned[key] === record[key]);
      return exact ? { ...record, applied: true } : record;
    }) : [];
    const doctrine = board ? agentDoctrine(ctx, board, { facts, decisions }) : loadDoctrine(ctx.info.root, config);
    if (board) refuseAgentApprovedRows(ctx.info.root, { board, config: facts?.config ?? config, item }, { store, verifiedPasskeyRowDecision });
    const spec = board && facts ? liveCriterionSpec(ctx.info.root, facts, item, decisions) : loadSpec(ctx.info.root, config);
    const frozen = frozenCriterion(spec, item, doctrine);
    if (!policy) return frozen; // Legacy criteria retain their original digest and committed claim base.
    const signed = board && barReadinessRequired(board, item) ? barReadiness(board, item, {}, { itemCheckBaseline }).signed : null;
    const coverage = signed?.coverage ? barCoverageForPolicy(ctx.info.root, item, signed.coverage, { commit: policy.commit, config }) : null;
    const text = JSON.stringify({ ...JSON.parse(frozen.text), ...(coverage ? { sourceCheck: item.item_check, check: barCoverageCommand(item.item_check, coverage), barCoverage: coverage, barRevision: signed.revision } : {}), policy });
    return { text, digest: createHash('sha256').update(text).digest('hex') };
  };
}

/** Carry a safe main fast-forward out of the board transaction so claim can retry at the new HEAD. */
export class MainSpecMerged extends Error {
  /** Preserve the rows needed for the caller's one-line merge notice.
   * @param {string[]} rows
   */
  constructor(rows) {
    super('main advanced to include the claimed spec rows');
    this.rows = rows;
  }
}

/** Prepare the criterion after the board's other claim guards have passed.
 *
 * @param {any} ctx
 * @returns {(item: any) => { text: string, digest: string }}
 */
export function claimFreezer(ctx, board) {
  return (item) => {
    return freezer(ctx, { board })(item);
  };
}

/** Enrich the ordinary lane refusal with a clean destination owned by this session; never widen claim authority. */
export async function wrongLaneGuidance(ctx, board, me, id, error) {
  if (!(error instanceof Refused) || error.code !== 'WRONG_LANE') return error;
  const seats = nextSessionSeats(ctx, board, sessionSeatReaders);
  if (!seats) return error;
  const item = store.getItem(board, id);
  if (item.item_lane === COORDINATOR || store.ROUTES.indexOf(item.item_route) > store.ROUTES.indexOf(me.route)) return error;
  const { seat } = await laneSeatContext(ctx, board, me, item, seats, context, seatRoutingPorts);
  return new Refused('WRONG_LANE', `item #${id} is in the ${item.item_lane} lane; this checkout is in ${me.lane}. Build it in ${seat.agent} at ${seat.path}`,
    `${cdTo(seat.path)} pullboard claim ${id}`);
}

