import { Refused } from '../../../../../packages/kernel/index.js';
import * as store from '../../../../../packages/store/index.js';
import { pendingText } from '../item/withdraw-review.js';
import { pendingWithdrawal } from '../item/withdraw-review.js';
import { rejectedText } from '../item/withdraw-review.js';
import { refuseLandedWithdraw } from '../item/withdraw-landed.js';
import { withdrawCancelsJob } from '../../../../../packages/config/index.js';
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
    let reason = [second, ...rest].filter(Boolean).join(' ') || (typeof values.note === 'string' ? values.note.trim() : '');
    // withdraw.refuseLanded: an item whose commit is on main is landed, never withdrawn [C7].
    refuseLandedWithdraw(ctx.config, ctx.info.root, store.getItem(board, item), roadmapView);
    const pending = pendingWithdrawal(board, item);
    if (values.confirm === true || values.reject === true) {
      // withdraw.review: only a seat other than the one that asked closes the item, or declines the request [C7].
      if (!pending) throw new Refused('NO_PENDING_WITHDRAWAL', `#${item} has no withdrawal waiting for confirmation`, `pullboard withdraw ${item} "<reason>"`);
      if (pending.by === me.id) throw new Refused('WITHDRAW_SAME_SEAT', `${me.id} asked to withdraw #${item}; another seat must confirm it`, `ask another seat to run: pullboard withdraw ${item} --confirm`);
      if (values.reject === true) {
        await ordered(ctx, board, 'appendFact', [item, { agentId: me.id, kind: 'note', text: rejectedText(reason || pending.reason) }]);
        ctx.io.say(`rejected the withdrawal of #${item}; it stays open`);
        return 0;
      }
      reason = pending.reason;
    } else if (ctx.config.withdraw?.review === true && reason) {
      if (pending) throw new Refused('WITHDRAW_PENDING', `#${item} already has a withdrawal waiting for another seat to confirm it`, `ask another seat to run: pullboard withdraw ${item} --confirm`);
      await ordered(ctx, board, 'appendFact', [item, { agentId: me.id, kind: 'note', text: pendingText(reason) }]);
      ctx.io.say(`#${item} stays open until another seat confirms: pullboard withdraw ${item} --confirm`);
      return 0;
    }
    // The shared NOTE_REQUIRED hint names --note; withdraw's own form is positional, so say that here (#3267).
    if (!reason) throw new Refused('NOTE_REQUIRED', `withdraw needs a reason: pullboard withdraw ${item} "<reason>" (--note "<reason>" works too)`);
    const result = await roadmapView.withdrawWithMilestones(ctx, board, me, item, reason, ordered, { ...store, listApiProjects }, { endGateJobs: withdrawCancelsJob() });
    if (owner && ctx.config.worktreeMaintenance?.enabled === true) {
      const { cleanupMaintenanceLifecycle } = await import('../worktree/maintenance/command.js');
      await cleanupMaintenanceLifecycle(ctx, me.id, { path: owner.agent_path, item, agent: owner.agent_id, withdrawn: true, completedWithdrawal: true });
    }
    return result;
  });
}
