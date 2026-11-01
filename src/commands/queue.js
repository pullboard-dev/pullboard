import { localDependencyIds } from '../item-dependencies.js';
import { dependencyLabel } from '../item-dependencies.js';
import { itemFileCollisions } from '../item-files.js';
import { withLocalSeatPresence } from '../../packages/store/index.js';
import * as store from '../board.js';
import { roadmap } from '../board-milestones.js';
import { eligibilityProblem } from '../../packages/verify/index.js';
import { agentAt } from '../../packages/store/index.js';
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
    { buildOrder: store.buildOrder, canTake: store.canTake, listItems: store.listItems, itemById: store.itemById, laneHold: store.laneHold, milestonePriorities: store.milestonePriorities, milestones: store.milestones, roadmap: roadmap, ROUTES: store.ROUTES, foreignBlockers: store.foreignBlockers, localDependencyIds, dependencyLabel, itemFileCollisions, withLocalSeatPresence, eligibilityProblem },
    board => agentAt(board, ctx.info.root)?.agent_id ?? null, { policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family });
}
