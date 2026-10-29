/** Helpers for `pullboard claim`: ordered moves and the criterion freeze. Split from src/cli.js, which re-exports it [C7]. */
import { itemCheckBaseline } from '../board-query.js';
import { writeBoardCommand } from '../board-command-write.js';
import { verifiedPasskeyRowDecision } from '../person-row-proof.js';
import { laneSeatContext } from '../seat-checkout.js';
import { nextSessionSeats } from '../seat-checkout.js';
import * as personIdentity from '../person.js';
import { requireHandoffActive } from '../../packages/state/src/core/handoff-state.js';
import { requestedCommandMove } from '../recorded-move.js';
import { barReadinessRequired } from '../bar-readiness.js';
import { barReadiness } from '../bar-readiness.js';
import { barCoverageCommand } from '../bar-coverage.js';
import { barCoverageForPolicy } from '../bar-coverage.js';
import { gitSyncLinked } from '../local-state.js';
import { createHash } from 'node:crypto';
import * as itemSessions from '../item-sessions.js';
import * as store from '../board.js';
import { cdTo } from '../cli-context.js';
import { context } from '../cli-context.js';
import { CHECKOUT_BOARD_ONLY } from '../cli-main.js';
import { CHECKOUT_LEASES } from '../cli-main.js';
import { main } from '../cli-main.js';
import { CONFIG_FILE } from '../config.js';
import { COORDINATOR } from '../config.js';
import { configFromSource } from '../config.js';
import { loadDoctrine } from '../doctrine.js';
import { agentDoctrine } from '../doctrine-rulings.js';
import { signedMoveProblem } from '../person-signing.js';
import { bindLocalSession } from '../agent-session.js';
import { localSessionMatches } from '../agent-session.js';
import { contains } from '../git.js';
import { git } from '../git.js';
import { headCommit } from '../git.js';
import { isClean } from '../git.js';
import { mainCheckout } from '../git.js';
import { tryGit } from '../git.js';
import { untracked } from '../git.js';
import { Refused } from '../refused.js';
import { frozenCriterion } from '../spec.js';
import { loadSpec } from '../spec.js';
import { parseSpec } from '../spec.js';
import { refuseAgentApprovedRows } from '../spec-approval.js';
import { ensureSpecApprovalCoordinator } from '../spec-approval-bootstrap.js';
import { initialSpecApprovalBaseline } from '../spec-approval-bootstrap.js';
import { refuseClaimProvesNothing } from '../check-accept.js';
import { firstRefusalArgs } from '../claims.js';
import { mainPolicy } from '../trusted-policy.js';
import { policyAt } from '../trusted-policy.js';
import { itemPolicy } from '../trusted-policy.js';
import { relayLinked } from '../relay.js';
import { relayOperation } from '../relay.js';
import { relayRecovered } from '../relay.js';
import { coordinatorFile } from './spec.js';

/** Note the session behind a claim or submit (#921): its ledger must be writable before the move, and record after it. */
async function withItemSession(info, operation, args, move) { const noted = operation === 'claim' || operation === 'submit'; if (noted) itemSessions.requireLedger(info, personIdentity.agentSessionDigest()); const result = await move(); if (noted) itemSessions.recordItemSession(info, args[0], operation, personIdentity.agentSessionDigest()); return result; }

/**
 * Whether the board's committed relay.outbox setting queues moves while the relay is down (#922, H21).
 * Why: absent means enabled for existing boards; an explicit false is the shared opt-out.
 */
export function relayOutboxSetting(root) {
  try { return configFromSource(coordinatorFile(root, CONFIG_FILE).stdout).relay?.outbox !== false; } catch { return false; }
}

