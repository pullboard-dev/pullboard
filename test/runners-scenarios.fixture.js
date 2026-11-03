/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
import {
  executionServicesSource,
} from './gate-execution-fixture.js';
import {
  runnerRecoveryTests,
} from './runner-recovery-fixture.js';
import {
  copyPackageFiles,
} from '../src/package-files.js';
import {
  copyCommittedPackageFiles,
} from './package-copy-fixture.js';
import {
  runnerPackage,
} from '../src/runner-package.js';
import {
  packageFiles,
} from '../src/package-files.js';
import assert from 'node:assert/strict';
import { PAIRED_RERUN_FIXTURE } from './runner-paired-tools.fixture.js';
import { observe } from './runner-paired-tools.fixture.js';
import { processesUnder } from './runner-paired-tools.fixture.js';
import {
  installWorkerGitWitness,
} from './worker-git-witness.fixture.js';
import {
  assertWorkerTagBatches,
} from './worker-git-count-assertions.js';
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  spawn,
} from 'node:child_process';
import {
  once,
} from 'node:events';
import {
  DatabaseSync,
} from 'node:sqlite';
import {
  tmpdir,
} from 'node:os';
import {
  pathToFileURL,
} from 'node:url';
import {
  after,
  test,
} from 'node:test';
import {
  gateSlotEnvironment,
  listResources,
  setResourceCapacity,
  takeResource,
} from '../packages/resources/index.js';
import {
  parseProcessCensus,
} from '../packages/kernel/src/core/process-census.js';
import {
  listResources as listPreRunnerResources,
  takeResource as takePreRunnerResource,
} from './fixtures/resources-pre-runners.js';
import {
  cleanupFixtureChildren,
  runFixtureChild,
  runFixtureChildAsync,
  startFixtureChild,
} from './fixture-child.js';
import {
  readRemoteGateHolders,
  waitForCondition,
} from './runner-fixture-state.js';
import {
  runPairedRerun,
} from './runner-paired-rerun-fixture.js';
import {
  stopGroup,
} from './runner-process-group.js';
import {
  parentDeathDrainFixture,
} from './runner-parent-death-fixture.js';
import {
  runnerOrphanFixture,
  unprovenProcessFixture,
} from './runner-orphan-fixture.js';
import {
  createDescendantTracker,
} from '../apps/runner/index.js';
import {
  createE2eHelpers,
} from './e2e-helpers.js';
import {
  refuseSandboxBlocked,
} from '../packages/gate/index.js';
import {
  fixtureContextCpuCase,
} from './runner-cpu-classification-fixture.js';
import {
  guiCpuPolicyCase,
} from './runner-cpu-classification-fixture.js';
import {
  SECRET,
  HOST,
  shellQuote,
  installSshStandIn,
} from './runner-ssh-fixture.js';
import {
  sourceSetupFailureFixture,
} from './runner-source-setup-fixture.js';
import {
  runnerSourceRefusalCases,
} from './runner-source-refusal-fixture.js';
import {
  writeCacheProbe,
  writeProbe,
} from './runner-probe-fixture.js';
import {
  browserFreeRunnerCheck,
  browserRefusalTextStaysRed,
} from './runner-browser-free-fixture.js';
import {
  runnerTimingReceipt,
  runnerUsesRegisteredCapacity,
} from './runner-capacity-fixture.js';
import {
  runnerFirstPolicyCase,
} from './runner-first-fixture.js';
import {
  removingBusyRunnerDrains,
  runnerRemoveKeepsSettings,
} from './runner-drain-fixture.js';
import {
  awaitRoundTrip,
  cleanupToolingSnapshots,
  cli,
  committedToolingSnapshot,
  fixtureResultContext,
  gateResult,
  git,
  phaseCounts,
  ROUND_TRIP_DEADLINES,
  runThroughGate,
  startToolingCli,
  TOOLING_SNAPSHOTS,
} from './runner-tooling-fixture.js';
import {
  runnerStageFixture,
} from './runner-stage-fixture.js';
import {
  privateReviewRunnerCase,
  privateReviewRunnerEdges,
} from './runner-private-check-fixture.js';



const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const TEMP = [];
const e2e = createE2eHelpers();
after(e2e.cleanup);
after(cleanupFixtureChildren);
after(cleanupToolingSnapshots);

/** Wait for the marker itself: a missed file notification must not hide observable readiness. */
async function waitForMarker(path) {
  const deadline = Date.now() + 20_000; // budget: unchanged hang ceiling for the queue-to-parent handoff.
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`fixture marker did not arrive: ${path}`);
    await new Promise(resolve => setTimeout(resolve, 20)); // budget: polling interval for the actual readiness marker.
  }
}

/** Check exact PID presence without signalling or treating permission denial as absence. */
function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

