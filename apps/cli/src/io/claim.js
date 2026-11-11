import { seatAt } from './item/folder/identity.js';
import { claimWorktreeSnapshot } from '../../../../packages/seats/index.js';
import {
  submitHandoffActor,
  isSubmitHandoffWorker,
} from '../../../../packages/sandbox/index.js';
import { captureLapsedClaims } from '../../../../packages/health/index.js';
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
import { firstRefusalArgs } from '../../../../packages/items/index.js';
import { mainPolicy } from '../../../../packages/sandbox/index.js';
import { laneOf } from '../../../../packages/seats/index.js';
import { policyAt } from '../../../../packages/sandbox/index.js';
import { relayLinked } from '../../../../packages/link/index.js';
import { relayOperation } from '../../../../packages/link/index.js';
import { relayRecovered } from '../../../../packages/link/index.js';
import { coordinatorFile } from './spec.js';
import { isReturnedRework } from '../../../../packages/store/index.js';
import { sealReworkRoutingPolicy } from '../../../../packages/store/index.js';
import { SEAT_LIVE_WINDOW_MS } from '../../../../packages/store/index.js';
import { maintenanceDurations } from '../../../../packages/config/index.js';
import { contains } from '../../../../packages/git/index.js';
import { criterionFreezer } from '../../../../packages/moves/index.js';
import { isDeepStrictEqual } from 'node:util';
import { sessionRoute } from './route.js';

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

const LAPSE_MAINTENANCE = new WeakSet();

/**
 * Expire lapsed leases once before a requested write; nested bootstrap and maintenance never recurse.
 * Why lapsed only: it reads board rows and presence, no Git. Live-claim idle checks run in background maintenance (#2427).
 */
