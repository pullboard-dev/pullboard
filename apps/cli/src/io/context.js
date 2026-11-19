/** @pullboard-module-loads packages/link/index.js */
/** The synchronous write-board lifecycle and compatible public CLI context exports [C7]. */
import * as store from '../../../../packages/store/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { holdsLiftSettled } from '../../../../packages/config/index.js';
import { releaseRerouteUntouched } from '../../../../packages/config/index.js';
import { reviewHoldAfterTwoReleases } from '../../../../packages/config/index.js';
import { createRequire } from 'node:module';
import { moveArgs } from '../../../../packages/person/index.js';
import {
  agentDisplayName,
  context,
  withOpenedBoard,
  idArg,
  idList,
  shellWord,
  cdTo,
  sayBrief,
  firstLineOf,
  itemLine,
  setupFiles,
  uncommittedSetup,
  span,
} from './read.js';
export {
  idArg,
  idList,
  shellWord,
  cdTo,
  sayBrief,
  context,
  firstLineOf,
  itemLine,
  agentDisplayName,
  setupFiles,
  uncommittedSetup,
  span,
};

const requireModule = createRequire(import.meta.url);
/** The refusal formatter, loaded at the first refusal it renders: a command that never refuses never pays for the move registry its next steps read [C7,#8195]. */
const refusalDocument = (...args) => requireModule('../logic/step/words.js').refusalDocument(...args);
/** The relay package, loaded at the first person-signing call that reaches it: a claim, test or next never pays for its ~80 modules [C7,#7081]. */
const link = () => requireModule('../../../../packages/link/index.js');
/** The commit receiver, loaded at the first move that carries commits: only a board host takes them, so a claim, next or add never pays for the pushed-ref and runner git modules [C7,#8395]. */
const receiveCommits = async (...args) => (await import('./submit/pushed.js')).receiveMoveCommits(...args);

/** Supply canonical connection-local runtime composition after cyclic CLI modules finish loading. */
export function nativeBoardOpeners(io) {
  const { openBoard, openBoardForRead } = io.nativeBoard;
  return { moveArgs, receiveCommits, openBoard, openBoardForRead, nativeBoardPorts: io.nativeBoard.nativeBoardPorts, withOutboxGuard: io.withOutboxGuard, replayConflictRecord: io.replayConflictRecord, remoteBoardMissing: io.remoteBoardMissing, uncertainUploadFailure: io.uncertainUploadFailure, decideUncertainBaseline: io.decideUncertainBaseline, checkpointPublisher: io.checkpointPublisher, relayOrdering: io.relayOrdering, checkpointInBackground: io.checkpointInBackground, scheduleCheckpoint: io.scheduleCheckpoint, requestCheckpointCheck: io.requestCheckpointCheck, checkpointWorker: io.checkpointWorker, outboxFields: io.outboxFields, outboxPolicy: io.outboxPolicy, flushOutbox: io.flushOutbox, queueMove: io.queueMove, outboxHasPendingCreatedItem: io.outboxHasPendingCreatedItem };
}

/** Supply the board openers plus the API move executor and refusal formatter that link's request execution is given as ports (link must not import later cells). */
export function nativePersonRequestPorts(io) {
  // The API (and the health, gate and landing it reaches) loads only when a waiting request runs a move [C7].
  const executeMove = async (...args) => (await import('../../../../packages/api/index.js')).executeMove(...args);
  return { ...nativeBoardOpeners(io), executeMove, refusalDocument };
}

/** Bind native request execution at this real CLI composition root. */
async function executeNativePersonRequests(root, io, runCommand) {
  return link().executePersonRequests(root, io, runCommand, nativePersonRequestPorts(io));
}

/** Build a CLI context with the signed-person capabilities of its application layer. */
export function personCommandContext(io, { main, ordered } = {}) {
  const ctx = context(io);
  /** Preserve this invocation's native capabilities for signed recursive commands. */
  const run = main && ((args, streams) => main(args, { ...streams,
    gateWaitReporter: io.gateWaitReporter, loadProcessPorts: io.loadProcessPorts, loadNativeBoard: io.loadNativeBoard,
    hookWorker: io.hookWorker, launchRelaySender: io.launchRelaySender,
    withOutboxGuard: io.withOutboxGuard, replayConflictRecord: io.replayConflictRecord,
    remoteBoardMissing: io.remoteBoardMissing, uncertainUploadFailure: io.uncertainUploadFailure,
    decideUncertainBaseline: io.decideUncertainBaseline, checkpointPublisher: io.checkpointPublisher,
    relayOrdering: io.relayOrdering, checkpointInBackground: io.checkpointInBackground,
    scheduleCheckpoint: io.scheduleCheckpoint, requestCheckpointCheck: io.requestCheckpointCheck,
    checkpointWorker: io.checkpointWorker, openBoard: io.openBoard, nativeBoardPorts: io.nativeBoardPorts,
    outboxFields: io.outboxFields, outboxPolicy: io.outboxPolicy, flushOutbox: io.flushOutbox,
    queueMove: io.queueMove, outboxHasPendingCreatedItem: io.outboxHasPendingCreatedItem,
  }));
  ctx.personPorts = { get DEFAULT_RELAY() { return link().DEFAULT_RELAY; }, relayStatus: root => link().relayStatus(root, io), syncRelay: (...args) => link().syncRelay(...args),
    executePersonRequests: executeNativePersonRequests, main: run, ordered };
  return ctx;
}