export async function ordered(ctx, board, operation, args) {
  // With signed person moves on, a person-only move counts only as a passkey-confirmed request [E22].
  const unsigned = signedMoveProblem(board, board.enginePorts.personAuthority({ operation, args }), ctx.io.personRequest, { strict: true });
  if (unsigned) throw unsigned;
  const initialBaseline = initialSpecApprovalBaseline(ctx, board, operation, { relayRecovered, specApprovalBaselineExists: store.specApprovalBaselineExists });
  // Only a reject or a reopen can open a builder's first-refusal window (#954), so an accept never reads the coordinator's policy.
  if (operation === 'reopen' || operation === 'verify' && args[1]?.decision === 'REJECT') args = firstRefusalArgs(operation, args, configFromSource(coordinatorFile(ctx.info.root, CONFIG_FILE).stdout));
  ctx.io.relayOutbox ??= () => relayOutboxSetting(ctx.info.root);
  // Every engine-27 registration records the seat that made it: the coordinator from the main
  // checkout, the joined agent from its worktree, or `machine` for a join no seat made (#579).
  if (operation === 'register' && args[0] && args[0].createdBy === undefined) {
    const joined = store.agentAt(board, ctx.info.root)?.agent_id;
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
        : relayLinked(ctx.info.root) || relayRecovered(ctx.info.root)
        ? relayOperation(ctx.info.root, 'recordSpecApprovalBaseline', values, baselineIo, undefined,
          () => store.recordSpecApprovalBaseline(board, ...values))
        : store.recordSpecApprovalBaseline(board, ...values);
    };
    const actor = ctx.info.isMain ? COORDINATOR : store.agentAt(board, ctx.info.root)?.agent_id;
    requireHandoffActive(board, actor, operation, args);
    ensureSpecApprovalCoordinator(ctx, board, initialBaseline, { relayLinked, relayRecovered, gitSyncLinked, ensureCoordinator: store.ensureCoordinator });
    const write = () => writeBoardCommand(board, operation, args, actor);
    if (initialBaseline && actor) await recordBaseline(actor);
    const requestedCommand = ctx.io.relayCommand?.cliOperation ?? (ctx.privateBoard ? ctx.io.requestedCommand : undefined);
    const requested = requestedCommandMove(requestedCommand, operation);
    const heartbeat = requested ? (await import('../cli-presence.js')).heartbeatCommand : null;
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
    const result = await withItemSession(ctx.info, operation, args, async () => ctx.privateBoard
      ? applyRequested()
      : gitSyncLinked(ctx.info.root)
        ? (await import('../sync.js')).gitBoardOperation(ctx.info.root, board, operation, args, ctx.io)
        : relayLinked(ctx.info.root) || relayRecovered(ctx.info.root)
          ? relayOperation(ctx.info.root, operation, args, ctx.io, command, applyRequested,
            requested ? observeRequested : undefined) : applyRequested());
    if (!ctx.privateBoard && requested && gitSyncLinked(ctx.info.root)) ctx.io.recordedMove = true;
    await (await import('../cli-recorded-effects.js')).afterOrderedMove(ctx, board, { requested, operation, args, actor });
    return result;
  };
  const digest = personIdentity.agentSessionDigest();
  const boardOnly = CHECKOUT_BOARD_ONLY.get(ctx.io);
  const boardOnlyOperation = (boardOnly === 'shout' && operation === 'shout') || (boardOnly === 'fact' && operation === 'appendFact');
  const boardOnlyAgent = ctx.info.isMain ? COORDINATOR : store.agentAt(board, ctx.info.root)?.agent_id ?? 'unjoined agent';
  if (boardOnlyOperation && digest && localSessionMatches(ctx.info, { agent: boardOnlyAgent, digest })) return execute();
  if (CHECKOUT_LEASES.has(ctx.io) || !digest || ctx.io.personChannel === 'view' || ctx.io.personRequest) return execute();
  const agent = ctx.info.isMain ? COORDINATOR : store.agentAt(board, ctx.info.root)?.agent_id ?? 'unjoined agent';
  const lease = await bindLocalSession(ctx.info, { agent, digest, keepLease: true });
  try { return await execute(); }
  finally { lease.release(); }
}

/** Order a claim on every route (claim, next, run) only after a check green on main is not held [V4]. */
export async function claimOrdered(ctx, board, args) {
  refuseClaimProvesNothing(ctx.info.root, board, args[0], { mainPolicy });
  const adoptCorrection = store.pendingRefreeze(board, args[0]).length > 0;
  return await ordered(ctx, board, 'claim', [args[0], { ...args[1],
    ...(adoptCorrection ? { adoptCorrection: true, freeze: freezer(ctx, { captureVerifyPolicy: true, board }) } : {}),
    reviewPolicy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family }]);
}

/**
 * Freeze a criterion from committed policy, refreshing trunk policy only on an explicit refreeze.
 *
 * @param {any} ctx
 * @param {{ captureVerifyPolicy?: boolean }} [options]
 * @returns {(item: any) => { text: string, digest: string }}
 */
