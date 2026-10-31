import * as store from '../board.js';
/** The pullboard withdraw command, in its own module so an item adding another command never edits these lines. */
import * as roadmapView from '../../packages/roadmap/index.js';
import {
  actOn,
  idArg,
  ordered,
} from '../cli.js';

/** Run `pullboard withdraw` and return its exit code. */
export function run(io, { first, second, rest }) {
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
    const item = idArg(first);
    const previous = ctx.config.worktreeMaintenance?.enabled === true ? store.getItem(board, item) : null;
    const previousOwner = previous?.item_owner ?? previous?.item_built_by;
    const owner = previousOwner ? store.agentById(board, previousOwner) : null;
    const result = await roadmapView.withdrawWithMilestones(ctx, board, me, item,
      [second, ...rest].filter(Boolean).join(' '), ordered, store);
    if (owner && ctx.config.worktreeMaintenance?.enabled === true) {
      const { cleanupMaintenanceLifecycle } = await import('../worktree-maintenance-command.js');
      await cleanupMaintenanceLifecycle(ctx, me.id, { path: owner.agent_path, item, agent: owner.agent_id, withdrawn: true, completedWithdrawal: true });
    }
    return result;
  });
}
