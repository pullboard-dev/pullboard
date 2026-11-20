/** @pullboard-module-loads packages/health/src/io/stale/state/capture.js packages/moves/index.js */
import { seatAt } from './item/folder/identity.js';
import { environmentAdapter } from '../../../../packages/env/index.js';
import { claimWorktreeSnapshot } from '../../../../packages/seats/index.js';
import {
  submitHandoffActor,
  isSubmitHandoffWorker,
} from '../../../../packages/sandbox/index.js';
/** Helpers for `pullboard claim`: ordered moves and the criterion freeze. Split from src/cli.js, which re-exports it [C7]. */
import { writeBoardCommand } from '../../../../packages/store/index.js';
import { laneSeatContext } from '../../../../packages/seats/index.js';
import { nextSessionSeats } from '../../../../packages/seats/index.js';
import { primaryCheckoutRoot } from './worktree.js';
import { seatRoutingPorts } from './ports/seat.js';
import { sessionSeatReaders } from './ports/seat.js';
import { agentSessionDigest } from '../../../../packages/person/index.js';
import { requireHandoffActive } from '../../../../packages/state/light.js';
import { requestedCommandMove } from '../../../../packages/state/index.js';
import { gitSyncLinked } from '../../../../packages/store/index.js';
import { gitSyncRecoveryNeeded } from '../../../../packages/config/index.js';
import { relaxRequiredFamilyEnabled } from '../../../../packages/config/index.js';
import { nextLightShapedStrong } from '../../../../packages/config/index.js';
import { lightShaped } from '../../../../packages/seats/index.js';
import { claimCheckCeilingEnabled } from '../../../../packages/config/index.js';
import { checkVerdict } from '../../../../packages/config/index.js';
import { frozenCheckCeilingMs } from '../../../../packages/config/index.js';
import { itemCheckBaseline } from '../../../../packages/store/light.js';

/**
 * Route a write through Git only once origin accepted the board's first push [C7]; a marker it never
 * accepted warns and writes local-only, so a refused push cannot freeze the board.
 */
async function gitSyncOn(ctx, board) {
  if (!gitSyncLinked(ctx.info.root)) return false;
  if ((await import('../../../../packages/sync/index.js')).gitSyncAcknowledged(ctx.info.root, board)) return true;
  (await import('./sync.js')).warnGitSyncLocalOnly(ctx.io);
  return false;
}
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { recordCheckpoint } from './seat-checkpoint.js';
import { sealExitCheckpoints } from './exit/checkpoint.js';
import * as itemSessions from '../../../../packages/items/index.js';
import * as store from '../../../../packages/store/index.js';
import { cdTo } from './context.js';
import { context } from './context.js';
import { CHECKOUT_BOARD_ONLY } from './main.js';
import { CHECKOUT_LEASES } from './main.js';
import { main } from './main.js';
import { CONFIG_FILE } from '../../../../packages/config/index.js';
import { COORDINATOR } from '../../../../packages/config/index.js';
import { configFromSource } from '../../../../packages/config/index.js';
import { signedMoveProblem } from '../../../../packages/person/index.js';
import { bindLocalSession } from '../../../../packages/seats/index.js';
import { localSessionMatches } from '../../../../packages/seats/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { ensureSpecApprovalCoordinator } from '../../../../packages/spec/index.js';
import { initialSpecApprovalBaseline } from '../../../../packages/spec/index.js';
import { refuseClaimProvesNothing } from '../../../../packages/verify/index.js';
import { refuseClaimMissingPaths } from './item/bar.js';
import { refuseClaimCrossOwnership } from './item/bar.js';
import { firstRefusalArgs } from '../../../../packages/items/index.js';
import { mainPolicy } from '../../../../packages/sandbox/index.js';
import { relayLinked } from '../../../../packages/link/index.js';
import { relayOperation } from '../../../../packages/link/index.js';
import { relayRecovered } from '../../../../packages/link/index.js';
import { coordinatorFile } from './coordinator-file.js';
import { isReturnedRework } from '../../../../packages/store/index.js';
import { sealReworkRoutingPolicy } from '../../../../packages/store/index.js';
import { SEAT_LIVE_WINDOW_MS } from '../../../../packages/store/index.js';
import { maintenanceDurations } from '../../../../packages/config/index.js';
import { relayQueueOnFailureEnabled } from '../../../../packages/config/index.js';
import { flakesRereadRatchetEnabled } from '../../../../packages/config/index.js';
import { lapsedSweepEnabled } from '../../../../packages/config/index.js';
import { createRequire } from 'node:module';
import { sessionRoute } from './route.js';

