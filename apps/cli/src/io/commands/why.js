/** The pullboard why command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import {
  decisionsImplying,
  whyLine,
} from '../../../../../packages/state/index.js';
import { whyFile } from '../../../../../packages/commits/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  context,
  idArg,
  withBoard,
} from '../entry.js';

/** Run `pullboard why` and return its exit code. */
export function run(io, { first, second, rest }) {
  if (!first || second || rest.length) throw new Refused('USAGE', 'pullboard why <id> | <file>[:<line>]: the decisions that imply an item, or sit behind a file, newest first');
  const ctx = context(io);
  if (!/^#?[1-9]\d*$/u.test(first)) return runFile(io, ctx, first);
  const id = idArg(first);
  const decisions = withBoard(ctx, (board) => decisionsImplying(store.itemThread(board, id)));
  io.result?.({ id, decisions });
  if (!decisions.length) io.say(`no decision implies #${id}`);
  for (const entry of decisions) io.say(whyLine(entry));
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
