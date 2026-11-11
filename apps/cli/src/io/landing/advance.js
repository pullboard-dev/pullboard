#!/usr/bin/env node
/** Private finite worker: no actor argument, credentials, host override or inherited admission [C7,V4]. */
import * as nativeBoard from '../../../../lib/index.js';
const { openBoardForRead } = nativeBoard;
import { selectAffectedTests } from '../../../../../packages/gate/index.js';
import { selectTestTreeGuards } from '../../../../../packages/gate/index.js';
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../../packages/landing/index.js';
import { isAbsolute } from 'node:path';
import { runSourceAdvances } from '../../../../../packages/sandbox/index.js';
import { context } from '../../../index.js';
import { ordered } from '../../../index.js';
import { withBoard } from '../../../index.js';
import { runSubmitGate } from '../../../../../packages/gate/index.js';
import { withFileLock } from '../../../../../packages/outbox/index.js';
import { readMainAudit } from '../../../../../packages/gate/index.js';
import { saveMainAudit } from '../../../../../packages/gate/index.js';
import { landingLeaseState } from '../../../../../packages/store/index.js';
import { takeLandingResource } from '../../../../../packages/landing/index.js';

const [root, token, ...extra] = process.argv.slice(2);
if (extra.length || typeof root !== 'string' || !isAbsolute(root)
  || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(token ?? '')) throw new Error('source-advance requires an explicit root and UUID');
// These source changes require real reruns; a reused result cannot become fresh source-advance evidence.
process.env.PULLBOARD_TEST_REUSE = '0';
await runSourceAdvances(root, token, {
  nativeBoard, openBoardForRead, selectors: { selectAffectedTests, selectTestTreeGuards },
  executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, context, ordered, withBoard, runSubmitGate, withFileLock, readMainAudit, saveMainAudit, landingLeaseState, takeLandingResource,
});
