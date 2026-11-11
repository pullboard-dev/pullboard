import { Refused } from '../../../../../packages/kernel/index.js';
import * as store from '../../../../../packages/store/index.js';
import { dropWithdrawnHandoffTicket } from '../submit/handoff.js';
/** The pullboard withdraw command, in its own module so an item adding another command never edits these lines. */
import * as roadmapView from '../../../../../packages/roadmap/index.js';
import { listApiProjects } from '../../../../../packages/seats/index.js';
import {
  actOn,
  idArg,
  ordered,
} from '../entry.js';

/** Run `pullboard withdraw <id> <reason>` and return its exit code; `--note` is accepted as the reason so the flag people reach for works [C7]. */
export function run(io, { first, second, rest, values = {} }) {
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
    const item = idArg(first);
    const previous = ctx.config.worktreeMaintenance?.enabled === true ? store.getItem(board, item) : null;
    const previousOwner = previous?.item_owner ?? previous?.item_built_by;
    const owner = previousOwner ? store.agentById(board, previousOwner) : null;
    const reason = [second, ...rest].filter(Boolean).join(' ') || (typeof values.note === 'string' ? values.note.trim() : '');
    // The shared NOTE_REQUIRED hint names --note; withdraw's own form is positional, so say that here (#3267).
    if (!reason) throw new Refused('NOTE_REQUIRED', `withdraw needs a reason: pullboard withdraw ${item} "<reason>" (--note "<reason>" works too)`);
    // A queued or running hand-off ends with the withdrawal; its place in line goes too, so the dispatcher never starts it (#3366).
    const handoff = store.submitHandoff(board, item);
    const result = await roadmapView.withdrawWithMilestones(ctx, board, me, item, reason, ordered, { ...store, listApiProjects });
    dropWithdrawnHandoffTicket(handoff);
    if (owner && ctx.config.worktreeMaintenance?.enabled === true) {
      const { cleanupMaintenanceLifecycle } = await import('../worktree/maintenance/command.js');
      await cleanupMaintenanceLifecycle(ctx, me.id, { path: owner.agent_path, item, agent: owner.agent_id, withdrawn: true, completedWithdrawal: true });
    }
    return result;
  });
}
