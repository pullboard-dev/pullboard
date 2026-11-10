/** The pullboard run command, in its own module so an item adding another command never edits these lines. */
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../../packages/landing/index.js';
import {
  runItems,
} from '../../../../../packages/runners/index.js';
import { scaleWorkers } from '../scale.js';
import { workerBudget } from '../../../../../packages/config/index.js';
import { worktreeFor } from './worktree.js';
import { removeScaledWorktree } from './worktree.js';
import {
  claimOrdered,
  context,
  freezer,
  nextOnce,
  ordered,
  whoAmI,
  withBoard,
} from '../entry.js';
import {
  submitHere,
} from './submit.js';

/** Run `pullboard run` and return its exit code. */
export function run(io, { values }) {
  if (values.scale) return scaleWorkers(io, values, { context, withBoard, worktreeFor, removeWorktree: removeScaledWorktree, workerBudget });
  return runItems(io, values, { context, withBoard, whoAmI, nextOnce, submitHere, freezer, ordered, claim: claimOrdered, executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() } });
}
