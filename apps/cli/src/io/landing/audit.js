#!/usr/bin/env node
import * as nativeBoard from '../../../../lib/index.js';
const { openBoardForRead, acceptedCellsPorts } = nativeBoard;
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../../packages/landing/index.js';
import { flakeLedger } from '../../../../../packages/flakes/index.js';
import { eventCauses } from '../../../../../packages/store/index.js';
/** Independent scheduled/manual main audit; no foreground lease or identity is borrowed [C7]. */
import { context } from '../../../index.js';
import { ordered } from '../../../index.js';
import { warmFixtureMemo } from '../../../index.js';
import { withBoard } from '../../../index.js';
import { runMainAudits } from '../../../../../packages/gate/index.js';
import { mainAuditDirectory } from '../../../../../packages/gate/index.js';
import { waitMainAudit } from '../../../../../packages/gate/index.js';
import {
  recordAcceptedCellsFailure,
} from '../../../../../packages/gate/index.js';
import { produceAcceptedCells } from '../../../../lib/index.js';
import { repoInfo } from '../../../../../packages/git/index.js';
import { isAbsolute } from 'node:path';
import { cellsBacklogCollector } from '../cells/backlog.js';
import { boardCommandBudgetCheck } from './budget.js';
import { environmentAdapter } from '../../../../../packages/env/index.js';

const [root, token, ...args] = process.argv.slice(2);
const scheduled = args[0] === '--scheduled';
const forceFull = args[0] === '--release';
const cellsOnly = args[0] === '--cells-only' && args.length === 2 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(args[1]);
const wakeAt = scheduled && args[1] === '--wake-at' && args.length === 3 ? args[2] : null;

if ((args.length && !(args.length === 1 && (scheduled || forceFull)) && !wakeAt && !cellsOnly)
  || typeof root !== 'string' || !isAbsolute(root) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(token ?? '')) {
  throw new Error('main-audit requires an explicit root and native UUID token, optionally --scheduled or --release');
}
if (cellsOnly) {
  try { await produceAcceptedCells(root, token, args[1]); }
  catch (error) { try { recordAcceptedCellsFailure(root, args[1], error); } catch { /* Preserve the producer failure. */ } throw error; }
  // A landing that changes the fixture analyzer warms the shared memo on a runner before gates need it (#4045).
  if (environmentAdapter().get('PULLBOARD_CELLS_PINNED') !== args[1]) await warmFixtureMemo(root, args[1], { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() } });
} else if (!wakeAt || await waitMainAudit(mainAuditDirectory(repoInfo(root)), token, wakeAt)) {
  await runMainAudits(root, token, { scheduled, forceFull }, { workerUrl: new URL(import.meta.url), nativeBoard, openBoardForRead, executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, context, ordered, withBoard, testValue: { flakeLedger, eventCauses }, cellsBacklog: cellsBacklogCollector(root, acceptedCellsPorts), commandBudget: boardCommandBudgetCheck(), commandBudgetOwnerPath: 'apps/cli/pullboard.js' });
}
