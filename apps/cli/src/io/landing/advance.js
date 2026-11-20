#!/usr/bin/env node
/** Private finite worker: no actor argument, credentials, host override or inherited admission [C7,V4]. */
import * as nativeBoard from '../../../../lib/index.js';
const { openBoardForRead } = nativeBoard;
import { selectAffectedTests } from '../../../../../packages/gate/heavy.js';
import { selectTestTreeGuards } from '../../../../../packages/gate/heavy.js';
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../../packages/landing/index.js';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSourceAdvances } from '../../../../../packages/sandbox/index.js';
import { context } from '../../../index.js';
import { ordered } from '../../../index.js';
import { withBoard } from '../../../index.js';
import { runSubmitGate as gateRun } from '../../../../../packages/gate/heavy.js';
import { replayChangedTables } from '../../../../../packages/gate/heavy.js';
import { replayReport } from '../../../../../packages/moves/index.js';
import { boardFilePath } from '../../../../../packages/store/index.js';
import { repoInfo } from '../../../../../packages/git/index.js';
import { withFileLock } from '../../../../../packages/outbox/index.js';
import { readMainAudit } from '../../../../../packages/gate/heavy.js';
import { saveMainAudit } from '../../../../../packages/gate/heavy.js';
import { SETTLED_FILE } from '../../../../../packages/gate/heavy.js';
import { landingLeaseState } from '../../../../../packages/store/index.js';
import { openLandingJob } from '../../../../../packages/api/index.js';
import { takeLandingResource } from '../../../../../packages/landing/index.js';
import { environmentAdapter } from '../../../../../packages/env/index.js';

/** The gate with the move-table replay wired to this repository's board, so a changed table is checked against what the board recorded [C7,#8073]. */
const runSubmitGate = (dir, config, options) => gateRun(dir, config, { ...options,
  timedShell: fileURLToPath(new URL('../../../../runner/src/io/shell.js', import.meta.url)),
  tableReplay: ({ root: tree, changed }) => replayChangedTables(tree, { changed, replay: replayReport, boardFile: boardFilePath(repoInfo(root).commonDir) }) });

const [root, token, ...extra] = process.argv.slice(2);
if (extra.length || typeof root !== 'string' || !isAbsolute(root)
  || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(token ?? '')) throw new Error('source-advance requires an explicit root and UUID');
// These source changes require real reruns; a reused result cannot become fresh source-advance evidence.
environmentAdapter().set('PULLBOARD_TEST_REUSE', '0');
await runSourceAdvances(root, token, {
  nativeBoard, openBoardForRead, selectors: { selectAffectedTests, selectTestTreeGuards },
  executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, context, ordered, withBoard, runSubmitGate, withFileLock, readMainAudit, saveMainAudit, settledFile: SETTLED_FILE, landingLeaseState, openLandingJob, takeLandingResource,
});
