/** The pullboard why command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import {
  decisionsImplying,
  whyLine,
} from '../../../../../packages/state/index.js';
import { whyFile } from '../../../../../packages/commits/index.js';
import { releaseFlow } from '../../../../../packages/health/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  context,
  idArg,
  withBoard,
  withBoardRead,
} from '../entry.js';

/** Run `pullboard why` and return its exit code. */
export function run(io, { first, second, rest }) {
  if (second || rest.length) throw new Refused('USAGE', 'pullboard why [<release>] | <id> | <file>[:<line>]: the release flow, the decisions that imply an item, or those behind a file');
  const ctx = context(io);
  if (!first) return runFlow(io, ctx, undefined);
  if (!/^#?[1-9]\d*$/u.test(first)) {
    const release = withBoardRead(ctx, (board) => store.milestones(board).some((entry) => entry.name === first));
    return release ? runFlow(io, ctx, first) : runFile(io, ctx, first);
  }
  const id = idArg(first);
  const decisions = withBoard(ctx, (board) => decisionsImplying(store.itemThread(board, id)));
  io.result?.({ id, decisions });
  if (!decisions.length) io.say(`no decision implies #${id}`);
  for (const entry of decisions) io.say(whyLine(entry));
  return 0;
}

/** Print the release flow on one screen: a line per unlanded item, per idle seat, and the landings [N26,C7]. */
function runFlow(io, ctx, release) {
  const refuse = (code, message) => new Refused(code, message, 'pullboard roadmap');
  const flow = withBoardRead(ctx, (board) => releaseFlow(board, { config: ctx.config, release, now: () => ctx.clock.now().getTime(), refuse }));
  io.result?.(flow);
  io.say(`release ${flow.release ?? 'none'} as of ${flow.asOf}`);
  if (!flow.items.length) io.say('nothing unlanded');
  for (const row of flow.items) {
    const who = row.seat ? ` ${row.seat}` : '';
    const detail = row.reason ?? row.waits?.join(' ') ?? (row.batch ? `batch ${row.batch}` : row.eligible?.join(' ') ?? '');
    const minutes = typeof row.minutes === 'number' ? ` ${row.minutes}m` : '';
    io.say(`#${row.id}  ${row.cause}${who}${minutes}${detail ? `  ${detail}` : ''}  ${row.title}`);
  }
  for (const seat of flow.idle) io.say(`idle ${seat.seat}  ${seat.reason}${seat.item ? ` #${seat.item}` : ''}`);
  io.say(`landed: ${flow.landings.lastHour} in the last hour, ${flow.landings.lastTwoHours} in two hours`);
  return 0;
}

/** Print the items, rows and decisions behind a file or line, each decision with its origin [N29]. */
function runFile(io, ctx, target) {
  const found = withBoard(ctx, (board) => whyFile(board, ctx.info.root, target));
  io.result?.(found);
  const where = found.line === null ? found.file : `${found.file}:${found.line}`;
  if (!found.items.length) io.say(`no landed commit that names an item touched ${where}`);
  for (const item of found.items) io.say(`item #${item.id} (${item.status}) [${item.origin}]: ${item.title}`);
  for (const row of found.rows) io.say(`row ${row.id} [${row.origin}], served by ${row.items.map((id) => `#${id}`).join(', ')}`);
  for (const entry of found.decisions) {
    const relay = entry.relayedBy ? `, relayed by ${entry.relayedBy}` : '';
    io.say(`decision #${entry.id} [${entry.origin}] by ${entry.decidedBy}${relay}: ${entry.statement.split('\n')[0]}${entry.rationale ? `  (because ${entry.rationale})` : ''}`);
  }
  return 0;
}