/** claims.perSeat from one accepted config, or null when it leaves N to the board. */
function seatCapOf(config) {
  const n = config?.claims?.perSeat;
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * The claims.perSeat a claim on this board obeys: accepted main's committed config, never this seat's checkout [C7,#10831].
 * Why: a seat on a stale or edited branch read its own pullboard.json and sealed N = 5 into its claims after main set 1,
 * so one builder held 6-8 claims per next. mainPolicy caches the committed bytes by commit, and the claim reads the same
 * policy, so next runs no extra Git process for it.
 *
 * @param {any} ctx
 * @returns {number | null}
 */
export function trunkPerSeat(ctx) {
  return seatCapOf(mainPolicy(ctx.info.root).config);
}

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

export { relayOutboxSetting } from './relay-outbox.js';
import { relayOutboxSetting } from './relay-outbox.js';

/** The lapsed-claim capture and the criterion freezer load at the claim that runs them, never with the command [C7,#7081]. */
const requireModule = createRequire(import.meta.url);

const LAPSE_MAINTENANCE = new WeakSet();

/**
 * Expire lapsed leases once before a requested write; nested bootstrap and maintenance never recurse.
 * Why lapsed only: it reads board rows and presence, no Git. Live-claim idle checks run in background maintenance (#2427).
 * With health.lapsedSweep on the sentinel owns this pass, so a claim, submit or verify issues only its own board write [C7,#8924].
 * @param {{ lapsedOn?: () => boolean, capture?: Function, recovered?: Function }} [ports] Test seams for the setting read, the relay check and the lapsed capture.
 */
export async function maintainLapsedBeforeWrite(ctx, board, operation, args, actor, ports = {}) {
  if (!actor || (ports.lapsedOn ?? lapsedSweepEnabled)() || LAPSE_MAINTENANCE.has(board) || ['maintainStaleState', 'recordSpecApprovalBaseline'].includes(operation)
    || operation === 'release' && args[3]?.staleClaim) return;
  // An interrupted relay move owes its caller the original outcome; a maintenance move first would hide it behind RELAY_RETRY_PENDING.
  if ((ports.recovered ?? relayRecovered)(ctx.info.root, { includePending: true }, ctx.io)) return;
  LAPSE_MAINTENANCE.add(board);
  try {
    const captureLapsedClaims = ports.capture ?? requireModule('../../../../packages/health/src/io/stale/state/capture.js').captureLapsedClaims;
    const snapshot = captureLapsedClaims(ctx, board, actor, { lapsedOnly: true });
    if (!snapshot) return;
    const io = { ...ctx.io, personRequest: undefined, personRequestMoveId: undefined, relayCommand: undefined, requestedCommand: undefined };
    // The observation is this command's own write: a snapshot a move prepared before it (submit's) must survive it (#5327).
    try { await store.acknowledgeOwnWrites(board, () => ordered({ ...ctx, io }, board, 'maintainStaleState', [{ agentId: actor, snapshot, health: ctx.config.health ?? {}, claimsOnly: true }])); }
    catch (error) {
      if (error.code !== 'STALE_STATE_CHANGED') throw error;
      ctx.io.err('Lapsed-claim observation changed; untouched claims will be observed on the next write.');
    }
  } finally { LAPSE_MAINTENANCE.delete(board); }
}

export async function ordered(ctx, board, operation, args, { prepareInWriter } = {}) {
  // With signed person moves on, a person-only move counts only as a passkey-confirmed request [E22].
  const unsigned = signedMoveProblem(board, board.enginePorts.personAuthority({ operation, args }), ctx.io.personRequest, { strict: true });
  if (unsigned) throw unsigned;
  const initialBaseline = initialSpecApprovalBaseline(ctx, board, operation, { relayRecovered: (root, options) => relayRecovered(root, options, ctx.io), specApprovalBaselineExists: store.specApprovalBaselineExists });
  // Only a reject or a reopen can open a builder's first-refusal window (#954), so an accept never reads the coordinator's policy.
  if (operation === 'reopen' || operation === 'verify' && args[1]?.decision === 'REJECT') args = firstRefusalArgs(operation, args, configFromSource(coordinatorFile(ctx.info.root, CONFIG_FILE).stdout));
  // The re-read setting is read here, at the caller, and travels in the move's args so a replica replays the same decision (#10085).
  if (operation === 'recordLandingBatch' && args[0] && args[0].rereadRatchet === undefined) args = [{ ...args[0], rereadRatchet: flakesRereadRatchetEnabled() }, ...args.slice(1)];
  ctx.io.relayOutbox ??= () => relayOutboxSetting(ctx.info.root);
  ctx.io.relayQueueOnFailure ??= relayQueueOnFailureEnabled;
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
        : await gitSyncOn(ctx, board)
        ? (await import('../../../../packages/sync/index.js')).gitBoardOperation(ctx.info.root, board, 'recordSpecApprovalBaseline', values, baselineIo)
        : relayLinked(ctx.info.root) || relayRecovered(ctx.info.root, {}, ctx.io)
        ? relayOperation(ctx.info.root, 'recordSpecApprovalBaseline', values, baselineIo, undefined,
          () => store.recordSpecApprovalBaseline(board, ...values))
        : store.recordSpecApprovalBaseline(board, ...values);
    };
    const actor = ctx.info.isMain ? COORDINATOR : (submitHandoffActor(ctx, board, operation, args) ?? seatAt(board, ctx.info.root))?.agent_id;
    requireHandoffActive(board, actor, operation, args);
    if (!ctx.privateBoard && gitSyncRecoveryNeeded(ctx.info.root)) {
      await (await import('../../../../packages/sync/index.js')).repairGitSync(ctx.info.root, board, ctx.io);
    }
    ensureSpecApprovalCoordinator(ctx, board, initialBaseline, { relayLinked, relayRecovered: (root, options) => relayRecovered(root, options, ctx.io), gitSyncLinked, ensureCoordinator: store.board_ensureCoordinator });
    const write = (localWriter = true) => writeBoardCommand(board, operation, args, actor,
      localWriter && prepareInWriter ? { prepareInWriter } : undefined);
    if (initialBaseline && actor) await recordBaseline(actor);
    await maintainLapsedBeforeWrite(ctx, board, operation, args, actor);
    const requestedCommand = ctx.io.relayCommand?.cliOperation ?? (ctx.privateBoard ? ctx.io.requestedCommand : undefined);
    const requested = requestedCommandMove(requestedCommand, operation);
    const { heartbeatCommand, claimHeartbeatOverlaps } = requested ? await import('./presence.js') : {};
    const heartbeat = requested ? (io, options) => heartbeatCommand(io, { ...options, overlaps: claimHeartbeatOverlaps(io) }) : null;
    if (requested && operation === 'submit') heartbeat(ctx.io, { ctx, board });
    /** Observe a committed requested write before its relay checkpoint captures the presentation. */
    const observeRequested = () => {
      ctx.io.recordedMove = true;
      heartbeat(ctx.io, { ctx, board });
    };
    /** Called only for this requested operation, after its store transaction commits, never for bootstrap. */
    const applyRequested = ({ localWriter = true } = {}) => {
      const before = board.lastEvent;
      const firstEvent = board.emittedEvents?.length ?? 0;
      const result = write(localWriter);
      if (requested && board.lastEvent !== before) observeRequested();
      ctx.io.onOrderedMove?.({ operation, events: (board.emittedEvents?.slice(firstEvent) ?? []).map(event => ({ ...event })) });
      return result;
    };
    // Select transport before the acknowledged write; a later damaged marker cannot undo its receipt.
    const gitLinked = !ctx.privateBoard && await gitSyncOn(ctx, board);
    const relayLinkedHere = !ctx.privateBoard && (relayLinked(ctx.info.root) || relayRecovered(ctx.info.root, {}, ctx.io));
    const throughLinkedTransport = async () => {
      for (let attempt = 0; ; attempt++) {
        let candidate;
        try {
          if (prepareInWriter) {
            candidate = prepareInWriter(board);
            args.splice(0, args.length, ...candidate.args);
          }
          return gitLinked
            ? await (await import('../../../../packages/sync/index.js')).gitBoardOperation(ctx.info.root, board, operation, args, ctx.io)
            : await relayOperation(ctx.info.root, operation, args, ctx.io, command, () => applyRequested({ localWriter: false }),
              requested ? observeRequested : undefined);
        } catch (error) {
          candidate?.rollback?.();
          if (!prepareInWriter || error?.code !== 'STALE_ROW_DECISION' || attempt >= 2) throw error;
        }
      }
    };
    const result = await withItemSession(ctx.info, operation, args, async () => ctx.privateBoard
      ? applyRequested()
      : gitLinked || relayLinkedHere
        ? throughLinkedTransport()
        : applyRequested());
    if (requested && gitLinked) ctx.io.recordedMove = true;
    await (await import('./effects.js')).afterOrderedMove(ctx, board, { requested, operation, args, actor, ordered });
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

/**
 * Note a pulled submit in the agent-session ledger as the board move did: check the ledger is writable first, record once the gate job is offered.
 *
 * Why: the pulled submit queues its gate and the runner's receipt applies the move, so no session wrote the ledger row that `verify` reads to refuse the builder's own session [V1,B3,#7725].
 */
export function noteSubmitSession(info, id, record) { return record ? itemSessions.recordItemSession(info, id, 'submit', agentSessionDigest()) : itemSessions.requireLedger(info, agentSessionDigest()); }

/**
 * Whether a fresh claim drops a legacy pinned policy from this item's frozen bar, re-freezing it bar-only [B4,R2].
 *
 * Why: a bar frozen by the previous release pins a whole pullboard.json commit, and every later policy commit made that
 * pin stale and stranded the item NO_POLICY. Policy is read live per move now, so a fresh claim never compares policies:
 * it re-freezes the bar alone and the legacy item frees itself. A renewal keeps its bar, so in-flight work is untouched.
 *
 * @param {any} board
 * @param {number|string} id
 * @param {string} agentId
 * @returns {boolean}
 */
function dropsLegacyPolicyPin(board, id, agentId) {
  const item = store.getItem(board, id);
  if (!item.item_frozen_digest) return false;
  let frozen = null;
  try { frozen = item.item_frozen ? JSON.parse(item.item_frozen) : null; } catch { return false; }
  if (!frozen?.policy) return false;
  return !(item.item_status === 'claimed' && item.item_owner === agentId && store.isHeld(board, item));
}

/** Order a claim on every route (claim, next, run) only after a check green on main is not held, the bar's paths exist and its files are its lane's [V4,C7]. */
export async function claimOrdered(ctx, board, args) {
  refuseClaimProvesNothing(ctx.info.root, board, args[0], { mainPolicy });
  await refuseClaimMissingPaths(ctx, board, args[0]);
  const refreshPolicy = dropsLegacyPolicyPin(board, args[0], args[1].agentId);
  const adoptCorrection = store.pendingRefreeze(board, args[0]).length > 0;
  const returnedRework = store.lineSettings(board).reworkSameFamily === true && isReturnedRework(board, args[0]);
  const routingWindows = returnedRework ? currentReworkRoutingPolicy(ctx, board) : null;
  if (returnedRework && !routingWindows) throw new Refused('NO_POLICY', 'the accepted coordinator takeover and maintenance windows are unavailable; restore the current main policy before claiming returned work');
  const routingPolicy = sealReworkRoutingPolicy(routingWindows);
  const accepted = mainPolicy(ctx.info.root).config;
  // One ownership answer for every seat and route: main's lanes, judged by the files the item changes [C7,#11857].
  refuseClaimCrossOwnership(ctx, board, args[0], args[1].agentId, accepted);
  const perSeat = seatCapOf(accepted);
  const exitRules = accepted.exitRules;
  const held = store.getItem(board, args[0]);
  if (exitRules?.enabled && !(held.item_status === 'claimed' && held.item_owner === args[1].agentId)) {
    const refusal = (await (await import('./exit/rules.js')).loadExitRules()).contextCeilingRefusal(exitRules);
    if (refusal) throw refusal;
  }
  // A budget at its stop line refuses a new claim only; a claim the seat already holds renews, so nothing stops mid-item [N2].
  if (!(held.item_status === 'claimed' && held.item_owner === args[1].agentId)) {
    const { budgetClaimRefusal, machineBudgetState } = await import('../../../../packages/stats/light.js');
    const refusal = budgetClaimRefusal(machineBudgetState(board, Date.now()));
    if (refusal) throw refusal;
  }
  const estimate = held.item_expected_build_minutes;
  const autoNextSnapshot = args[1].autoNext ? claimWorktreeSnapshot(ctx.info.root) : null;
  // The claiming session's declared model caps its seat's route, so a light-route session in a strong seat cannot claim strong work (#3678).
  const seat = store.agentById(board, args[1].agentId);
  const sessionCap = seat && seat.agent_lane !== COORDINATOR ? sessionRoute(seat.agent_route, seat.agent_model, environmentAdapter().get('PULLBOARD_MODEL'), ctx.config.modelTiers) : null;
  const routeCap = sessionCap && sessionCap !== seat.agent_route ? sessionCap : null;
  const result = await ordered(ctx, board, 'claim', [args[0], { ...args[1], ...(estimate == null ? {} : { buildBudgetMinutes: accepted.itemBuildBudgetMinutes ?? 30 }), ...(autoNextSnapshot ? { autoNextSnapshot } : {}), ...(exitRules?.enabled ? { exitRules: sealExitCheckpoints(ctx.config, exitRules), exitClaimKey: randomUUID() } : {}),
    ...(adoptCorrection ? { adoptCorrection: true, freeze: freezer(ctx, { captureVerifyPolicy: true, board }) } : {}),
    ...(refreshPolicy && !adoptCorrection ? { refreshPolicy: true, freeze: freezer(ctx, { captureVerifyPolicy: true, board }) } : {}),
    ...(routingPolicy ? { reworkRoutingPolicy: routingPolicy } : {}),
    ...(routeCap ? { routeCap } : {}), ...(nextLightShapedStrong() && lightShaped(held) ? { shapedStrong: true } : {}), ...(perSeat === null ? {} : { perSeat }),
    // The gate waits and N this computer reads travel in the move, so a replay after an outage decides alike (#7775).
    ...store.claimAdmission(board, args[0], args[1].agentId, perSeat, { runs: store.boardRunsReader(board, ctx.file) }),
    reviewPolicy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family }]);
  if (!result.renewed && exitRules?.enabled) (await (await import('./exit/rules.js')).loadExitRules()).captureExitAnchor(ctx, board, args[0], args[1].agentId);
  // seat.checkpoints (off by default): a fresh claim records what is left to build; a renewal or a correction re-claim records nothing [C7,#8549].
  if (!result.renewed && !adoptCorrection && !refreshPolicy) await recordCheckpoint(ctx, board, { item: args[0], agent: args[1].agentId, moment: 'claim', parts: { left: [`build #${args[0]}: ${held.item_title}`], evidence: args[1].head ? [`claim head ${args[1].head}`] : [] } }, ordered);
  return result;
}

/**
 * Freeze a criterion with the claim move's one freezer, read from this checkout's root and config [C7].
 *
 * @param {any} ctx
 * @param {{ captureVerifyPolicy?: boolean, board?: any, applyingDecisions?: any[] }} [options]
 * @returns {(item: any) => { text: string, digest: string }}
 */
export function freezer(ctx, options = {}) {
  const freeze = requireModule('../../../../packages/moves/index.js').criterionFreezer({ root: ctx.info.root, isMain: ctx.info.isMain, config: ctx.config }, options);
  return (item) => {
    const frozen = freeze(item);
    // With review.relaxRequiredFamily on, an item with a required review family freezes the backlog threshold, the one authority a relaxation witness is checked against [C7,#11119].
    const relaxAt = ctx.config.verify?.familyRelaxAt;
    if (!item.item_review_family || !Number.isSafeInteger(relaxAt) || relaxAt < 1 || !relaxRequiredFamilyEnabled()) return frozen;
    const parsed = JSON.parse(frozen.text);
    const text = JSON.stringify({ ...parsed, policy: { ...parsed.policy, verify: { ...parsed.policy?.verify, familyRelaxAt: relaxAt } } });
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
    // With claim.checkCeiling on, an item whose recorded check measured over its ceiling is refused here; a pending or unmeasured baseline claims as before [C7,#1273].
    if (claimCheckCeilingEnabled()) {
      const baseline = itemCheckBaseline(board, item);
      if (baseline) checkVerdict({ measuredMs: typeof baseline.seconds === number ? baseline.seconds * 1000 : undefined, ceilingMs: frozenCheckCeilingMs(ctx.config), remeasurePending: baseline.result === pending, strict: false });
    }
    return freezer(ctx, { board })(item);
  };
}

/** Enrich the ordinary lane refusal with where to build the item; never widen claim authority and never open a seat (GH #16, #27). */
export async function wrongLaneGuidance(ctx, board, me, id, error) {
  if (!(error instanceof Refused) || error.code !== 'WRONG_LANE') return error;
  const item = store.getItem(board, id);
  if (item.item_lane === COORDINATOR || store.ROUTES.indexOf(item.item_route) > store.ROUTES.indexOf(me.route)) return error;
  const seats = nextSessionSeats(ctx, board, sessionSeatReaders);
  const free = seats ? (await laneSeatContext(ctx, board, me, item, seats, context, { ...seatRoutingPorts, open: false })).seat : null;
  const message = `item #${id} is in the ${item.item_lane} lane; this checkout is in ${me.lane}`;
  if (free) return new Refused('WRONG_LANE', `${message}. Build it in ${free.agent} at ${free.path}`, `${cdTo(free.path)} pullboard claim ${id}`);
  const primary = primaryCheckoutRoot(ctx.info);
  const open = `${primary ? `${cdTo(primary)} ` : ''}pullboard worktree ${item.item_lane} --model "${me.model ?? '<model name>'}"`;
  return new Refused('WRONG_LANE', `${message}. No seat was opened; open one in the ${item.item_lane} lane and claim it there`, `${open}, then in that worktree: pullboard claim ${id}`);
}