export function freezer(ctx, { captureVerifyPolicy = false, board } = {}) {
  /** Freeze the criterion and, when requested, the trunk lane and verifier policy. */
  return (item) => {
    const prior = item.item_frozen ? JSON.parse(item.item_frozen) : null;
    const needsPinnedPolicy = !prior || captureVerifyPolicy;
    let policy = prior?.policy ?? null;
    if (needsPinnedPolicy && !(ctx.info.isMain && !headCommit(ctx.info.root))) {
      policy = { version: 1, commit: mainPolicy(ctx.info.root).commit };
    }
    let config;
    if (policy && needsPinnedPolicy) {
      const commit = /^[0-9a-f]{40,64}$/.test(policy.commit ?? '')
        ? policy.commit
        : (/^[0-9a-f]{40,64}$/.test(item.item_claim_head ?? '') ? item.item_claim_head : mainPolicy(ctx.info.root).commit);
      config = policyAt(ctx.info.root, commit).config;
      policy = { version: 1, commit, verify: { policy: config.verify.policy, family: config.verify.family } };
    } else {
      config = policy ? itemPolicy(ctx.info.root, { ...item, item_frozen: JSON.stringify({ policy }) }).config : ctx.config;
    }
    const doctrine = board ? agentDoctrine(ctx, board) : loadDoctrine(ctx.info.root, config);
    if (board) refuseAgentApprovedRows(ctx.info.root, { board, config, item }, { store, verifiedPasskeyRowDecision });
    const frozen = frozenCriterion(loadSpec(ctx.info.root, config), item, doctrine);
    if (!policy) return frozen; // Legacy criteria retain their original digest and committed claim base.
    const signed = board && barReadinessRequired(board, item) ? barReadiness(board, item, {}, { itemCheckBaseline }).signed : null;
    const coverage = signed?.coverage ? barCoverageForPolicy(ctx.info.root, item, signed.coverage, { commit: policy.commit, config }) : null;
    const text = JSON.stringify({ ...JSON.parse(frozen.text), ...(coverage ? { sourceCheck: item.item_check, check: barCoverageCommand(item.item_check, coverage), barCoverage: coverage, barRevision: signed.revision } : {}), policy });
    return { text, digest: createHash('sha256').update(text).digest('hex') };
  };
}

/** Merge a safe main fast-forward before freezing rows that only main has [V1].
 *
 * @param {any} ctx
 * @param {any} item
 * @returns {string[]|null} Missing rows merged from main, or null when no merge was needed.
 */
function prepareClaimSpec(ctx, item) {
  if (item.item_frozen) return null;
  const ids = (item.item_spec_ids ?? '').split(',').map((id) => id.trim()).filter((id) => id && !id.startsWith('doctrine:'));
  if (!ids.length) return null;
  const root = ctx.info.root;
  const main = mainCheckout(root);
  if (!main?.commit) return null;
  const policy = policyAt(root, main.commit);
  const mainSource = tryGit(root, ['show', `${main.commit}:${policy.config.spec}`]);
  if (mainSource.status !== 0) return null;
  const mainRows = new Set(parseSpec(mainSource.stdout).rows.map((row) => row.id));
  const localRows = new Set(loadSpec(root, ctx.config).rows.map((row) => row.id));
  const missing = [...new Set(ids)].filter((id) => mainRows.has(id) && !localRows.has(id));
  if (!missing.length) return null;

  const head = headCommit(root);
  const symbolic = tryGit(root, ['symbolic-ref', '--quiet', 'HEAD']);
  const canFastForward = Boolean(head && symbolic.status === 0 && isClean(root) && untracked(root).length === 0 && contains(root, head, main.commit));
  if (!canFastForward) throw specBehindMain(policy.config.spec, missing);
  try {
    git(root, ['merge', '--ff-only', main.commit]);
    if (headCommit(root) !== main.commit) throw new Error('main moved during the fast-forward');
  } catch {
    throw specBehindMain(policy.config.spec, missing);
  }
  Object.defineProperties(ctx, Object.getOwnPropertyDescriptors(context(ctx.io)));
  return missing;
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
    const rows = prepareClaimSpec(ctx, item);
    if (rows) throw new MainSpecMerged(rows);
    return freezer(ctx, { board })(item);
  };
}

/** Explain why an out-of-date spec cannot be merged automatically.
 *
 * @param {string} specName
 * @param {string[]} rows
 * @returns {Refused}
 */
function specBehindMain(specName, rows) {
  return new Refused('SPEC_BEHIND_MAIN', `${specName} is missing rows ${rows.join(', ')} that exist on main; commit or resolve local work, then merge main and retry`);
}

/** Enrich the ordinary lane refusal with a clean destination owned by this session; never widen claim authority. */
export async function wrongLaneGuidance(ctx, board, me, id, error) {
  if (!(error instanceof Refused) || error.code !== 'WRONG_LANE') return error;
  const seats = nextSessionSeats(ctx, board);
  if (!seats) return error;
  const item = store.getItem(board, id);
  if (item.item_lane === COORDINATOR || store.ROUTES.indexOf(item.item_route) > store.ROUTES.indexOf(me.route)) return error;
  const { seat } = await laneSeatContext(ctx, board, me, item, seats, context);
  return new Refused('WRONG_LANE', `item #${id} is in the ${item.item_lane} lane; this checkout is in ${me.lane}. Build it in ${seat.agent} at ${seat.path}`,
    `${cdTo(seat.path)} pullboard claim ${id}`);
}

