import * as store from '../board.js';
import { eligibilityProblem } from '../review-eligibility.js';
import { agentAt } from '../seats.js';
/** The pullboard queue command, in its own module so an item adding another command never edits these lines. */
import * as queueView from '../queue.js';
import {
  context,
  withBoard,
} from '../cli.js';

/** Run `pullboard queue` and return its exit code. */
export function run(io, { first, second, rest }) {
  const ctx = context(io);
  return queueView.queueCommand(io, [first, second, ...rest], (work) => withBoard(ctx, work),
    { buildOrder: store.buildOrder, canTake: store.canTake, listItems: store.listItems, milestonePriorities: store.milestonePriorities, milestones: store.milestones, roadmap: store.roadmap, ROUTES: store.ROUTES, foreignBlockers: store.foreignBlockers, eligibilityProblem },
    board => agentAt(board, ctx.info.root)?.agent_id ?? null, { policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family });
}
