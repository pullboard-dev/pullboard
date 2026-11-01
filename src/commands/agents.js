/** The pullboard agents command, in its own module so an item adding another command never edits these lines. */
import {
  agentTree,
  agentsReport,
} from '../agent-tree.js';
import {
  boardId,
  listAgents,
  listItems,
} from '../../packages/store/index.js';
import {
  context,
  withBoard,
} from '../cli.js';

/** Run `pullboard agents` and return its exit code. */
export function run(io) {
  const ctx = context(io);
  return agentsReport(io, withBoard(ctx, (board) => agentTree(ctx.info, ctx.config, board, { listAgents, boardId, listItems })));
}
