import { localDependencyIds } from '../../../../../packages/items/index.js';
import { dependencyLabel } from '../../../../../packages/items/index.js';
import { itemFileCollisions } from '../../../../../packages/items/index.js';
import { withLocalSeatPresence } from '../../../../../packages/store/index.js';
import * as store from '../../../../../packages/store/index.js';
import { roadmap } from '../../../../../packages/store/index.js';
import { eligibilityProblem } from '../../../../../packages/verify/index.js';
import { seatAt } from '../item/folder/identity.js';
/** The pullboard queue command, in its own module so an item adding another command never edits these lines. */
import * as queueView from '../../../../../packages/items/index.js';
import {
  context,
  withBoard,
} from '../entry.js';

/** Run `pullboard queue` and return its exit code. */
export function run(io, { first, second, rest }) {
  const ctx = context(io);
  return queueView.queueCommand(io, [first, second, ...rest], (work) => withBoard(ctx, work),
    { buildOrder: store.buildOrder, canTake: store.canTake, listItems: store.listItems, itemById: store.itemById, laneHold: store.laneHold, milestonePriorities: store.milestonePriorities, milestones: store.milestones, roadmap: roadmap, ROUTES: store.ROUTES, foreignBlockers: store.foreignBlockers, localDependencyIds, dependencyLabel, itemFileCollisions, withLocalSeatPresence, eligibilityProblem },
    board => seatAt(board, ctx.info.root)?.agent_id ?? null, { policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family });
}