async function maintainLapsedBeforeWrite(ctx, board, operation, args, actor) {
  if (!actor || LAPSE_MAINTENANCE.has(board) || ['maintainStaleState', 'recordSpecApprovalBaseline'].includes(operation)
    || operation === 'release' && args[3]?.staleClaim) return;
  // An interrupted relay move owes its caller the original outcome; a maintenance move first would hide it behind RELAY_RETRY_PENDING.
  if (relayRecovered(ctx.info.root, { includePending: true }, ctx.io)) return;
  LAPSE_MAINTENANCE.add(board);
  try {
    const snapshot = captureLapsedClaims(ctx, board, actor, { lapsedOnly: true });
    if (!snapshot) return;
    const io = { ...ctx.io, personRequest: undefined, personRequestMoveId: undefined, relayCommand: undefined, requestedCommand: undefined };
    try { await ordered({ ...ctx, io }, board, 'maintainStaleState', [{ agentId: actor, snapshot, health: ctx.config.health ?? {}, claimsOnly: true }]); }
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
    const heartbeat = requested ? (await import('./presence.js')).heartbeatCommand : null;
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
 * Decide whether a new claim can refresh policy metadata in place, re-freezing this one item [C7].
 *
 * Why: policy outside the bar (gate inputs, other lanes, the item lane's owns list) moves often and never changes what the
 * bar means, so the claim re-pins it in its own write; a changed verify or check rule, a named file that changed lanes
 * (L2) or a row that no longer resolves (V3) would change the bar, so only those still refuse, naming who acts. A shrunk
 * owns list is judged like another lane's owns change: by the named paths it moves, never by the list alone (#3793).
 *
 * @param {any} ctx
 * @param {any} board
 * @param {number|string} id
 * @param {string} agentId
 * @returns {Promise<any | null>} changed policy digest witness when a safe refresh is needed
 */
async function refreshesLanePolicy(ctx, board, id, agentId) {
  const item = store.getItem(board, id);
  let frozen = null;
  try { frozen = item.item_frozen ? JSON.parse(item.item_frozen) : null; } catch { return null; }
  const pinned = frozen?.policy?.commit;
  if (!item.item_frozen_digest || !/^[0-9a-f]{40,64}$/u.test(pinned ?? '')) return null;
  let current;
  let old;
  try { current = mainPolicy(ctx.info.root); old = policyAt(ctx.info.root, pinned); } catch { return null; }
  if (current.commit === pinned) return null;
  const stale = reason => new Refused('NO_POLICY', `#${item.item_id} is frozen against an older accepted policy: ${reason}`,
    `nothing for the builder; take other work (pullboard next) while the coordinator refreezes #${item.item_id}`);
  if (!contains(ctx.info.root, pinned, current.commit)) throw stale('accepted main no longer contains its frozen policy commit');
  if (item.item_status === 'claimed' && item.item_owner === agentId && store.isHeld(board, item)) return false;
  const changed = [...new Set([...Object.keys(old.config), ...Object.keys(current.config)])].sort()
    .flatMap(key => changedPolicyLeaves(old.config[key], current.config[key], key));
  if (!changed.length) return null;
  const lane = `lanes.${item.item_lane}`;
  // The lane's owns list only decides which lane each path is in (L2); the moved check below refuses a named path it moves.
  const owns = current.config.lanes?.[item.item_lane]?.owns;
  const stillOwns = Array.isArray(old.config.lanes?.[item.item_lane]?.owns) && Array.isArray(owns) && owns.length > 0;
  const inBar = changed.filter(key => ['verify', 'check'].some(name => key === name || key.startsWith(`${name}.`))
    || ((key === lane || key.startsWith(`${lane}.`)) && !(key === `${lane}.owns` && stillOwns)));
  if (inBar.length) throw stale(`${inBar.join(', ')} changed what its bar means`);
  const { barPaths } = await import('./commands/add.js');
  const moved = barPaths({ criterion: item.item_criterion, check: item.item_check, brief: item.item_brief })
    .filter(path => laneOf(old.config, path) !== laneOf(current.config, path));
  if (moved.length) throw stale(`its named ${moved.map(path => `${path} moved lanes (${laneOf(old.config, path)} -> ${laneOf(current.config, path)})`).join(', ')}`);
  // Rows re-read from accepted main must still give the frozen bar; a moved row gate or criterion needs a real refreeze.
  let rows;
  try { rows = freezer(ctx, { board })(item).digest; } catch { return null; } // the claim's own freeze reports it
  if (rows !== item.item_frozen_digest) throw stale('its spec rows no longer resolve to the frozen bar');
  const digest = config => createHash('sha256').update(JSON.stringify(config, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value)).digest('hex');
  return { before: digest(old.config), after: digest(current.config), changed };
}

/** Return changed policy leaves in stable order without treating object key order as a policy change. */
function changedPolicyLeaves(before, after, prefix) {
  if (isDeepStrictEqual(before, after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
      .flatMap(key => changedPolicyLeaves(before[key], after[key], `${prefix}.${key}`));
  }
  return [prefix];
}

/** Order a claim on every route (claim, next, run) only after a check green on main is not held [V4]. */
export async function claimOrdered(ctx, board, args) {
  refuseClaimProvesNothing(ctx.info.root, board, args[0], { mainPolicy });
  const policyRefreeze = await refreshesLanePolicy(ctx, board, args[0], args[1].agentId);
  const refreshPolicy = Boolean(policyRefreeze);
  const adoptCorrection = store.pendingRefreeze(board, args[0]).length > 0;
  const returnedRework = store.lineSettings(board).reworkSameFamily === true && isReturnedRework(board, args[0]);
  const routingWindows = returnedRework ? currentReworkRoutingPolicy(ctx, board) : null;
  if (returnedRework && !routingWindows) throw new Refused('NO_POLICY', 'the accepted coordinator takeover and maintenance windows are unavailable; restore the current main policy before claiming returned work');
  const routingPolicy = sealReworkRoutingPolicy(routingWindows);
  const accepted = mainPolicy(ctx.info.root).config;
  const exitRules = accepted.exitRules;
  const held = store.getItem(board, args[0]);
  if (exitRules?.enabled && !(held.item_status === 'claimed' && held.item_owner === args[1].agentId)) {
    const refusal = (await import('./exit/rules.js')).contextCeilingRefusal(exitRules);
    if (refusal) throw refusal;
  }
  const estimate = held.item_expected_build_minutes;
  const autoNextSnapshot = args[1].autoNext ? claimWorktreeSnapshot(ctx.info.root) : null;
  // The claiming session's declared model caps its seat's route, so a light-route session in a strong seat cannot claim strong work (#3678).
  const seat = store.agentById(board, args[1].agentId);
  const sessionCap = seat && seat.agent_lane !== COORDINATOR ? sessionRoute(seat.agent_route, seat.agent_model, process.env.PULLBOARD_MODEL, ctx.config.modelTiers) : null;
  const routeCap = sessionCap && sessionCap !== seat.agent_route ? sessionCap : null;
  const result = await ordered(ctx, board, 'claim', [args[0], { ...args[1], ...(estimate == null ? {} : { buildBudgetMinutes: accepted.itemBuildBudgetMinutes ?? 30 }), ...(autoNextSnapshot ? { autoNextSnapshot } : {}), ...(exitRules?.enabled ? { exitRules, exitClaimKey: randomUUID() } : {}),
    ...(adoptCorrection ? { adoptCorrection: true, freeze: freezer(ctx, { captureVerifyPolicy: true, board }) } : {}),
    ...(refreshPolicy && !adoptCorrection ? { refreshPolicy: true, freeze: item => ({
      ...freezer(ctx, { captureVerifyPolicy: true, board })(item), policyRefreeze,
    }) } : {}),
    ...(routingPolicy ? { reworkRoutingPolicy: routingPolicy } : {}),
    ...(routeCap ? { routeCap } : {}),
    reviewPolicy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family }]);
  if (!result.renewed && exitRules?.enabled) (await import('./exit/rules.js')).captureExitAnchor(ctx, board, args[0], args[1].agentId);
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
  return criterionFreezer({ root: ctx.info.root, isMain: ctx.info.isMain, config: ctx.config }, options);
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

