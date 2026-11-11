/** The pullboard agents command, in its own module so an item adding another command never edits these lines. */
import {
  agentTree,
  agentsReport,
} from '../../../../../packages/seats/index.js';
import {
  boardId,
  listAgents,
  listItems,
} from '../../../../../packages/store/index.js';
import {
  context,
  withBoard,
} from '../entry.js';

/** Run `pullboard agents` and return its exit code. */
export function run(io, { values = {} } = {}) {
  const ctx = context(io);
  return agentsReport(io, withBoard(ctx, (board) => agentTree(ctx.info, ctx.config, board, { listAgents, boardId, listItems })), { detail: values.detail });
}
