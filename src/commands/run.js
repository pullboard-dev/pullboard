/** The pullboard run command, in its own module so an item adding another command never edits these lines. */
import { runnerExecutionServices } from '../runners.js';
import { landingExecutionServices } from '../landing-shards.js';
import {
  runItems,
} from '../run.js';
import { scaleWorkers } from '../worker-scale.js';
import { workerBudget } from '../settings.js';
import { worktreeFor } from './worktree.js';
import {
  claimOrdered,
  context,
  freezer,
  nextOnce,
  ordered,
  whoAmI,
  withBoard,
} from '../cli.js';
import {
  submitHere,
} from './submit.js';

/** Run `pullboard run` and return its exit code. */
export function run(io, { values }) {
  if (values.scale) return scaleWorkers(io, values, { context, withBoard, worktreeFor, workerBudget });
  return runItems(io, values, { context, withBoard, whoAmI, nextOnce, submitHere, freezer, ordered, claim: claimOrdered, executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() } });
}
