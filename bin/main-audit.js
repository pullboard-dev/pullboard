#!/usr/bin/env node
import * as nativeBoard from '../src/native-board.js';
const { openBoardForRead } = nativeBoard;
import { runnerExecutionServices } from '../src/runners.js';
import { landingExecutionServices } from '../packages/landing/index.js';
import { flakeLedger } from '../packages/flakes/index.js';
import { eventCauses } from '../src/board-rigor.js';
/** Independent scheduled/manual main audit; no foreground lease or identity is borrowed [C7]. */
import { context } from '../src/cli.js';
import { ordered } from '../src/cli.js';
import { withBoard } from '../src/cli.js';
import { runMainAudits } from '../packages/gate/index.js';
import { mainAuditDirectory } from '../packages/gate/index.js';
import { waitMainAudit } from '../packages/gate/index.js';
import { repoInfo } from '../src/git.js';
import { isAbsolute } from 'node:path';

const [root, token, ...args] = process.argv.slice(2);
const scheduled = args[0] === '--scheduled';
const forceFull = args[0] === '--release';
const wakeAt = scheduled && args[1] === '--wake-at' && args.length === 3 ? args[2] : null;
if ((args.length && !(args.length === 1 && (scheduled || forceFull)) && !wakeAt)
  || typeof root !== 'string' || !isAbsolute(root) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(token ?? '')) {
  throw new Error('main-audit requires an explicit root and native UUID token, optionally --scheduled or --release');
}
if (!wakeAt || await waitMainAudit(mainAuditDirectory(repoInfo(root)), token, wakeAt)) {
  await runMainAudits(root, token, { scheduled, forceFull }, { workerUrl: new URL(import.meta.url), nativeBoard, openBoardForRead, executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, context, ordered, withBoard, testValue: { flakeLedger, eventCauses } });
}
