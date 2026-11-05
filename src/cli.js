import { createQueuedItemLease } from './queued-item-lease.js';
export { resourceRunLabel } from './cli-resource-display.js';
export { browserAdmissionReporter } from './cli-resource-display.js';
import * as personIdentity from './person.js';
import { dependencyValues } from './item-dependencies.js';
import { computedReturnArgs } from './computed-conflict-return.js';
import { ENGINE_VERSION as NATIVE_ENGINE } from './engine-metadata.js';
import { requireAgentGrant } from './agent-grant.js';
import {
  focusReviewFirst,
  focusReasons,
} from './focus-milestone.js';
import { requireHandoffActive } from './handoff-state.js';
import { requestedCommandMove } from './recorded-move.js';
export { barActorForCommand } from './bar-actor.js';
import {
  barReadinessRequired,
  barReadiness,
} from './bar-readiness.js';
import {
  barCoverageCommand,
  barCoverageForPolicy,
} from './bar-coverage.js';
import { identifyCaller } from './cli-identity.js';
import { gitSyncLinked } from './local-state.js';
/**
 * The pullboard command line: every command, bound to who is asking (B3, R3). The main checkout is the
 * coordinator; every other worktree is the agent that joined from it.
 */
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  spawn,
  spawnSync,
} from './windows-child-process.js';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  mainLaneWork,
  refuseNextIdle,
  reviewerStartup,
} from './next-steps.js';
import { environmentAgent } from './relay-environment.js';
import { judgeTrunkMove } from './verdict-trunk.js';
import * as gateReceipt from './gate-receipt.js';
import * as itemSessions from './item-sessions.js';
import * as seatCheckout from './seat-checkout.js';
import { submitPreflight } from './submit-preflight.js';
import * as store from './board.js';
import { withBoardRead } from './board-read.js';
export { withBoardRead };
import * as nativeFlakes from './native-flake-cli.js';
import {
  hookRead,
  readStdin,
} from './cli-support.js';
import {
  agentDisplayName,
  cdTo,
  context,
  firstLineOf,
  idArg,
  idList,
  itemLine,
  sayBrief,
  setupFiles,
  shellWord,
  span,
  uncommittedSetup,
  withBoard,
} from './cli-context.js';
import {
  CHECKOUT_BOARD_ONLY,
  CHECKOUT_LEASES,
  main,
} from './cli-main.js';
import {
  HELP,
  printHelp,
  resultCommands,
  unknownCommand,
} from './cli-help.js';
// Commands and tests import these from here; each lives in the module a read can load without the rest.
export {
  agentDisplayName, cdTo, CHECKOUT_LEASES, context, firstLineOf, HELP, idArg, idList, itemLine, main, printHelp,
  resultCommands, sayBrief, shellWord, span, uncommittedSetup, unknownCommand, withBoard,
};
import {
  CONFIG_FILE,
  COORDINATOR,
  DOCTRINE_FILE,
  LEGACY_DOCTRINE_FILE,
  configFromSource,
  loadConfig,
} from './config.js';
import { onlyNamedBoardChanged } from './relay-board-config.js';
import { displayAgentName } from './agent-names.js';
import {
  doctrineHistory,
  loadDoctrine,
} from './doctrine.js';
import {
  agentDoctrine,
  proposeDoctrine,
  resumeDoctrineNotes,
  staleDoctrineRows,
} from './doctrine-rulings.js';
import {
  hasSubmitRules,
  holdDoctrine,
  ruleLine,
} from './doctrine-checks.js';

import { signedMoveProblem } from './person-signing.js';
import { personAuthority } from './relay-sender.js';
import {
  bindLocalSession,
  HOOK_CHECKOUT_WAIT_MS,
  localSessionMatches,
  localSessionSeats,
} from './agent-session.js';
import {
  decisionAnswer,
  decisionProjection,
  handAnsweredQuestions,
  pendingAnswers,
  planRowApply,
  prepareRowDecisions,
  restoreRowApply,
  rowDecisionView,
  writeRowApply,
} from './row-decisions.js';
import { rowDecisionContext } from './row-decision-state.js';
import {
  gateReport,
  refuseSandboxBlocked,
  runGate,
  runSubmitGate,
  submitGateReport,
  timingDigest,
  withGateSlot,
} from './gate.js';
import { guardRevertNote } from './guard-revert.js';
import { draftRow } from './spec-draft.js';
import {
  clashingRowDrafts,
  pendingRowDrafts,
  trunkRowIds,
  withRowDrafts,
} from './row-drafts.js';
import { gateWaitReporter } from './gate-wait.js';
import * as gateConfig from './gate-config.js';
import {
  checkNeedsBrowser,
  explicitCheckFiles,
} from './browser-admission.js';
import {
  contains,
  differFromHead,
  git,
  gitChildEnv,
  headCommit,
  headTree,
  invalidateGitFacts,
  isClean,
  mainCheckout,
  repoInfo,
  resolveCommit,
  tryGit,
  untracked,
} from './git.js';
import {
  FIX_NOTE,
  applyFixers,
  commitMsgProblems,
  commitCitationWarnings,
  machineNameProblems,
  preCommitProblems,
  prePushProblems,
  pushesTrunk,
  unwiredHookProblems,
} from './hooks.js';
import {
  askedLaneNotes,
  detectGate,
  proposeLanes,
  starterLane,
  starterLaneNotes,
} from './init.js';
import {
  SETTING_FORMS,
  VERSION,
} from './help.js';
import {
  mainMergeLines,
  mainMergesFor,
} from './trunk-conflict.js';
import {
  checkImplies,
  parseImplies,
  takeDecisionNotices,
} from './implies.js';
import { defaultViewPort } from './view-port.js';
export { VERSION };
import { productProblems } from './products.js';
import {
  isLane,
  laneNames,
  laneOf,
  outOfLane,
} from './lanes.js';
import { Refused } from './refused.js';
import {
  applyStep,
  personAsk,
  requirementStep,
  setupDecisionRows,
  withStarterWork,
} from './setup-rows.js';
import { personNeeds } from './needs.js';
import { personNeedsState } from './needs-state.js';
import { startServeSentinel } from './serve-sentinel.js';
import {
  commitCitations,
  committedIds,
} from './history.js';
import {
  frozenCriterion,
  lintSpec,
  loadSpec,
  legacyDoctrineRenameBase,
  permanenceProblems,
  parseSpec,
  readSignoffs,
  signOff,
  standings,
  unmetRows,
} from './spec.js';
import { refuseAgentApprovedRows } from './spec-approval.js';
import {
  ensureSpecApprovalCoordinator,
  initialSpecApprovalBaseline,
} from './spec-approval-bootstrap.js';
import {
  answerQuestion,
  landBlueprint,
  planBlueprint,
  starterCheck,
  readBlueprint,
  repoAnswers,
} from './blueprints.js';
import { fitCommand } from './blueprint-fit-command.js';
import {
  fitSummary,
  readFitBatch,
} from './blueprint-fit.js';
import {
  blueprintStarterNote,
  sharedRowLines,
} from './blueprint-set.js';
import { briefFiles } from './brief.js';
import {
  commitFirst,
  commitOwnerLines,
  commitOwners,
  coordinatorInbox,
  coordinatorInboxLines,
  inboxFirst,
} from './resume.js';
import { sayCheckBaseline } from './check-baseline.js';
import {
  refuseClaimProvesNothing,
  refuseProvesNothing,
} from './check-accept.js';
import { startCheckBaseline } from './check-baseline-worker.js';
import {
  compareMainFailures,
  mainRedMessage,
  mainRedReworkItems,
} from './main-red.js';
import {
  parseProblems,
  sweepItems,
} from './sweep.js';
import { renderSpecView } from './view.js';
import { runPrivateBoard } from './private-board.js';
import {
  listApiProjects,
  registerProjectAndLink,
  registeredProjectRootsSnapshot,
} from './projects.js';
import {
  citedTestFiles,
  rowEvidence,
  rowStage,
} from './evidence.js';
import {
  exportView,
  serveView,
} from './serve.js';
import {
  forgetView,
  busyViewPortRefusal,
  rememberView,
  runningView,
} from './view-session.js';
import {
  backgroundViewLine,
  launchBackgroundView,
  reportView,
} from './background-view.js';
import { nextReview } from './next-review.js';
import { firstRefusalArgs } from './claims.js';
import { serveApi } from './api.js';
import { serveMcp } from './mcp.js';
import { scanHealthSentinel } from './health-sentinel.js';
import { resumeSentinels } from './sentinel-command.js';
import {
  staleFrozenItems,
  staleItemFinding,
} from './approved-rows.js';
import {
  mainPolicy,
  policyAt,
  itemPolicy,
  submissionPaths,
  frozenCheck,
  checkAtCommit,
  dependencySnapshots,
  requireTrunkMerge,
  trunkMerge,
  trunkRef,
} from './trusted-policy.js';
import {
  composeReview,
  composesAtAdmission,
} from './verdict-admission.js';
import {
  captureVerdictReview,
  staleVerdictRefusal,
  verdictProjector,
  verdictTrunk,
} from './verdict-freshness.js';
import { proofStats } from './stats.js';
import { flowAlertLine } from './stats-flow.js';
import { releaseHeadlinesBetween } from './changelog.js';
import {
  addSigner,
  assertRequiredSigners,
  defaultPrincipal,
  hasSignerFile,
} from './signature.js';
import {
  addRunner,
  browserFreeChecksEnabled,
  gateQueueSettings,
  gateShortSlots,
  loadMachineSettings,
  memoryFloorMB,
  relayOfferEnabled,
  setBrowserSlots,
  setGateShortSlots,
  setGateSlots,
} from './settings.js';
import {
  relayLinked,
  relayOperation,
  relayRecovered,
} from './relay.js';
import { unlinkedRelayProjects } from './relay-setup.js';
import {
  accountedFailures,
  landingRemote,
  waivedFailures,
  waiverLine,
} from './land.js';
import { handMergeCommand } from './landing-message.js';
import { installStep } from './worktree.js';
import * as infraNotes from './infra-note.js';
export { gateWaitReporter };
/**
 * Read the collision baseline from the primary branch, retained trunk, or detached HEAD default.
 *
 * @param {string} root
 * @param {string} path
 * @param {string} [revision]
 * @returns {{ status: number, stdout: string, baseline?: string }}
 */
