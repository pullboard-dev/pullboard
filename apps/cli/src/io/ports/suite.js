/** The real capabilities behind the post-land suite: the machine setting, the runner suite, board reads and Main red ownership [C7,H16]. */
import { join } from 'node:path';
import { git } from '../../../../../packages/git/index.js';
import { laneOf } from '../../../../../packages/seats/index.js';
import { listItems } from '../../../../../packages/store/index.js';
import { unownedMainReds } from '../../../../../packages/store/index.js';
import { postLandSuiteEnabled } from '../../../../../packages/config/index.js';
import { runFullSuite } from '../../../../../packages/gate/index.js';
import { POST_LAND_SUITE_FILE } from '../../../../../packages/landing/index.js';
import { failureSignatures } from '../../../../../packages/landing/index.js';
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../../packages/landing/index.js';

/** The previous batch's result lives beside the board's other private Git state, never in the tracked tree. */
function storePath(root) {
  return join(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(), 'pullboard', POST_LAND_SUITE_FILE);
}

/** Run the project's full suite on the runners at the landed tree; null failures means a red the signatures cannot account for. */
async function runSuite(root) {
  const run = await runFullSuite(root, join(root, 'apps/cli/src/io/run/tests.js'),
    { runners: runnerExecutionServices(), landing: landingExecutionServices() });
  if (!run) return { unavailable: 'this project has no full-suite runner the post-land run can use' };
  if (run.isGreen) return { green: true, failures: [] };
  const failures = failureSignatures(run, run.executionRoot ?? root, { raw: true, evidence: true });
  return failures ? { green: false, failures } : { green: false, failures: null };
}

/** The ports a landing passes to postLandSuite. */
export function postLandSuitePorts() {
  return Object.freeze({ enabled: postLandSuiteEnabled, runSuite, storePath, laneOf, unownedMainReds,
    readItems: board => listItems(board, { all: true }) });
}

/** The runner services the board resident's idle-runner probe runs through [C7,#8325]. */
export function idleRunnerServices() {
  return { runners: runnerExecutionServices() };
}
