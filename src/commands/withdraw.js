import * as store from '../board.js';
/** The pullboard withdraw command, in its own module so an item adding another command never edits these lines. */
import * as roadmapView from '../roadmap.js';
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
    const result = await roadmapView.withdrawWithMilestones(ctx, board, me, item,
      [second, ...rest].filter(Boolean).join(' '), ordered, store);
    if (ctx.config.worktreeMaintenance?.enabled === true) {
      const { cleanupMaintenanceLifecycle } = await import('../worktree-maintenance-command.js');
      await cleanupMaintenanceLifecycle(ctx, me.id, { path: ctx.info.root, item, agent: me.id });
    }
    return result;
  });
}