export function coordinatorFile(root, path, revision) {
  const commonDir = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const coordinatorRoot = dirname(commonDir);
  const env = { ...gitChildEnv(root), GIT_NO_REPLACE_OBJECTS: '1' };
  const primary = mainCheckout(coordinatorRoot);
  let ref = primary?.branch ?? trunkRef(coordinatorRoot);
  const detachedHeadDefault = !primary && !ref;
  if (detachedHeadDefault) ref = 'HEAD';
  if (ref !== 'HEAD' && !ref?.startsWith('refs/heads/')) {
    throw new Refused('NO_TRUNK', 'no trunk branch was recorded; check out the trunk branch in the main checkout once and run pullboard inbox');
  }
  if (!primary) {
    const tip = spawnSync('git', ['--no-replace-objects', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: coordinatorRoot, env, encoding: 'utf8',
    });
    if (tip.status !== 0) {
      throw new Refused('NO_TRUNK', 'the recorded trunk branch has no readable tip; check out the trunk branch in the main checkout once and run pullboard inbox');
    }
    ref = tip.stdout.trim();
  }
  const result = spawnSync('git', ['--no-replace-objects', 'show', `${revision ?? ref}:${path}`], {
    cwd: coordinatorRoot, env, encoding: 'utf8',
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    ...(detachedHeadDefault ? { baseline: 'collision baseline default: detached HEAD' } : {}),
  };
}
/** Start an already-recorded request, recording an unavailable result if its child cannot start. */
export async function launchBaseline(ctx, board, id, baseline) {
  try { await startCheckBaseline(ctx.info.root, id, baseline); }
  catch {
    await ordered(ctx, board, 'completeCheckBaseline', [id, { agentId: COORDINATOR, expected: baseline,
      baseline: { command: baseline.command, main: baseline.main, result: 'unavailable', reason: 'background worker could not start; set --check again from the coordinator' } }]);
  }
}
/** Parse an edit's dependency replacement, with the explicit word `none` meaning clear all. */
export function editAfter(text) {
  if (text === undefined) return undefined;
  if (text.trim() === 'none') return [];
  const parts = text.split(',').map((part) => part.trim());
  if (!text.trim() || parts.some((part) => !part || part === 'none')) {
    throw new Refused('USAGE', 'use --after <id>[,<id>...] or --after none');
  }
  return dependencyValues(parts);
}
/**
 * Text a command was given as --<name> "..." or as --<name>-file <file>, or undefined when neither.
 * A file carries text past the shell exactly: backticks, dollar signs and quotes included.
 *
 * @param {any} io
 * @param {any} values
 * @param {string} name
 * @returns {string | undefined}
 */
export function textArg(io, values, name) {
  const path = values[`${name}-file`];
  if (values[name] !== undefined && path !== undefined) {
    throw new Refused('USAGE', `give the ${name} once: --${name} "..." or --${name}-file <file>`);
  }
  if (path === undefined) return values[name];
  const file = resolve(io.cwd, path);
  if (!existsSync(file)) throw new Refused('NO_FILE', `no file ${path}`);
  return readFileSync(file, 'utf8');
}
/**
 * The brief a command was given, from --brief or --brief-file.
 *
 * @param {any} io
 * @param {any} values
 * @returns {string | undefined}
 */
export const briefArg = (io, values) => textArg(io, values, 'brief');
/**
 * Verifying from the main checkout files the verdict as the coordinator's (V9). An agent whose
 * shell started there would be taken for the coordinator, so the coordinator says so explicitly
 * and anyone else is sent back to a worktree.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {any} values
 */
export function checkMainVerifier(ctx, board, values) {
  if (values.as !== undefined && values.as !== COORDINATOR) throw new Refused('USAGE', '--as takes one value: coordinator');
  if (!ctx.info.isMain) {
    if (values.as) throw new Refused('USAGE', '--as coordinator works only in the main checkout; here you are the agent this worktree joined as');
    return;
  }
  if (values.as === COORDINATOR) return;
  const agents = store.listAgents(board).filter((agent) => agent.agent_id !== COORDINATOR);
  const listed = agents.length ? ` Agent worktrees: ${agents.slice(0, 6).map((agent) => `${displayAgentName(agent, ctx.config.agents.names)} at ${agent.agent_path}`).join('; ')}.` : '';
  const detached = tryGit(ctx.info.root, ['symbolic-ref', '-q', 'HEAD']).status !== 0 ? ' The main checkout is not on its branch; whoever switched it puts it back.' : '';
  throw new Refused('MAIN_IS_COORDINATOR',
    `this is the main checkout, so this verdict would be the coordinator's.${listed}${detached}`,
    reviewerStartup(ctx.info.root, ctx.config, values.verifyId),
  );
}
/**
 * Select the person actor only through the main checkout's explicit person mode (B26).
 *
 * @param {any} ctx
 * @param {{ id: string }} me
 * @param {{ as?: string }} values
 * @returns {boolean}
 */
export function personMode(ctx, me, values) {
  if (values.as === undefined) return false;
  if (values.as !== 'person') throw new Refused('USAGE', '--as person is supported for answer, decisions, hold and fact --never-again');
  if (!ctx.info.isMain || me.id !== COORDINATOR) {
    throw new Refused('B26_PERSON_ANSWER', 'only the main checkout can act as the person; ask your coordinator to answer or pass this decision');
  }
  return true;
}
/**
 * Refuse a build item in a lane that owns no files, such as review: whoever claims it there can
 * commit nothing, so the item strands its builder. A review item, one that waits on the work it
 * reviews with --after, still goes there. The refusal names the lanes that own files [I1].
 * Until some lane owns files, as right after init, there is nowhere else to point, so the item is
 * added as before.
 *
 * @param {any} config
 * @param {string} lane
 * @param {number[]} after
 */
export function buildInFilelessLane(config, lane, after) {
  const owns = (name) => (config.lanes[name]?.owns ?? []).length > 0;
  if (lane === COORDINATOR || owns(lane) || after.length) return;
  const owning = Object.keys(config.lanes).filter(owns);
  if (!owning.length) return;
  throw new Refused('NO_FILES_LANE', `the ${lane} lane owns no files, so a build item there strands its builder; file it in a lane that owns files (${owning.join(', ')}), or pass --after <id> if it reviews that item`);
}

/**
 * A brief whose Files section stays inside the item's lane (B14), so a builder working from it
 * never runs into the lane check: an item's files sit in its lane.
 *
 * @param {any} ctx
 * @param {string} lane
 * @param {string} brief
 * @returns {string}
 */
export function briefInLane(ctx, lane, brief) {
  const foreign = outOfLane(ctx.config, lane, briefFiles(brief));
  if (foreign.length) {
    throw new Refused('BRIEF_LANE', `the brief names files outside the ${lane} lane: ${foreign.join(', ')}; split the item by lane, or wait on the other lane's item with --after`);
  }
  return brief;
}

/**
 * Reserve a new row's id on the board in one write transaction before any file names it, so writers
 * that plan the same id at the same moment get distinct ids (#878). written: the caller writes the row
 * into its own file now; otherwise it is a lane draft that spec apply writes. With no board yet there is
 * no other writer, and the planned id stands.
 */
export async function reserveRow(ctx, row, written) {
  if (!existsSync(ctx.file)) return row;
  return withBoard(ctx, async (board) => ordered(ctx, board, 'draftSpecRow', [{ agentId: store.agentAt(board, ctx.info.root)?.agent_id ?? whoAmI(ctx, board).id, row, written }]));
}

/** Note the session behind a claim or submit (#921): its ledger must be writable before the move, and record after it. */
async function withItemSession(info, operation, args, move) { const noted = operation === 'claim' || operation === 'submit'; if (noted) itemSessions.requireLedger(info); const result = await move(); if (noted) itemSessions.recordItemSession(info, args[0], operation); return result; }

/**
 * Whether the board's committed relay.outbox setting queues moves while the relay is down (#922, H21).
 * Why: absent means enabled for existing boards; an explicit false is the shared opt-out.
 */
export function relayOutboxSetting(root) {
  try { return configFromSource(coordinatorFile(root, CONFIG_FILE).stdout).relay?.outbox !== false; } catch { return false; }
}

export async function ordered(ctx, board, operation, args) {
  // With signed person moves on, a person-only move counts only as a passkey-confirmed request [E22].
  const unsigned = signedMoveProblem(board, personAuthority({ operation, args }), ctx.io.personRequest, { strict: true });
  if (unsigned) throw unsigned;
  const initialBaseline = initialSpecApprovalBaseline(ctx, board, operation);
  // Only a reject or a reopen can open a builder's first-refusal window (#954), so an accept never reads the coordinator's policy.
  if (operation === 'reopen' || operation === 'verify' && args[1]?.decision === 'REJECT') args = firstRefusalArgs(operation, args, configFromSource(coordinatorFile(ctx.info.root, CONFIG_FILE).stdout));
  ctx.io.relayOutbox ??= () => relayOutboxSetting(ctx.info.root);
  // Every engine-27 registration records the seat that made it: the coordinator from the main
  // checkout, the joined agent from its worktree, or `machine` for a join no seat made (#579).
  if (operation === 'register' && args[0] && args[0].createdBy === undefined) {
    const joined = store.agentAt(board, ctx.info.root)?.agent_id;
    args = [{ ...args[0], createdBy: ctx.info.isMain ? COORDINATOR : joined ?? 'machine' }, ...args.slice(1)];
  }
  const command = ['add', 'companion', 'edit', 'merged', 'move'].includes(ctx.io.relayCommand?.cliOperation) ? ctx.io.relayCommand : undefined;
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
        ? (await import('./sync.js')).gitBoardOperation(ctx.info.root, board, 'recordSpecApprovalBaseline', values, baselineIo)
        : relayLinked(ctx.info.root) || relayRecovered(ctx.info.root)
        ? relayOperation(ctx.info.root, 'recordSpecApprovalBaseline', values, baselineIo, undefined,
          () => store.recordSpecApprovalBaseline(board, ...values))
        : store.recordSpecApprovalBaseline(board, ...values);
    };
    const actor = ctx.info.isMain ? COORDINATOR : store.agentAt(board, ctx.info.root)?.agent_id;
    requireHandoffActive(board, actor, operation, args);
    ensureSpecApprovalCoordinator(ctx, board, initialBaseline);
    const write = () => store.atomic(board, () => {
      requireHandoffActive(board, actor, operation, args);
      requireAgentGrant(board, { operation, args, engine: NATIVE_ENGINE }); // A native write applies current semantics.
      return store[operation](board, ...args);
    });
    if (initialBaseline && actor) await recordBaseline(actor);
    const requestedCommand = ctx.io.relayCommand?.cliOperation ?? (ctx.privateBoard ? ctx.io.requestedCommand : undefined);
    const requested = requestedCommandMove(requestedCommand, operation);
    const heartbeat = requested ? (await import('./cli-presence.js')).heartbeatCommand : null;
    /** Observe a committed requested write before its relay checkpoint captures the presentation. */
    const observeRequested = () => {
      ctx.io.recordedMove = true;
      heartbeat(ctx.io, { ctx, board });
    };
    /** Called only for this requested operation, after its store transaction commits, never for bootstrap. */
    const applyRequested = () => {
      const before = board.lastEvent;
      const result = write();
      if (requested && board.lastEvent !== before) observeRequested();
      return result;
    };
    const result = await withItemSession(ctx.info, operation, args, async () => ctx.privateBoard
      ? applyRequested()
      : gitSyncLinked(ctx.info.root)
        ? (await import('./sync.js')).gitBoardOperation(ctx.info.root, board, operation, args, ctx.io)
        : relayLinked(ctx.info.root) || relayRecovered(ctx.info.root)
          ? relayOperation(ctx.info.root, operation, args, ctx.io, command, applyRequested,
            requested ? observeRequested : undefined) : applyRequested());
    if (!ctx.privateBoard && requested && gitSyncLinked(ctx.info.root)) ctx.io.recordedMove = true;
    if (requested && ctx.io.recordedMove) (await import('./cli-presence.js')).heartbeatCommand(ctx.io, { ctx, board });
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
  refuseClaimProvesNothing(ctx.info.root, board, args[0]);
  return await ordered(ctx, board, 'claim', [args[0], { ...args[1],
    reviewPolicy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family }]);
}