/** Start an API child that requeues only an incomplete runner transport on its original ticket. */
function startQueueController(repo, env, command, { item, queueMarker, firstItem = 'retry-first', remote = true, browser = true, toolingRoot = resolve(import.meta.dirname, '..') } = {}) {
  const sourceRoot = realpathSync(toolingRoot);
  const gateUrl = pathToFileURL(join(committedToolingSnapshot(sourceRoot, env), 'src', 'gate.js')).href;
  const snapshot = TOOLING_SNAPSHOTS.get(sourceRoot);
  snapshot.active++;
  const script = `import { writeFileSync } from 'node:fs';
const { runProfiledShell, withGateSlot } = await import(${JSON.stringify(gateUrl)});
${executionServicesSource(gateUrl)}
const root = ${JSON.stringify(repo)};
const command = ${JSON.stringify(command)};
const queueMarker = ${JSON.stringify(queueMarker)};
const firstItem = ${JSON.stringify(firstItem)};
const result = await withGateSlot(root, async lease => {
  const run = await runProfiledShell(root, command, { gateLease: lease });
  process.stdout.write(run.output);
  process.stdout.write('PULLBOARD_RUN_RESULT ' + JSON.stringify({ isGreen: run.isGreen, runner: run.profile.executionRunner }) + '\\n');
  return run;
},
  { executionServices, browser: ${browser}, remote: ${remote}, item: ${JSON.stringify(item)}, kind: 'runner-retry-test', agent: ${JSON.stringify(item)},
  onWait(state) {
    const rows = state.line ?? [];
    if (queueMarker && rows.some(row => row.item === ${JSON.stringify(item)}) && (firstItem === null || rows.some(row => row.item === firstItem))) {
      writeFileSync(${JSON.stringify(queueMarker)}, 'both retry tickets are queued\\n');
    }
  }
});
process.exitCode = result.isGreen ? 0 : 1;
`;
  try {
    const child = startFixtureChild(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const finish = (status, signal, failed) => {
      if (settled) return;
      settled = true;
      snapshot.active--;
      if (failed || status !== 0 || signal) snapshot.retained = true;
    };
    child.once('close', (status, signal) => finish(status, signal, false));
    child.once('error', () => finish(null, null, true));
    return child;
  } catch (error) {
    snapshot.active--;
    snapshot.retained = true;
    throw error;
  }
}

/** Observe a running fixture child without hiding stdout, stderr, or its exit status. */











/** List live processes whose command line mentions a fixture directory. */







/** Run one action with the process's machine home pointed at another fixture machine. */
function onMachine(machineHome, action) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  try { return action(); }
  finally {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
  }
}




const parentDeathTools = { cli, git, installSshStandIn, observe, startQueueController, waitForMarker, processIsAlive, shellQuote, HOST };





const orphanTools = { cli, git, installSshStandIn, observe, startToolingCli, processIsAlive, HOST };













/** Original shared fixture bindings; no test registration is hidden in this module. */
export {
  BIN,
  DatabaseSync,
  HOST,
  PAIRED_RERUN_FIXTURE,
  SECRET,
  TEMP,
  after,
  assert,
  assertWorkerTagBatches,
  awaitRoundTrip,
  browserFreeRunnerCheck,
  browserRefusalTextStaysRed,
  cli,
  committedToolingSnapshot,
  copyCommittedPackageFiles,
  copyPackageFiles,
  createDescendantTracker,
  createE2eHelpers,
  dirname,
  e2e,
  existsSync,
  fixtureContextCpuCase,
  fixtureResultContext,
  gateResult,
  gateSlotEnvironment,
  git,
  guiCpuPolicyCase,
  installSshStandIn,
  installWorkerGitWitness,
  join,
  listPreRunnerResources,
  listResources,
  mkdirSync,
  mkdtempSync,
  observe,
  onMachine,
  orphanTools,
  packageFiles,
  parentDeathDrainFixture,
  parentDeathTools,
  parseProcessCensus,
  pathToFileURL,
  phaseCounts,
  privateReviewRunnerCase,
  privateReviewRunnerEdges,
  processesUnder,
  readFileSync,
  readRemoteGateHolders,
  realpathSync,
  refuseSandboxBlocked,
  relative,
  removingBusyRunnerDrains,
  resolve,
  rmSync,
  runFixtureChild,
  runPairedRerun,
  runThroughGate,
  runnerFirstPolicyCase,
  runnerOrphanFixture,
  runnerPackage,
  runnerRecoveryTests,
  runnerRemoveKeepsSettings,
  runnerSourceRefusalCases,
  runnerStageFixture,
  runnerTimingReceipt,
  runnerUsesRegisteredCapacity,
  sep,
  shellQuote,
  sourceSetupFailureFixture,
  startFixtureChild,
  startQueueController,
  startToolingCli,
  takePreRunnerResource,
  takeResource,
  test,
  tmpdir,
  unprovenProcessFixture,
  waitForCondition,
  waitForMarker,
  writeCacheProbe,
  writeFileSync,
  writeProbe,
};
