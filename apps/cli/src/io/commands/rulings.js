/** The pullboard rulings command, in its own module so an item adding another command never edits these lines [C7,#1444]. */
import * as store from "../../../../../packages/store/index.js";
import {
  agentDisplayName,
  context,
  span,
  withBoardRead,
} from "../entry.js";

/**
 * Run `pullboard rulings <key>` and return its exit code: every answer recorded under that cause, newest first, each
 * with its shout id and text. A key outside the typed cause list is refused RULING_CAUSE naming the valid keys.
 */
export function run(io, { first }) {
  const ctx = context(io);
  const { rulings, agents } = withBoardRead(ctx, (board) => ({ rulings: store.rulingsByCause(board, first), agents: store.listAgents(board) }));
  io.result?.({ cause: first, rulings });
  if (!rulings.length) io.say(`no rulings recorded under ${first}`);
  for (const ruling of rulings) io.say(`#${ruling.shout}  ${agentDisplayName(agents, ctx.config, ruling.answerer)}, ${span(ctx, ruling.at)} ago: ${ruling.text}`);
  return 0;
}