/**
 * Bind this checkout to the session behind a write command, which the command line has already told apart from a
 * read. A person's takeover in a linked main checkout binds no session (#347).
 */
export async function bindWriteSession(io, positionals, values) {
  const [command, first] = positionals;
  const digest = personIdentity.agentSessionDigest();
  if (!digest) {
    if (command === 'takeover' && !(repoInfo(io.cwd).isMain && relayLinked(repoInfo(io.cwd).root))) throw new Refused('AGENT_SESSION', 'takeover belongs to an agent session; run pullboard takeover from the agent’s shell');
    return;
  }
  if (command === 'check') {
    // Acceptance follows its person-channel path; it does not renew a build claim.
    if (first === 'accept') return;
    const ctx = context(io);
    const renewsOwnClaim = withBoard(ctx, (board) => {
      const agentId = ctx.info.isMain ? COORDINATOR : store.agentAt(board, ctx.info.root)?.agent_id;
      const item = first ? store.getItem(board, idArg(first)) : store.listItems(board)
        .find((entry) => entry.item_status === 'claimed' && entry.item_owner === agentId && entry.item_parent_id === null);
      return Boolean(agentId && item?.item_status === 'claimed' && item.item_owner === agentId);
    });
    // A named peer's check remains read-only. An owned check can renew, so acquire checkout
    // authority before joining the gate queue, in the same order as submit and verify.
    if (!renewsOwnClaim) return;
  }
  const info = repoInfo(io.cwd);
  let agent = info.isMain ? COORDINATOR : null;
  if (!info.isMain) {
    const ctx = context(io);
    const ownsLandingRoot = command === 'hook' ? (await import('./landing-candidates.js')).landingBatchOwnsRoot : () => false;
    agent = withBoard(ctx, (board) => store.agentAt(board, info.root)?.agent_id
      ?? (command === 'hook' && store.landingBatches(board).some((batch) => ownsLandingRoot(batch, info.root)) ? COORDINATOR : null));
    if (!agent && command !== 'join') throw withBoard(ctx, (board) => seatCheckout.unjoinedRefusal(info, store.listAgents(board)));
  }
  if (['shout', 'fact'].includes(command) && localSessionMatches(info, { agent: agent ?? 'unjoined agent', digest })) {
    CHECKOUT_BOARD_ONLY.set(io, command);
    return;
  }
  const lease = await bindLocalSession(info, { agent: agent ?? 'unjoined agent', digest, takeover: command === 'takeover', keepLease: !['run', 'next', 'land'].includes(command), waitLimitMs: command === 'hook' ? HOOK_CHECKOUT_WAIT_MS : 0,
    /** Record the takeover; a linked main checkout takes the board's coordinator before its receipt shout, which the hold would refuse (#347). */
    recordTakeover: async () => (await import('./commands/takeover.js')).recordCheckoutTakeover(io, info),
  });
  if (agent) return { lease };
  /** Replace the temporary identity after a successful first join, retaining the winning session. */
  return { lease, finish: async () => {
    const ctx = context(io);
    const me = withBoard(ctx, (board) => whoAmI(ctx, board));
    lease.updateAgent(me.id);
  } };
}

/** Choose an explicitly supplied model or the standard environment fallback, refusing an unknown identity. */
export function requiredModel(value, env = process.env, commandNext) {
  const model = (value ?? env.PULLBOARD_MODEL ?? '').trim();
  if (!model || /[\u0000-\u001f\u007f-\u009f]/u.test(model)) {
    const suffix = commandNext ? `; run pullboard ${commandNext} --model "<model name>"` : '';
    const message = commandNext
      ? `this session has not declared its model${suffix}`
      : 'give --model "<model name>" or set PULLBOARD_MODEL in this shell before joining';
    throw new Refused('MODEL_REQUIRED', message);
  }
  return model;
}

/** Resolve an optional coordinator declaration while preserving the legacy unknown identity. */
export function optionalModel(value, env = process.env) {
  if (value === undefined && !env.PULLBOARD_MODEL) return undefined;
  return requiredModel(value, env);
}

/** Refuse to redeclare a coordinator whose linked board belongs to another checkout. */
export function refuseRemoteCoordinatorModel(ctx, command) {
  const coordinator = withBoard(ctx, (board) => store.listAgents(board).find((agent) => agent.agent_id === COORDINATOR));
  if (!coordinator) throw new Refused('NO_AGENT', 'the linked snapshot has no coordinator; restore a consistent relay snapshot before initializing');
  if (ctx.info.isMain && coordinator.agent_path === ctx.info.root) return;
  const name = displayAgentName(coordinator, ctx.config.agents.names);
  throw new Refused('REMOTE_COORDINATOR_MODEL', `the coordinator's model is declared on the coordinator's own checkout (${name}); run pullboard ${command} there`);
}

/** Resolve the caller with the existing environment and relay identity checks. */
export function whoAmI(ctx, board) {
  return identifyCaller(ctx, board, { environmentAgent, relayLinked: root => relayLinked(root) || gitSyncLinked(root) });
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
    if (board) refuseAgentApprovedRows(ctx.info.root, { board, config, item });
    const frozen = frozenCriterion(loadSpec(ctx.info.root, config), item, doctrine);
    if (!policy) return frozen; // Legacy criteria retain their original digest and committed claim base.
    const signed = board && barReadinessRequired(board, item) ? barReadiness(board, item).signed : null;
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

/**
 * The evidence a shout carries, from its flags (B22). The commit is resolved here, in this repo,
 * so the board only ever stores a full SHA that names a real commit.
 *
 * @param {any} ctx
 * @param {any} values
 * @returns {{ kind: string, outcome: string, item: number, commit: string }}
 */
export function evidenceFrom(ctx, values) {
  const rev = values.commit ?? '';
  const resolved = rev ? tryGit(ctx.info.root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]) : { status: 1, stdout: '' };
  if (resolved.status !== 0) throw new Refused('BAD_EVIDENCE', `evidence names a commit in this repo: --commit <rev> (saw "${rev}")`);
  const item = /^\d+$/.test(values.item ?? '') ? Number(values.item) : NaN;
  return { kind: values.evidence, outcome: values.outcome ?? '', item, commit: resolved.stdout };
}

/**
 * A shout's evidence as one line: its kind, outcome, item and commit (B22).
 *
 * @param {any} shout
 * @returns {string}
 */
export const evidenceLine = (shout) => `${shout.shout_evidence_kind}: ${shout.shout_evidence_outcome}, #${shout.shout_evidence_item} at ${shout.shout_evidence_commit.slice(0, 12)}`;