/**
 * Open the board, run `work`, and always close it.
 *
 * @template T
 * @param {any} ctx
 * @param {(board: any) => T} work
 * @param {any} [opened] an already-open board, as withBoardRead passes
 * @returns {T}
 */
export function withBoard(ctx, work, opened) {
  // A queued submit's lock stop retries this one call in place; the submit is never restarted (ctx.lockRetry, #3370).
  return ctx.lockRetry && !opened ? ctx.lockRetry(() => openAndRun(ctx, work, opened)) : openAndRun(ctx, work, opened);
}

/** Open the board (or take the opened one) and run `work` on it. */
function openAndRun(ctx, work, opened) {
  const board = opened ?? ctx.nativeBoard.openBoard(ctx.file, ctx.clock, { isMain: ctx.allowSchemaUpgrade,
    gitRoot: ctx.info.root,
    writeContext: { command: ctx.io.relayCommand?.cliOperation, path: ctx.info.root,
      item: /^[1-9]\d*$/u.test(ctx.io.relayCommand?.positionals?.[0] ?? '') ? Number(ctx.io.relayCommand.positionals[0]) : null,
      ...(ctx.info.isMain ? { seat: 'coordinator' } : {}) },
    /** Report each source mismatch once through this invocation's text or JSON diagnostics. */
    onDiagnostic(message) {
      ctx.io.schemaDiagnostics ??= new Set();
      const key = ctx.file + '\n' + message;
      if (ctx.io.schemaDiagnostics.has(key)) return;
      ctx.io.schemaDiagnostics.add(key);
      ctx.io.err(message);
    },
  });
  board.gitRoot = ctx.info.root; // A connection-local verification port, never board or wire metadata.
  // The gate-wait cap this seat's setting grants, sealed into each move it writes so every replica replays it alike [C7].
  board.itemsInGate = ctx.config.claims?.itemsInGate === true ? (Number.isSafeInteger(ctx.config.claims.itemsInGateMax) ? ctx.config.claims.itemsInGateMax : 3) : 0;
  // release.liftTwiceHold (off by default): an automatic released-twice hold lifts when main moves or its named blocker lands [C7,#9002].
  board.liftTwiceHold = ctx.config.release?.liftTwiceHold === true;
  // holds.liftSettled (off by default): a hold whose reason names only landed or withdrawn items, or a parent whose children are done, lifts when main moves [C7,#9699].
  board.liftSettledHolds = holdsLiftSettled();
  // release.rerouteUntouched (off by default): an untouched release counts toward the route-up rule [C7,#2970].
  board.rerouteUntouched = releaseRerouteUntouched();
  // review.holdAfterTwoReleases (off by default): a second review release by one model family holds the item for the coordinator [C7,#10933].
  board.holdAfterTwoReleases = reviewHoldAfterTwoReleases();
  // claims.fileLease (off by default): live claims lease their predicted files, hub files excepted [C7,#8521].
  board.fileLease = ctx.config.claims?.fileLease === true ? { hubs: ctx.config.claims.fileLeaseHubs ?? [], quietThreshold: ctx.config.queue?.contentionThreshold ?? 1 } : null;
  // inbox.keepUntilActed (off by default): shouts record their kind and stay listed until an allowed action is recorded [C7,#8519].
  board.inboxKeep = ctx.config.inbox?.keepUntilActed === true;
  return withOpenedBoard(ctx, work, board);
}

