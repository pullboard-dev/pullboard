/** The synchronous write-board lifecycle and compatible public CLI context exports [C7]. */
import * as store from './native-board.js';
import { Refused } from './refused.js';
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
} from './cli-read-context.js';
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
  const board = opened ?? store.openBoard(ctx.file, ctx.clock, { isMain: ctx.allowSchemaUpgrade,
    gitRoot: ctx.info.root,
    writeContext: { command: ctx.io.relayCommand?.cliOperation, path: ctx.info.root, ...(ctx.info.isMain ? { seat: 'coordinator' } : {}) },
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

/** Render the refusal body without its existing final footer; structured errors retain the message. */
export function displayedRefusal(io, error) {
  const message = io.guidance(error.message.replace(/\r?\nnext:[ \t]*[^\r\n]*\S[ \t]*(?:\r?\n)*$/u, ''));
  if (error.code === 'MODEL_REQUIRED') return message.replace(/; run pullboard .+$/u, '');
  if (!['ALREADY_JOINED', 'HELD', 'ITEM_HELD', 'LANE_HELD', 'REVIEW_HELD', 'NOT_YOURS', 'NOT_YOUR_DECISION', 'NO_AGENT', 'NOT_YOUR_CHECKOUT', 'FACT_JUDGEMENT', 'RELAY_PERSON_ONLY', 'RELAY_SENDER_MISMATCH', 'SELF_SHOUT', 'NO_READER'].includes(error.code)) return message;
  try {
    const ctx = context(io);
    const agents = withBoard(ctx, (board) => store.listAgents(board));
    return agentRefusalText(message, error.code, (id) => agentDisplayName(agents, ctx.config, id));
  } catch { return message; }
}