/** Label the holder at the start of a generated wait reason without rewriting its quoted reason. */
export function displayedWait(reason, agents, config) {
  return reason.replace(/^(\S+)( holds the )/, (_, id, rest) => `${agentDisplayName(agents, config, id)}${rest}`)
    .replace(/^(#\d+ is held by )(\S+)(: )/, (_, before, id, after) => `${before}${agentDisplayName(agents, config, id)}${after}`);
}

/**
 * The files an agent has been working in (N20): what its latest three items touched, and what is
 * uncommitted in its worktree now.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {{ id: string }} me
 * @returns {string[]}
 */
function warmFiles(ctx, board, me) {
  const recent = store
    .listItems(board, { all: true })
    .filter((item) => item.item_built_by === me.id)
    .sort((first, second) => second.item_updated_at.localeCompare(first.item_updated_at))
    .slice(0, 3)
    .flatMap((item) => store.itemFiles(item));
  return [...new Set([...recent, ...dirtyFiles(ctx.info.root)])];
}

/**
 * The paths with uncommitted changes in a worktree, untracked files included.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function dirtyFiles(root) {
  return tryGit(root, ['status', '--porcelain', '--untracked-files=all']).stdout.split('\n').filter(Boolean).map((line) => line.slice(3));
}

/**
 * The files an item's own commits changed since its claim (N21). First parents only, so main merged
 * into a lane branch is not counted as the item's work; and nothing another item submitted, such as
 * a verified dependency fast-forwarded in, which merges no commit to skip.
 *
 * @param {string} root
 * @param {number} id
 * @param {string | null} from
 * @param {string} to
 * @returns {string[]}
 */
export function filesSince(root, id, from, to) {
  if (!from) return [];
  const others = [`--exclude=refs/pullboard/items/${id}/*`, '--glob=refs/pullboard/items/*'];
  const result = tryGit(root, ['log', '--first-parent', '--no-merges', '--no-renames', '--format=', '--name-only', to, '--not', from, ...others]);
  return result.status === 0 ? [...new Set(result.stdout.split('\n').filter(Boolean))].sort() : [];
}

/** Refuse a candidate containing another item's unverified submitted commit [V1].
 *
 * Trunk-reachable commits are already landed, including when the candidate is trunk itself.
 * Inspect all remaining reachable commits, including merged topic parents.
 *
 * @param {string} root
 * @param {any} board
 * @param {any} item
 * @param {string} commit
 * @param {{ ref: string, commit: string } | null} trunk
 * @returns {void}
 */
export function refuseUnverifiedStack(root, board, item, commit, trunk) {
  const trunkRange = trunk?.commit
    ? tryGit(root, ['rev-list', `${trunk.commit}..${commit}`])
    : { status: 1, stdout: '' };
  if (trunkRange.status !== 0) {
    throw new Refused('NO_POLICY', 'the current trunk range cannot be read; restore Git history and retry the submit or verification');
  }
  const commits = new Set(trunkRange.stdout.split('\n').filter(Boolean));
  const stacked = store.unverifiedSubmissions(board)
    .find((other) => other.item_id !== item.item_id && commits.has(other.item_commit));
  if (stacked) {
    throw new Refused(
      'STACKED_ON_UNVERIFIED',
      `#${item.item_id} includes unverified item #${stacked.item_id} at ${stacked.item_commit}; wait for #${stacked.item_id} to be accepted or rebuild without its commits before continuing`,
    );
  }
}

/**
 * A shout's text cut to one short line.
 *
 * @param {string} text
 * @returns {string}
 */
export const firstLine = (text) => {
  const line = String(text).split('\n')[0];
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
};

/** The next step for an agent holding a claim: build it and submit. */
export const buildNext = (card) => `build #${card.holding[0].item_id}, commit, then pullboard submit ${card.holding[0].item_id}`;

/** The next step for an agent whose work came back: rework it. */
export const reworkNext = (card) => `pullboard claim ${card.sentBack[0].item.item_id}, fix what the verifier found, and submit again`;

/**
 * The coordinator's next step, from the board and the spec (N32): the spec with the person first,
 * then its own work in hand, then verdicts, merges, builders and the plan, so an agent that runs the
 * team by the run guide knows where it is. A working board with no spec rows can keep building.
 *
 * @param {any} card
 * @param {{ id: string, status: string }[]} rows
 * @returns {string}
 */
export function coordinatorNext(card, rows) {
  if (card.requests.length) return `answer request #${card.requests[0].shout_id}: pullboard answer ${card.requests[0].shout_id} done, or declined <reason>`;
  const live = rows.filter((row) => !['wont', 'retired'].includes(row.status));
  if (!live.length && (rows.length || !card.all.length)) return "turn what the person wants into spec rows with them: the pullboard-decompose skill (pullboard prompt decompose)";
  const approved = live.filter((row) => row.status === 'approved');
  if (live.length && !approved.length) return 'the person approves rows in SPEC.md; then plan them: the pullboard-plan skill';
  if (card.holding.length) return buildNext(card);
  if (card.sentBack.length) return reworkNext(card);
  if (card.toVerify.length) return 'pullboard next --verify --as coordinator, or a verifier that built nothing: pullboard worktree review --model "<model name>"';
  if (card.toMerge.length) {
    const [first] = card.toMerge;
    return `merge #${first.item_id}: git merge --no-edit ${(first.item_checked_commit ?? first.item_commit).slice(0, 12)}, run the gate, then pullboard merged ${first.item_id} <merge commit>`;
  }
  if (card.staleVerdicts?.length) {
    const item = card.staleVerdicts[0];
    return staleVerdictRefusal(item, item.item_verdict_state).message.replace(/^\[STALE_VERDICT\] /u, '');
  }
  if (card.open.length) {
    const lanes = [...new Set(card.open.map((item) => item.item_lane))];
    return `start a builder for each lane with open items (${lanes.join(', ')}): pullboard worktree <lane> --model "<model name>", then the pullboard-run skill`;
  }
  const cited = new Set(card.all.flatMap((item) => (item.item_spec_ids ?? '').split(',').filter(Boolean)));
  const unplanned = approved.filter((row) => !cited.has(row.id));
  if (unplanned.length) {
    return `plan the approved rows no item cites (${unplanned.slice(0, 4).map((row) => row.id).join(', ')}${unplanned.length > 4 ? ', ...' : ''}): the pullboard-plan skill`;
  }
  return 'nothing open: report what was built to the person, or curate the queue: pullboard add, edit, hold';
}

/** Read each actor's newest structured integration attempt unless their later receipt closes it. */
function integrationClaims(root, item, shouts, now) {
  const actors = new Map();
  for (const shout of shouts) {
    if (shout.shout_evidence_item !== item.item_id) continue;
    if (shout.shout_evidence_kind === 'receipt') actors.delete(shout.shout_from);
    else if (shout.shout_evidence_kind === 'attempt' && shout.shout_evidence_outcome === 'integrating'
      && contains(root, item.item_checked_commit ?? item.item_commit, shout.shout_evidence_commit)) {
      actors.set(shout.shout_from, shout);
    }
  }
  const claims = [...actors.values()].map((shout) => ({ type: 'shout', by: shout.shout_from, at: shout.shout_at,
      text: shout.shout_text, commit: shout.shout_evidence_commit, id: shout.shout_id,
      expired: now - Date.parse(shout.shout_at) > 24 * 60 * 60 * 1000 }))
    .sort((a, b) => b.id - a.id);
  return { live: claims.find((claim) => !claim.expired) ?? null,
    expired: claims.find((claim) => claim.expired) ?? null };
}

/** Check verified, unmerged heads against the trunk without changing a worktree or trusting prose. */
export function verifiedMergeGroups(root, items, shouts, now) {
  const groups = { clean: [], conflicts: [], integrating: [] };
  const staleIntegrations = [];
  for (const item of [...items].sort((a, b) => a.item_id - b.item_id)) {
    const claimed = integrationClaims(root, item, shouts, now);
    if (claimed.live) {
      const { expired, ...claim } = claimed.live;
      groups.integrating.push({ item, ...claim });
      continue;
    }
    if (claimed.expired) staleIntegrations.push({ item, ...claimed.expired });
    try {
      requireTrunkMerge(root, item.item_checked_commit ?? item.item_commit);
      groups.clean.push(item);
    } catch (error) {
      if (error.code !== 'MERGE_CONFLICT') throw error;
      const detail = / in ([\s\S]*); merge the trunk into/u.exec(error.message)?.[1] ?? '';
      let files = [];
      try { files = JSON.parse(`[${detail}]`); } catch { files = []; }
      groups.conflicts.push({ item, files });
    }
  }
  return { verifiedNotMerged: groups, staleIntegrations };
}

/** Capture coordinator-only decision sections with stable ages and answers from the board. */
export function coordinatorDecisionSections(board, ctx) {
  const shouts = store.decisionAndEvidenceShouts(board);
  const openDecisions = store.openDecisions(board, COORDINATOR).map((ask) => ({
    id: ask.shout_id, asker: ask.shout_from, question: ask.shout_text, ...(ask.options ? { options: ask.options, item: ask.item } : {}), at: ask.shout_at, age: span(ctx, ask.shout_at),
  }));
  const answers = new Map(store.decisionAnswers(board).map(answer => [answer.shout_answers, answer]));
  const recentAnswers = shouts.filter((ask) => ask.shout_decision).flatMap((ask) => {
    const answer = answers.get(ask.shout_id);
    if (!answer) return [];
    const ageMs = ctx.clock.now().getTime() - Date.parse(answer.shout_at);
    if (ageMs < 0 || ageMs > 24 * 60 * 60 * 1000) return [];
    return [{ id: ask.shout_id, asker: ask.shout_from, question: ask.shout_text,
      answeredBy: answer.shout_from, answer: answer.shout_text, at: answer.shout_at, age: span(ctx, answer.shout_at) }];
  }).sort((a, b) => b.at.localeCompare(a.at));
  const personQuestions = store.openDecisions(board, 'person').map((ask) => ({
    id: ask.shout_id, asker: ask.shout_from, question: ask.shout_text, at: ask.shout_at, age: span(ctx, ask.shout_at),
  }));
  return { openDecisions, recentAnswers, personQuestions, shouts };
}

/** Read and update this checkout's last-run version, returning only newly released headlines. */
export function resumeReleaseNotes(info) {
  const record = join(info.gitDir, 'pullboard-checkout', 'resume-version');
  let previous = '';
  try { previous = readFileSync(record, 'utf8').trim(); } catch { /* First resume in this checkout. */ }
  if (!/^\d+\.\d+\.\d+$/u.test(previous)) {
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, `${VERSION}\n`);
    return null;
  }
  if (previous === VERSION) return null;
  const releases = releaseHeadlinesBetween(previous, VERSION);
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(record, `${VERSION}\n`);
  return releases.length ? { releases: releases.slice(0, 3), omitted: Math.max(0, releases.length - 3), notes: 'CHANGELOG.md' } : null;
}

/** Identify setup from this board's coordinator enrollment, independently of agent flags. */
export function setupIdentity(board) {
  return { boardId: store.boardId(board),
    setupStartedAt: store.listAgents(board).find(agent => agent.agent_id === COORDINATOR)?.agent_created_at };
}

/** Read only the view's typed successful-bind receipt for this board and setup. */
function viewBindComplete(ctx, board) {
  let receipt;
  try { receipt = JSON.parse(readFileSync(join(ctx.info.commonDir, 'pullboard', 'view-bind.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  const identity = setupIdentity(board);
  return receipt?.type === 'pullboard.view.bound' && receipt.version === 1
    && receipt.boardId === identity.boardId && receipt.setupStartedAt === identity.setupStartedAt
    && Number.isFinite(Date.parse(receipt.boundAt))
    && Date.parse(receipt.boundAt) >= Date.parse(identity.setupStartedAt);
}

/** A separately typed, authenticated reuse also proves that this board's view was opened. */
export function viewSetupComplete(ctx, board) {
  if (viewBindComplete(ctx, board)) return true;
  let receipt;
  try { receipt = JSON.parse(readFileSync(join(ctx.info.commonDir, 'pullboard', 'view-reuse.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  const identity = setupIdentity(board);
  return receipt?.type === 'pullboard.view.reused' && receipt.version === 1
    && receipt.boardId === identity.boardId && receipt.setupStartedAt === identity.setupStartedAt
    && Number.isFinite(Date.parse(receipt.openedAt))
    && Date.parse(receipt.openedAt) >= Date.parse(identity.setupStartedAt);
}

/** Atomically record a successful real view bind, scoped to this board's current setup. */
export function recordViewBind(ctx, board, boundAt) {
  const file = join(ctx.info.commonDir, 'pullboard', 'view-bind.json');
  const temporary = file + '.' + randomUUID() + '.tmp';
  const receipt = { type: 'pullboard.view.bound', version: 1, ...setupIdentity(board), boundAt };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temporary, JSON.stringify(receipt) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

/** Record this board's authenticated reuse without claiming that its existing listener bound again. */
export function recordViewReuse(ctx, board, view) {
  const file = join(ctx.info.commonDir, 'pullboard', 'view-reuse.json');
  const temporary = file + '.' + randomUUID() + '.tmp';
  const receipt = { type: 'pullboard.view.reused', version: 1, ...setupIdentity(board),
    openedAt: new Date().toISOString(), boundAt: view.boundAt, port: view.port, pid: view.pid };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temporary, JSON.stringify(receipt) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

/** Read a typed setup receipt only for this board's current coordinator enrollment. */
function setupReceiptMatches(ctx, identity, state) {
  let receipt;
  try { receipt = JSON.parse(readFileSync(join(ctx.info.commonDir, 'pullboard', `setup-${state}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  return receipt?.type === `pullboard.setup.${state === 'complete' ? 'completed' : state}` && receipt.version === 1
    && receipt.boardId === identity.boardId && receipt.setupStartedAt === identity.setupStartedAt;
}

/** Atomically record a setup transition, scoped to this board enrollment. */
export function recordSetupState(ctx, identity, state) {
  const file = join(ctx.info.commonDir, 'pullboard', `setup-${state}.json`);
  const temporary = file + '.' + randomUUID() + '.tmp';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temporary, JSON.stringify({ type: `pullboard.setup.${state === 'complete' ? 'completed' : state}`, version: 1, ...identity }) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

/** Derive setup from real inputs; a caller may share its already-read current decision snapshot. */
export function boardSetup(ctx, card, identity, { decisions: capturedDecisions } = {}) {
  const rows = loadSpec(ctx.info.root, ctx.config).rows;
  const approved = rows.filter(row => row.status === 'approved');
  const decisions = capturedDecisions ?? withBoard(ctx, (board) => store.rowDecisions(board));
  const open = setupDecisionRows(ctx.info.root, ctx.config, decisions, rows);
  const toApply = open.filter(row => row.decision);
  const drafted = open.filter(row => !row.decision);
  const recordedComplete = setupReceiptMatches(ctx, identity, 'complete');
  const started = setupReceiptMatches(ctx, identity, 'started');
  const lanes = laneNames(ctx.config).filter(lane => !['review', COORDINATOR].includes(lane));
  const folders = readdirSync(ctx.info.root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map(entry => entry.name).sort();
  const lane = lanes[0] ?? folders[0] ?? 'app';
  // Older installations had no setup marker. Preserve their completed five-step state on upgrade.
  const legacyUnmarked = !existsSync(join(ctx.info.commonDir, 'pullboard', 'setup-started.json'))
    && !existsSync(join(ctx.info.commonDir, 'pullboard', 'setup-complete.json'));
  const legacyComplete = legacyUnmarked && approved.length > 0 && lanes.length > 0
    && Boolean(ctx.config.gate?.trim()) && card.all.length > 0 && card.viewOpened;
  const completed = recordedComplete || legacyComplete;
  const detectedGate = detectGate(ctx.info.root);
  /** Quote the exact suggested command safely for a shell. */
  const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
  /** Quote one shell word only when it needs it, so a plain lane command reads as typed. */
  const word = value => /^[A-Za-z0-9._/-]+$/u.test(String(value)) ? String(value) : quote(value);
  const steps = [
    requirementStep({ rows, drafted, toApply, completed: completed && !open.some(row => row.staleDecision), hasItems: card.all.length > 0 }),
    { number: 2, done: lanes.length > 0, question: `Ask the person: how should we divide the work? Suggested folders: ${folders.join(', ') || 'app/ (create it for the app)'}.`,
      command: `pullboard lane add ${word(lane)} --owns ${word(lane + '/')}` },
    { number: 3, done: Boolean(ctx.config.gate?.trim()),
      question: detectedGate
        ? `Ask the person: which command proves the build works? Suggested: ${detectedGate}.`
        : 'Ask the person: if this board has no build, use `pullboard spec check` to check its spec and practice files; a second agent review checks the actual work. Or choose a custom gate command.',
      command: gateConfig.settingCommand(ctx.info.root, detectedGate || 'pullboard spec check') },
    { number: 4, done: card.all.length > 0, question: 'Ask the person: what is the first small piece we should build?',
      command: `pullboard add ${quote(lane)} 'First small piece' --specs ${quote(approved[0]?.id ?? 'G1')} --criterion 'Describe what the person will be able to do'` },
    { number: 5, done: card.viewOpened,
      question: 'Ask the person: shall we open the board so you can follow the work?', command: 'pullboard view',
      afterAnswer: 'Run this in the person’s own terminal, or start it in the background as the agent so setup can continue. The view records its successful bind or authenticated reuse for this board.' },
  ].map(step => ({ ...step, question: ctx.io.guidance(step.question, { leading: true }) }));
  const current = steps.find(step => !step.done);
  if (!current && !recordedComplete) recordSetupState(ctx, identity, 'complete');
  else if (current && !completed && !started) recordSetupState(ctx, identity, 'started');
  const seat = ctx.io.callerRole() === 'seat';
  if (current?.number === 1 && !drafted.length && toApply.length) return { step: 1, total: 5, ...current, steps, ...applyStep(toApply.map(row => row.id), seat) };
  if (current?.number === 1 && drafted.length) {
    const rowIds = drafted.map(row => row.id);
    const names = rowIds.join(', ');
    const command = `pullboard spec show ${rowIds[0]}`;
    // A pending question takes an answer, a draft row an approval: each gets the command that decides it.
    const { personCommand, verb, seatQuestion, seatNext } = personAsk(drafted);
    return { step: 1, total: 5, ...current, steps, waitingOn: 'person-approval', rowIds, ...(toApply.length ? { approvedRowIds: toApply.map(row => row.id) } : {}),
      question: ctx.io.guidance((seat ? seatQuestion : `Waiting for the person to ${verb} ${names}.`) + drafted.filter(row => row.staleDecision).map(row => ` ${row.stage}`).join('')), command,
      personCommand,
      afterAnswer: (toApply.length ? `The person already approved ${toApply.map(row => row.id).join(', ')}; pullboard spec apply writes them. ` : '') + 'The person approves draft rows and answers questions in Pullboard View or their own terminal; then the coordinator runs pullboard spec apply.',
      agentNext: seat ? seatNext : (toApply.length ? 'pullboard spec apply for the approved rows; then ' : '') + `wait for the person to ${verb} ${names}; meanwhile ${command}` };
  }
  return current ? { step: current.number, total: 5, ...current, steps } : null;
}







/** Describe the active configured location for new agent worktrees. */
export function worktreeLocation(mainRoot, config) {
  return config.worktrees === 'inside'
    ? join(mainRoot, '.claude', 'worktrees', '<lane>-N')
    : join(dirname(mainRoot), `${basename(mainRoot)}-<lane>-N`);
}

/** Explain how to recover the configured location when the primary checkout cannot be proven. */
export function unavailableWorktreeLocation() {
  return 'unavailable; run pullboard resume from the main checkout to see the configured location';
}

/** Find initialized setup that is on disk but absent from the primary checkout's committed policy. */
export function uncommittedPolicySetup(info) {
  const primary = mainCheckout(info.root);
  if (!primary?.commit) return null;
  const committedConfig = tryGit(info.root, ['ls-tree', '-z', primary.commit, '--', `:(literal)${CONFIG_FILE}`]);
  if (committedConfig.status !== 0 || committedConfig.stdout) return null;

  // The primary checkout is info.root when the gate runs there. From a linked worktree, the
  // common directory's parent is the primary checkout only for a plain .git directory: with
  // git init --separate-git-dir it is unrelated, so report the original refusal instead.
  const mainRoot = info.isMain ? info.root : basename(info.commonDir) === '.git' ? resolve(info.commonDir, '..') : null;
  if (!mainRoot) return null;
  let config;
  try { config = loadConfig(mainRoot); }
  catch { return null; }
  const setup = uncommittedSetup(mainRoot, config);
  return setup?.files.includes(CONFIG_FILE) ? setup : null;
}

/**
 * Refuse a worktree whose agent would start without pullboard's files as the main checkout has
 * them: no config, rules or hooks, or older ones (I4). Name each file and how it differs, and the
 * command that commits just those (C4).
 *
 * @param {string} mainRoot
 * @param {any} config
 */
export function refuseUncommittedSetup(mainRoot, config) {
  const hasCommit = headCommit(mainRoot) !== null;
  const differ = differFromHead(mainRoot, setupFiles(mainRoot, config))
    .filter(({ path, how }) => !(path === CONFIG_FILE && how === 'changed' && onlyNamedBoardChanged(mainRoot)));
  if (hasCommit && !differ.length) return;
  const why = hasCommit
    ? `a new worktree starts from the last commit, and these differ from it here: ${differ.map(({ path, how }) => `${path} (${how})`).join(', ')}`
    : `this repo has no commit yet, and a new worktree starts from one; not committed: ${differ.map(({ path, ignored }) => (ignored ? `${path} (git ignores it)` : path)).join(', ')}`;
  const words = differ.map(({ path }) => shellWord(path)).join(' ');
  // No commit holds a file git ignores unless it is added by force.
  const force = differ.some(({ ignored }) => ignored) ? ' -f' : '';
  const subject = hasCommit ? 'chore: commit pullboard files' : 'chore: set up pullboard';
  throw new Refused('NOT_COMMITTED', `${why}. Commit them first: ${cdTo(mainRoot)} git add${force} -- ${words} && git commit -q -m "${subject}" -- ${words}`);
}



/** Report and pin the original submitted commit, including a recovered acknowledged outcome. */
export async function reportSubmission(ctx, id, commit, gate, doctrine = []) {
  const { root } = ctx.info;
  const pin = `refs/pullboard/items/${id}/${commit.slice(0, 12)}`;
  git(root, ['update-ref', pin, commit]);
  const submission = { id, commit, pin, gate, ...(doctrine.length ? { doctrine } : {}) };
  if (ctx.submissionResult) ctx.submissionResult.value = submission;
  try {
    const { deliverActivity, activityDeliveryLines } = await import('./activity-delivery-cli.js');
    const delivery = await deliverActivity(ctx, { afterSubmit: true, directShouts: false });
    submission.activity = delivery.activity;
    for (const line of activityDeliveryLines(delivery, ctx.config)) ctx.io.say(line);
  } catch (error) {
    submission.activity = { receipt: { recorded: false, code: error.code ?? 'ACTIVITY_DELIVERY_FAILED', message: error.message } };
    ctx.io.err(`submitted #${id}, but its activity delivery failed: ${error.message}; read pullboard inbox to retry delivery`);
  }
  ctx.io.result?.(submission);
  ctx.io.say(`submitted #${id} at ${commit.slice(0, 12)}; ${gate.report}`);
  ctx.io.say(`pinned as ${pin}, so this work can't be lost; keep your worktree until it is merged`);
  ctx.io.say(`next: ${reviewerStartup(primaryCheckoutRoot(ctx.info), ctx.config, id)}`);
  return 0;
}

/**
 * Add a blueprint to the board of the checkout io.cwd names, exactly as pullboard blueprint add
 * does; init --blueprint calls it after setting up the repo. With report false it prints nothing
 * and leaves the command's JSON result to the caller. A caller that already read the blueprint
 * passes it, so the file is read once: init checks it before writing anything and must add the
 * very blueprint it checked.
 *
 * @param {any} io
 * @param {string} reference - A bundled blueprint name or a path to a blueprint file, relative to io.cwd.
 * @param {{ report?: boolean, blueprint?: ReturnType<typeof readBlueprint>, drafted?: Map<string, string> }} [options] - drafted: see addBlueprint.
 * @returns {Promise<BlueprintAdded>}
 */
export async function addBlueprintHere(io, reference, { report = true, blueprint = readBlueprint(reference, io.cwd), drafted } = {}) {
  const ctx = context(io);
  return await withBoard(ctx, async (board) => await addBlueprint(ctx, board, whoAmI(ctx, board), blueprint, { report, drafted }));
}

/**
 * @typedef {object} BlueprintAdded
 * @property {{ name: string, title: string, version: number }} blueprint
 * @property {string} section - The SPEC.md section heading the rows are in.
 * @property {{ key: string, id: string, status: string, text: string, source?: string }[]} rows - New rows; each waits for the person, with the source its rule names.
 * @property {{ id: number, key: string, title: string, lane: string, askedLane?: string, specIds: string[], after: number[], check?: string }[]} items - New open items.
 * @property {string | null} gate - The gate set in pullboard.json, or null when it was left alone.
 * @property {boolean} marked - This blueprint version was already on the board, so nothing was added.
 * @property {number[]} checksNotRun - New items that carry a check; no check baseline ran for them.
 * @property {{ name: string, owns: string[] }[]} proposedLanes - Proposed, unwritten lanes new starters were filed in.
 * @property {{ key: string, id: string }[]} shared - Keys that cite a row an earlier blueprint in the same command drafted.
 */

/**
 * Add a blueprint to this board in one step (I1): its rules and questions as draft and pending rows
 * in a new SPEC.md section, its starter items as open items citing them, and its gate when
 * pullboard.json has none. Rows are written the way spec draft writes them, so nothing is approved;
 * a repeat of the same blueprint version adds nothing.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {{ id: string }} me
 * @param {import('./blueprints.js').Blueprint} blueprint
 * @param {{ report?: boolean, result?: boolean, drafted?: Map<string, string> }} [options] - report false prints nothing and sets no
 *   JSON result; result false prints but sets none. drafted: rows earlier blueprints of this command drafted, by text (#720).
 * @returns {Promise<BlueprintAdded>}
 */
export async function addBlueprint(ctx, board, me, blueprint, { report = true, result = report, drafted = new Map() } = {}) {
  const io = report ? (result ? ctx.io : { say: (text) => ctx.io.say(text) }) : { say: () => {} };
  const spec = loadSpec(ctx.info.root, ctx.config);
  if (!spec.exists) throw new Refused('NO_SPEC', `no ${ctx.config.spec}; run: pullboard init`);
  const malformed = [[spec.file, spec.problems], [ctx.doctrine.repo.file, ctx.doctrine.repo.problems]].find(([, problems]) => problems.length);
  if (malformed) throw new Refused('SPEC_INVALID', `fix the unparsed row in ${malformed[0]} before adding a blueprint; an existing id may be ambiguous`);
  const source = readFileSync(spec.file, 'utf8');
  const configFile = join(ctx.info.root, CONFIG_FILE);
  const configSource = readFileSync(configFile, 'utf8');
  // A question takes the answer this repo already shows as its default, read from package.json
  // only: nothing runs and nothing is fetched (#725).
  const plan = planBlueprint(landBlueprint(blueprint, repoAnswers(ctx.info.root)), { source, spec, doctrine: ctx.doctrine,
    existingItems: store.listItems(board, { all: true }).map((item) => ({ id: item.item_id, title: item.item_title, specIds: item.item_spec_ids ? item.item_spec_ids.split(',') : [] })),
    gate: String(JSON.parse(configSource).gate ?? ''), drafted, reserved: store.rowDrafts(board).map((draft) => draft.id) });
  for (const row of plan.rows) drafted.set(row.text, row.id);
  // Every starter is checked before anything is written, so a refusal leaves the board as it was.
  // Starters go to a build lane, never the coordinator's; a proposed lane is named, not written (#732).
  const proposals = proposeLanes(ctx.info.root, ctx.config);
  const lanes = plan.items.map((entry) => starterLane(entry.lane, ctx.config, proposals));
  const proposedLanes = proposals.filter((lane) => lanes.some((placed) => placed.proposal === lane));
  const starters = plan.items.map((entry, index) => ({ key: entry.key, afterKeys: entry.after, asked: lanes[index].asked, item: { by: me.id, lane: lanes[index].lane,
    title: entry.title, criterion: entry.criterion, specIds: entry.specIds, parentId: null, after: [], brief: entry.brief, route: entry.route,
    ...(entry.check === undefined ? {} : { check: starterCheck(blueprint, entry.check, lanes[index], ctx.config) }) } }));
  // Bundled checks are scoped at placement; add stores checks without executing them or starting a baseline.
  // Every bundled starter carries a check (#724), and only the coordinator sets one, so an agent's
  // add is refused with the step that works: add it from the coordinator's checkout.
  if (me.id !== COORDINATOR && starters.some(({ item }) => item.check !== undefined)) {
    throw new Refused('COORDINATOR_CHECK', `the ${blueprint.name} blueprint's starter items carry checks, and only the coordinator sets an item check; run pullboard blueprint add from the main checkout, or ask your coordinator: pullboard shout coordinator "please add the ${blueprint.name} blueprint"`,
      'run the same pullboard blueprint add from the main checkout, where the coordinator works');
  }
  for (const { item } of starters) store.validateItemAddition(board, item);
  // Each new row's id is reserved on the board before SPEC.md names it; if another writer took one first, this add runs again for the next ids (#878).
  for (const row of plan.rows) if ((await ordered(ctx, board, 'draftSpecRow', [{ agentId: me.id, row: { id: row.id, text: row.text, target: 'spec' }, written: true }])).id !== row.id) throw new Refused('ROW_ID_TAKEN', `${row.id} was just reserved by another writer; run the same pullboard blueprint add again for the next free id`);
  const files = [];
  if (plan.specRows !== source) files.push({ file: ctx.config.spec, before: source, after: plan.specRows });
  if (plan.gate) {
    const newline = configSource.includes('\r\n') ? '\r\n' : '\n';
    files.push({ file: CONFIG_FILE, before: configSource,
      after: `${JSON.stringify({ ...JSON.parse(configSource), gate: plan.gate }, null, 2).replaceAll('\n', newline)}${newline}` });
  }
  const write = { records: [], files, signoffs: { before: null, receipts: [] } };
  writeRowApply(ctx.info.root, write);
  const added = [];
  try {
    // A retry starts from the starters a failed add already put on the board.
    const byKey = { ...plan.existing };
    for (const { key, afterKeys, asked, item } of starters) {
      item.after = afterKeys.map((before) => byKey[before]).filter(Boolean);
      const id = await ordered(ctx, board, 'addItem', [item]);
      byKey[key] = id;
      // The starter keeps its blueprint's name, in the link #734 reads back (#720).
      await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note', text: blueprintStarterNote(blueprint, key) }]);
      added.push({ id, key, title: item.title, lane: item.lane, ...(asked ? { askedLane: asked } : {}), specIds: item.specIds, after: item.after, ...(item.check ? { check: item.check } : {}) });
    }
  } catch (error) {
    // Items already added stay on the board; with no marker yet, a retry adds only what is missing.
    if (!added.length) restoreRowApply(ctx.info.root, write);
    throw error;
  }
  // The marker goes in last, once every row and item is on the board.
  if (plan.specAfter !== plan.specRows) {
    writeRowApply(ctx.info.root, { records: [], files: [{ file: ctx.config.spec, before: plan.specRows, after: plan.specAfter }], signoffs: { before: null, receipts: [] } });
  }
  if (plan.specAfter !== source && !files.some((file) => file.file === ctx.config.spec)) files.unshift({ file: ctx.config.spec });
  const rows = plan.rows.map(({ key, id, status, text, source }) => ({ key, id, status, text, ...(source ? { source } : {}) }));
  const summary = { blueprint: { name: blueprint.name, title: blueprint.title, version: blueprint.version },
    section: plan.section.name, rows, items: added.map((item) => ({ ...item, blueprint: blueprint.name })), gate: plan.gate, shared: plan.shared, marked: plan.marked, proposedLanes: added.length ? proposedLanes : [],
    // Item checks are stored and never run during add; the caller tells the reader so.
    checksNotRun: added.filter((item) => item.check).map((item) => item.id) };
  io.result?.(summary);
  if (plan.marked) {
    io.say(`${blueprint.title} (version ${blueprint.version}) is already on this board; nothing added; see its starters with pullboard blueprint starters ${blueprint.name}`);
    // A board an older Pullboard set up gets the blueprint's kind recorded beside its marker (#720).
    if (plan.specRows !== source) io.say(`  recorded its kind (${blueprint.kind ?? 'none'}) in ${ctx.config.spec}; commit ${ctx.config.spec}`);
    return summary;
  }
  io.say(`added ${blueprint.title} (version ${blueprint.version}) as drafts in ${ctx.config.spec}, section ${plan.section.name}`);
  for (const row of rows) io.say(`  ${row.id} ${row.status}  ${row.text}`);
  for (const item of added) io.say(`  #${item.id} open  ${item.title}${item.specIds.length ? `  cites ${item.specIds.join(', ')}` : ''}${item.after.length ? `  waits on #${item.after.join(', #')}` : ''}`);
  const checked = added.filter((item) => item.check);
  if (checked.length) io.say(`  checks stored, not run: ${checked.map((item) => `#${item.id}`).join(', ')}; no check baseline ran during add, so read each check before work starts: pullboard show <id>`);
  for (const note of [...askedLaneNotes(added, ctx.config), ...starterLaneNotes(summary.proposedLanes)]) io.say(`  ${note}`);
  if (plan.gate) io.say(`  gate set in ${CONFIG_FILE}: ${plan.gate}`);
  for (const line of sharedRowLines(summary)) io.say(`  ${line}`);
  const changed = files.map((file) => file.file);
  io.say(`next: the person approves the rows in pullboard view or with pullboard spec approve <ids>${changed.length ? `; commit ${changed.join(' and ')}` : ''}`);
  return summary;
}


/**
 * Say the exact command that lands an accepted item in this repo [B3].
 * A repo with a push remote lands through pullboard land; one without merges by hand,
 * because pullboard land would refuse LAND_PUSH there.
 *
 * @param {any} info
 * @param {any} item
 * @param {string} [commit] - The exact checked composition the acceptance authorizes.
 * @param {{ spec?: any }} [options] - The spec the trailer's rows are ordered by.
 * @returns {string}
 */
export function landNext(info, item, commit = item.item_commit, { spec = null } = {}) {
  const mainRoot = primaryCheckoutRoot(info);
  const trunk = mainCheckout(info.root);
  const branch = trunk?.branch ?? '';
  const remote = landingRemote(info.root, branch);
  const command = remote ? 'pullboard land'
    : handMergeCommand(item, commit, { root: info.root, base: trunk?.commit, spec, quote: shellWord });
  if (!mainRoot) return `next: could not safely locate the primary checkout; run from the main checkout: ${command}`;
  if (remote) return `next: the coordinator lands it: ${cdTo(mainRoot)} ${command}`;
  return `next: this repo has no remote for pullboard land to push to, so the coordinator merges it on ${branch.replace(/^refs\/heads\//u, '') || 'the trunk'}: ${cdTo(mainRoot)} ${command}`;
}

/** Resolve a usable primary checkout without trusting the Git metadata directory as a path. */
export function primaryCheckoutRoot(info) {
  if (info.isMain) return info.root;
  let commonDir;
  try { commonDir = realpathSync.native(info.commonDir); }
  catch { return null; }
  /** Return unique validated primary checkouts among candidate repository paths.
   *
   * @param {string[]} candidates
   * @returns {string[]}
   */
  const matches = (candidates) => {
    const roots = new Map();
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || !isAbsolute(candidate)) continue;
      try {
        const result = tryGit(candidate, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']);
        const fields = result.stdout.split('\n');
        if (result.status !== 0 || fields.length !== 3 || fields.some((field) => !field)) continue;
        const [root, gitDir, candidateCommonDir] = fields;
        if (!existsSync(join(root, '.git'))
          || realpathSync.native(candidateCommonDir) !== commonDir
          || realpathSync.native(gitDir) !== realpathSync.native(candidateCommonDir)) continue;
        roots.set(realpathSync.native(root), root);
      } catch { /* A stale registry entry or Git metadata directory is not a usable checkout. */ }
    }
    return [...roots.values()];
  };
  const worktrees = tryGit(info.root, ['worktree', 'list', '--porcelain', '-z']);
  if (worktrees.status === 0) {
    const candidates = worktrees.stdout.split('\0')
      .filter((field) => field.startsWith('worktree '))
      .map((field) => field.slice('worktree '.length));
    const found = matches(candidates);
    if (found.length === 1) return found[0];
  }
  const registered = registeredProjectRootsSnapshot();
  if (registered === null) return null;
  const found = matches(registered);
  return found.length === 1 ? found[0] : null;
}

/** A real runtime session may route across its own local seats; marker-only shells stay isolated. */
function nextSessionSeats(ctx, board) {
  if (ctx.info.isMain || ctx.io.personChannel === 'view' || ctx.io.personRequest
    || !personIdentity.AGENT_SESSION_IDS.some((name) => Boolean(process.env[name]))) return null;
  const digest = personIdentity.agentSessionDigest();
  return digest ? localSessionSeats(ctx.info, { agents: store.listAgents(board), digest }) : null;
}

/** Choose or open the matching lane seat, retaining ordinary checkout ownership and lane guards. */
async function nextSeatContext(ctx, board, me, item, seats) {
  const available = seats.filter((agent) => agent.agent_lane === item.item_lane
    && store.ROUTES.indexOf(agent.agent_route) >= store.ROUTES.indexOf(item.item_route));
  const held = item.item_status === 'claimed';
  let agent = held ? available.find((seat) => seat.agent_id === item.item_owner)
    : available.find((seat) => seat.agent_id === me.id) ?? available[0];
  let created = false;
  if (!agent) {
    let opened;
    const { worktreeFor } = await import('./commands/worktree.js');
    await worktreeFor({ ...ctx.io, say: () => {}, result: (value) => { opened = value; } }, item.item_lane, me.route, me.family, me.model, false);
    agent = store.agentAt(board, opened.path);
    created = true;
  }
  const target = agent.agent_path === ctx.info.root ? ctx : context({ ...ctx.io, cwd: agent.agent_path });
  if (target.info.commonDir !== ctx.info.commonDir) throw new Refused('NOT_YOUR_CHECKOUT', 'the selected lane seat no longer belongs to this board; run pullboard next again');
  await bindLocalSession(target.info, { agent: agent.agent_id, digest: personIdentity.agentSessionDigest() });
  return { context: target, seat: { agent: agent.agent_id, lane: agent.agent_lane, path: target.info.root, created } };
}

/**
 * One loop of `next`: claim the next free item, or reserve the next review (V15). A claim that loses
 * a race to another agent is not an error; the caller looks again. A review is looked for and
 * reserved in one transaction, so it cannot lose that race.
 *
 * @param {any} ctx
 * @param {any} values
 * @returns {{ item?: any, held?: boolean, retry?: boolean, reasons?: string[] }}
 */
export async function nextOnce(ctx, values) {
  // Select on a read-only board; only a claim, or a review reservation, opens it for writing (#1047).
  const looked = values.verify ? { claim: true } : withBoardRead(ctx, (board) => nextPick(ctx, board, values));
  if (!looked.claim) return looked;
  return await withBoard(ctx, async (board) => {
    if (values.verify) checkMainVerifier(ctx, board, values);
    if (values.verify) return nextReview(ctx, board, whoAmI(ctx, board), values, { ordered: (operation, args) => ordered(ctx, board, operation, operation === 'reopen' ? computedReturnArgs(board, args) : args), idArg, trunkMerge });
    const picked = nextPick(ctx, board, values);
    if (!picked.claim) return picked;
    const { me, item, held, shared, reasons, reviewSkipped, seats } = picked;
    const routed = seats ? await nextSeatContext(ctx, board, me, item, seats) : { context: ctx };
    const target = routed.context;
    const holder = whoAmI(target, board);
    try {
      await claimOrdered(target, board, [item.item_id, { agentId: holder.id, lane: holder.lane, leaseMs: target.config.leaseMs, freeze: claimFreezer(target, board), head: headCommit(target.info.root), reviewSkipped }]);
    } catch (error) {
      if (error instanceof MainSpecMerged) return { retry: true, ...routed, specMerged: { item: item.item_id, rows: error.rows } };
      if (error instanceof Refused && ['HELD', 'ITEM_HELD', 'BLOCKED', 'ONE_CLAIM'].includes(error.code)) return { retry: true };
      throw error;
    }
    return { item: store.getItem(board, item.item_id), shared, held, reviewSkipped, reasons, ...routed };
  });
}

/** The selection half of one next loop: the item to claim, or what to print instead. It only reads (#1047). */
function nextPick(ctx, board, values) {
  const me = whoAmI(ctx, board);
  const warm = warmFiles(ctx, board, me);
  const seats = nextSessionSeats(ctx, board);
  // A claim belongs to the seat that made it: seats of one session share its environment, so a sibling's claim is
  // never this seat's to resume or be pointed at (#958).
  const heldItem = seats ? store.listItems(board).find((item) => item.item_status === 'claimed'
    && item.item_parent_id === null && item.item_owner === me.id
    && store.ROUTES.indexOf(item.item_route) <= store.ROUTES.indexOf(me.route)) : undefined;
  const { item, reasons, shared } = heldItem ? { item: heldItem, reasons: [], shared: [] }
    : store.nextFor(board, { agentId: me.id, lane: me.lane, runnable: values.runnable, routes: values.routes, warm,
      ...(seats ? { lanes: laneNames(ctx.config).filter((lane) => lane !== COORDINATOR) } : {}),
      priority: mainRedReworkItems(ctx.info.root, board) });
  const held = item?.item_status === 'claimed';
  /** Offer only reviews this seat may give; a linked board previews its engine-27 verifier standing (#579). */
  const findOffer = () => store.reviewOffer(board, { agentId: me.id, lane: me.lane, policy: ctx.config.verify.policy,
    familyPolicy: ctx.config.verify.family, ratio: ctx.config.verify.reviewRatio, runnable: values.runnable, routes: values.routes });
  const offer = held ? null : relayLinked(ctx.info.root) ? store.withVerifierStanding(board, { root: true }, findOffer) : findOffer();
  if (offer && !values.build && focusReviewFirst(board, offer.item, item)) return { item: offer.item, offer, build: item ?? null, reasons: focusReasons(board, offer.item) };
  if (!item) return { reasons, laneWork: ctx.info.isMain ? mainLaneWork(store.listItems(board)) : null };
  const reviewSkipped = values.build && !held
    ? { offeredItem: offer?.item.item_id ?? null, ratio: offer?.ratio ?? ctx.config.verify.reviewRatio, ...store.reviewQueue(board) } : null;
  return { claim: true, me, item, held, shared, reasons, reviewSkipped, seats };
}


/**
 * `pullboard sweep` (N15, N17): run a checker, then file one routed item per file it flags, each
 * with the problems in its brief and the checker on that file as its check. Each check runs once
 * first, on the file as it is: it must fail there, or it could never prove a fix.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {{ id: string }} me
 * @param {any} values
 * @returns {Promise<number>}
 */
export async function sweepHere(ctx, board, me, values) {
  if (me.id !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'the coordinator files sweep items, from the main checkout');
  const report = String(values.run ?? '').trim();
  const check = String(values.check ?? '').trim();
  if (!report || !check.includes('{file}')) {
    throw new Refused('USAGE', 'pullboard sweep --run "<checker over the repo>" --check "<the checker on one file, with {file} where its path goes>"');
  }
  const max = values.max === undefined ? 20 : idArg(values.max, 'a number after --max');
  const ran = spawnSync(report, { cwd: ctx.info.root, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  invalidateGitFacts();
  const problems = parseProblems(`${ran.stdout ?? ''}\n${ran.stderr ?? ''}`, ctx.info.root);
  if (!problems.length) {
    ctx.io.say(`the checker reported no problems I can read (exit ${ran.status}); nothing to file`);
    return 0;
  }
  const covered = new Set(store.listItems(board).filter((item) => item.item_title.startsWith('fix ')).flatMap((item) => briefFiles(item.item_brief)));
  const { items, skipped } = sweepItems(problems, {
    laneOf: (path) => laneOf(ctx.config, path),
    covered,
    check,
    report,
    route: values.route ?? 'light',
    max,
  });
  const blind = [];
  for (const item of items) {
    const canary = spawnSync(item.check, { cwd: ctx.info.root, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    invalidateGitFacts();
    if (canary.status === 0) {
      blind.push(item.file);
      continue;
    }
    if (values['dry-run']) {
      ctx.io.say(`would file: ${item.title} (${item.lane} lane, ${item.route})`);
      continue;
    }
    const id = await ordered(ctx, board, 'addItem', [{ by: me.id, lane: item.lane, title: item.title, criterion: item.criterion, brief: item.brief, route: item.route, check: item.check }]);
    ctx.io.say(`#${id} ${item.title} (${item.lane} lane, ${item.route})`);
  }
  if (skipped.length) ctx.io.say(`already open: ${skipped.join(', ')}`);
  if (blind.length) {
    const refusal = new Refused('CHECK_CANNOT_FAIL', `the check passes on ${blind.join(', ')} although the checker flags problems there, so it could never prove a fix; not filed. A check ending in a pipe takes its exit status from the last command. Fix the check so flagged files make it fail, then run pullboard sweep again.`);
    ctx.io.refusal?.(refusal);
    ctx.io.err(`pullboard: ${refusal.message}`);
  }
  const filed = items.length - blind.length;
  ctx.io.say(`${problems.length} problems in ${new Set(problems.map((problem) => problem.file)).size} files; ${values['dry-run'] ? 'would file' : 'filed'} ${filed}`);
  return blind.length ? 1 : 0;
}

/** Run board work for the caller's checkout, or select its device-local repo board for a private add. */
export function actOn(io, work, { privateBoard = false } = {}) {
  const ctx = context(io);
  if (privateBoard) return runPrivateBoard(ctx, work, { withBoard, whoAmI,
    checkoutLeases: CHECKOUT_LEASES, checkoutBoardOnly: CHECKOUT_BOARD_ONLY });
  return withBoard(ctx, (board) => work(ctx, board, whoAmI(ctx, board)));
}


/** Name a known board seat for queue diagnostics without requiring an unjoined checkout to join. */
export function resourceAgent(ctx) {
  return ctx.info.isMain ? COORDINATOR : withBoard(ctx, board => store.agentAt(board, ctx.info.root)?.agent_id);
}

/** Keep the public queue adapter while its lease protocol lives in a bounded module. */
export function queuedItemLease(ctx, initial, agentId, kind, admission = null) {
  return createQueuedItemLease(ctx, initial, agentId, kind, admission);
}

/**
 * Every spec id something cites (S8): commit headers since the spec's first commit, and every item
 * on the board, open or closed. The connection is read-only: spec lint never migrates a shared board. Each must still be in the spec. The board is shared by every
 * checkout, so at an older commit an item may cite a row a later commit added: that id is not lost
 * here, only not written yet, and it counts once any ref has committed it (S10).
 *
 * @param {any} ctx
 * @param {{ ids: Map<string, string>, since: string | null }} history - this checkout's.
 * @returns {Map<string, string>} Each id, with who cites it.
 */
export function citations(ctx, { ids, since }) {
  const cited = since ? commitCitations(ctx.info.root, since) : new Map();
  if (!existsSync(ctx.file)) return cited;
  const byItems = new Map();
  for (const item of hookRead(ctx, (board) => store.listItems(board, { all: true }))) {
    for (const id of item.item_spec_ids ? item.item_spec_ids.split(',') : []) {
      if (!cited.has(id) && !byItems.has(id)) byItems.set(id, `item #${item.item_id}`);
    }
  }
  const unseen = [...byItems.keys()].some((id) => !ids.has(id));
  const elsewhere = unseen ? committedIds(ctx.info.root, ctx.config.spec, ['--all']).ids : new Map();
  for (const [id, where] of byItems) if (ids.has(id) || !elsewhere.has(id)) cited.set(id, where);
  return cited;
}

/** Current board evidence, with each item's accepting receipts included once. */
export function specProof(ctx) {
  if (!existsSync(ctx.file)) return { items: [], verdicts: [] };
  return withBoard(ctx, (board) => {
    const items = store.listItems(board, { all: true });
    return { items, verdicts: items.flatMap((item) => store.verdictsFor(board, item.item_id)) };
  });
}



/**
 * Every private name a saved blueprint must never carry: each agent's id, display name, model
 * and family, the person's Git name and email, everyone who signed off or signs rows, and this
 * machine's host name, whole, plus the parts of each (a first name, an email's user) to match
 * only as written. Missing sources add nothing; they never stop the save [S1].
 */
export function privateNames(root, board, spec) {
  const names = new Set();
  const parts = new Set();
  const add = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    // "unknown" is the label for an undeclared model, not anyone's name.
    if (!text || text === 'unknown') return;
    names.add(text);
    for (const part of text.split(/[\s@.<>()]+/u)) if (part.length >= 3 && part !== 'unknown' && part !== text) parts.add(part);
  };
  for (const agent of store.listAgents(board)) {
    add(agent.agent_id); add(agent.agent_model); add(agent.agent_family); add(displayAgentName(agent)); add(displayAgentName(agent, 'prefix'));
  }
  for (const key of ['user.name', 'user.email']) add(tryGit(root, ['config', '--get', key]).stdout);
  for (const ident of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const found = /^(.*?)\s*<([^>]*)>/u.exec(tryGit(root, ['var', ident]).stdout ?? '');
    if (found) { add(found[1]); add(found[2]); }
  }
  try { for (const record of readSignoffs(root)) add(record.by); } catch { /* An unreadable sign-off file adds no names. */ }
  for (const row of spec.rows) for (const signer of row.signers ?? []) add(signer);
  add(hostname());
  add(hostname().split('.')[0]);
  return { names: [...names], parts: [...parts] };
}
