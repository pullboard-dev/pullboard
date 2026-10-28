#!/usr/bin/env node
/** Private finite worker: no actor argument, credentials, host override or inherited admission [C7,V4]. */
import { selectAffectedTests } from '../src/affected-tests.js';
import { selectTestTreeGuards } from '../src/affected-tests.js';
import { runnerExecutionServices } from '../src/runners.js';
import { landingExecutionServices } from '../src/landing-shards.js';
import { isAbsolute } from 'node:path';
import { runSourceAdvances } from '../src/source-advance-worker.js';
import { context } from '../src/cli.js';
import { ordered } from '../src/cli.js';
import { withBoard } from '../src/cli.js';
import { runSubmitGate } from '../src/gate.js';
import { withFileLock } from '../src/relay-outbox-guard.js';
import { readMainAudit } from '../src/main-audit-state.js';
import { saveMainAudit } from '../src/main-audit-state.js';
import { landingLeaseState } from '../src/landing-lease.js';
const [root, token, ...extra] = process.argv.slice(2);
if (extra.length || typeof root !== 'string' || !isAbsolute(root)
  || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(token ?? '')) throw new Error('source-advance requires an explicit root and UUID');
// These source changes require real reruns; a reused result cannot become fresh source-advance evidence.
process.env.PULLBOARD_TEST_REUSE = '0';
await runSourceAdvances(root, token, {
  selectors: { selectAffectedTests, selectTestTreeGuards },
  executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, context, ordered, withBoard, runSubmitGate, withFileLock, readMainAudit, saveMainAudit, landingLeaseState,
});
