#!/usr/bin/env node
import * as nativeBoard from '../apps/lib/index.js';
const { openBoardForRead } = nativeBoard;
import { runnerExecutionServices } from '../packages/runners/index.js';
import { landingExecutionServices } from '../packages/landing/index.js';
import { flakeLedger } from '../packages/flakes/index.js';
import { eventCauses } from '../src/board-rigor.js';
/** Independent scheduled/manual main audit; no foreground lease or identity is borrowed [C7]. */
import { context } from '../apps/cli/index.js';
import { ordered } from '../apps/cli/index.js';
import { withBoard } from '../apps/cli/index.js';
import { runMainAudits } from '../packages/gate/index.js';
import { mainAuditDirectory } from '../packages/gate/index.js';
import { waitMainAudit } from '../packages/gate/index.js';
import {
  toolingIsPinned,
  warmAcceptedCells,
  recordAcceptedCellsFailure,
} from '../packages/gate/index.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withMainCheckout } from '../packages/landing/index.js';
import { withFileLock } from '../packages/outbox/index.js';
import { repoInfo } from '../src/git.js';
import { isAbsolute } from 'node:path';
import { cellsBacklogCollector } from './cells-audit-backlog.js';

const [root, token, ...args] = process.argv.slice(2);
const scheduled = args[0] === '--scheduled';
const forceFull = args[0] === '--release';
const cellsOnly = args[0] === '--cells-only' && args.length === 2 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(args[1]);
const wakeAt = scheduled && args[1] === '--wake-at' && args.length === 3 ? args[2] : null;

if ((args.length && !(args.length === 1 && (scheduled || forceFull)) && !wakeAt && !cellsOnly)
  || typeof root !== 'string' || !isAbsolute(root) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(token ?? '')) {
  throw new Error('main-audit requires an explicit root and native UUID token, optionally --scheduled or --release');
}
/**
 * Produce the accepted inventory with the pinned commit's own tooling. When this process runs another snapshot of the
 * tooling (the seat that nudged it), re-run this entry from a checkout of the pinned commit, so the recorded checker and
 * preload fingerprints are the pinned main's whichever seat started the producer.
 */
async function produceCells(commit) {
  if (toolingIsPinned(root, commit)) return warmAcceptedCells(root, commit, { withCheckout: withMainCheckout, withLock: withFileLock });
  if (process.env.PULLBOARD_CELLS_PINNED === commit) throw new Error('the pinned checkout did not carry the pinned tooling');
  const ran = await withMainCheckout(root, commit, checkout => spawnSync(process.execPath,
    [fileURLToPath(new URL('bin/main-audit.js', `file://${checkout}/`)), root, token, '--cells-only', commit],
    { cwd: checkout, env: { ...process.env, PULLBOARD_CELLS_PINNED: commit }, stdio: 'inherit' }));
  if (ran?.unavailable || ran?.status !== 0) throw new Error(ran?.unavailable ?? 'accepted cells producer failed in the pinned checkout');
  return ran;
}

if (cellsOnly) {
  try { await produceCells(args[1]); }
  catch (error) { try { recordAcceptedCellsFailure(root, args[1], error); } catch { /* Preserve the producer failure. */ } throw error; }
} else if (!wakeAt || await waitMainAudit(mainAuditDirectory(repoInfo(root)), token, wakeAt)) {
  await runMainAudits(root, token, { scheduled, forceFull }, { workerUrl: new URL(import.meta.url), nativeBoard, openBoardForRead, executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, context, ordered, withBoard, testValue: { flakeLedger, eventCauses }, cellsBacklog: cellsBacklogCollector(root) });
}