/** Render only declared actor positions in a refusal, preserving user text and stable JSON ids. */
function agentRefusalText(message, code, name) {
  const patterns = {
    ALREADY_JOINED: /^(\[ALREADY_JOINED\] this worktree is )(\S+)( in )/,
    HELD: /^(\[HELD\] item #\d+ is held by )(\S+)( until )/,
    ITEM_HELD: /^(\[ITEM_HELD\] item #\d+ is held by )(\S+)(: )/,
    LANE_HELD: /^(\[LANE_HELD\] )(\S+)( holds the )/,
    REVIEW_HELD: /^(\[REVIEW_HELD\] )(\S+)( holds the )/,
    NOT_YOURS: /^(\[NOT_YOURS\] only the coordinator or )(\S+)(, who )/,
    NO_AGENT: /^(\[NO_AGENT\] no (?:registered )?agent )(\S+)(;|$)/,
    NOT_YOUR_CHECKOUT: /^(\[NOT_YOUR_CHECKOUT\] this checkout belongs to )(\S+)( in )/,
    FACT_JUDGEMENT: /^(\[FACT_JUDGEMENT\] only the item's live holder \()(\S+)(\))/,
    RELAY_PERSON_ONLY: /^(\[RELAY_PERSON_ONLY\] agent )(\S+)( cannot )/,
    SELF_SHOUT: /^(\[SELF_SHOUT\] a shout cannot be addressed to its sender )(\S+)(;)/,
    NO_READER: /^(\[NO_READER\] nobody reads ")(.*?)(":)/,
  };
  if (code === 'RELAY_SENDER_MISMATCH') {
    return message.replace(/^(\[RELAY_SENDER_MISMATCH\] agent )(\S+)( cannot act as )(.*?)(; send this operation)/,
      (_, before, sender, middle, actor, after) => `${before}${name(sender)}${middle}${actor === '(no declared agent)' ? actor : name(actor)}${after}`);
  }
  if (code === 'NOT_YOUR_DECISION') {
    return message.replace(/^(\[NOT_YOUR_DECISION\] shout #\d+ is addressed to )(\S+)(, not your \S+ lane \(agent )(\S+)(\))$/,
      (_, before, to, middle, caller, after) => `${before}${name(to)}${middle}${name(caller)}${after}`);
  }
  return patterns[code] ? message.replace(patterns[code], (_, before, id, after) => `${before}${name(id)}${after}`) : message;
}

/** Build the Refused a command throws, so a command file needs no kernel import of its own [C7]. */
export function refusal(code, message) {
  return new Refused(code, message);
}

/** Only refusals with actor positions need the invocation's native board for display names. */
export function refusalNeedsBoard(error) {
  return ['ALREADY_JOINED', 'HELD', 'ITEM_HELD', 'LANE_HELD', 'REVIEW_HELD', 'NOT_YOURS', 'NOT_YOUR_DECISION', 'NO_AGENT', 'NOT_YOUR_CHECKOUT', 'FACT_JUDGEMENT', 'RELAY_PERSON_ONLY', 'RELAY_SENDER_MISMATCH', 'SELF_SHOUT', 'NO_READER'].includes(error.code);
}

/** Render the refusal body without its existing final footer; structured errors retain the message. */
export function displayedRefusal(io, error) {
  const message = io.guidance(error.message.replace(/\r?\nnext:[ \t]*[^\r\n]*\S[ \t]*(?:\r?\n)*$/u, ''));
  if (error.code === 'MODEL_REQUIRED') return message.replace(/; run pullboard .+$/u, '');
  if (!refusalNeedsBoard(error)) return message;
  try {
    const ctx = context(io);
    const agents = withBoard(ctx, (board) => store.listAgents(board));
    return agentRefusalText(message, error.code, (id) => agentDisplayName(agents, ctx.config, id));
  } catch { return message; }
}

/**
 * withBoard for a command that only reads: the board opens read-only, without the write lock, and a
 * read never migrates it (#1047). A board this code has not migrated is read as it is; only the next
 * command that writes upgrades it. Branch code keeps withBoard's schema guard, which never migrates
 * a shared board either. Work that writes after all (a first coordinator registration) runs again
 * through withBoard on a current board; SQLite refused the write, so nothing ran twice.
 *
 * @template T
 * @param {any} ctx
 * @param {(board: any) => T} work
 * @returns {T}
 */
export function withBoardRead(ctx, work) {
  const board = ctx.nativeBoard.openBoardForRead(ctx.file, ctx.clock);
  // Main repairs a drifted board on a write open, so a read there takes that path once (#5825).
  const write = board && !board.current && (!ctx.allowSchemaUpgrade || board.drifted);
  if (write) store.closeBoard(board);
  if (!board || write) return withBoard(ctx, work);
  try { return withBoard(ctx, work, board); }
  catch (error) {
    if (board.current && store.writeRefused(error)) return withBoard(ctx, work);
    if (!store.writeRefused(error) && !store.schemaMissing(error)) throw error;
    throw new Refused('BOARD_SCHEMA_BEHIND', 'this board was made by an older pullboard and a read never upgrades it');
  }
}
