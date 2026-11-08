/** Detached baseline measurements and durable completion receipts use the ordered board engine [V2,H16]. */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import * as store from '../../../../src/board.js';
import { checkBaseline } from './check-baseline.js';
import { runnerBaseline } from './check-baseline.js';
import { runnerBaselineCommand } from './check-baseline.js';
import { withGateSlot } from './gate-slot.js';
import { runnersRegistered } from './gate-slot.js';
import {
  codeIsFromMain,
  gitChildEnv,
  repoInfo,
} from '../../../../src/git.js';
import { mainCheckout } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import {
  relayLinked,
  relayOperation,
} from '../../../link/index.js';
import {
  BASELINE_RECEIPT,
  baselineReceiptDirectory,
} from '../../../store/index.js';
import { Refused } from '../../../kernel/index.js';

const WORKER = resolve(import.meta.dirname, '../../../../bin/check-baseline.js');

/** Resolve private completion storage beside this repository's shared board. */
function locations(root) {
  const info = repoInfo(root);
  return { board: join(info.commonDir, 'pullboard', 'board.sqlite'), receipts: baselineReceiptDirectory(info.commonDir) };
}

/** Close a real board around one short operation; measurements never hold a database connection. */
function withBoard(root, work, services) {
  const openBoard = services?.openBoard;
  if (typeof openBoard !== 'function') throw new TypeError('baseline completion requires its actual native board opener');
  const board = openBoard(locations(root).board, undefined, { isMain: codeIsFromMain() });
  try { return work(board); } finally { store.closeBoard(board); }
}

/** Apply captured data through the same local or linked engine as the original add/edit. */
async function complete(root, receipt, io, services) {
  const args = [receipt.id, { agentId: 'coordinator', expected: receipt.expected, baseline: receipt.baseline }];
  return relayLinked(root) ? relayOperation(root, 'completeCheckBaseline', args, io)
    : withBoard(root, (board) => store.completeCheckBaseline(board, ...args), services);
}

/** Persist a completed observation before attempting relay delivery; retries never rerun its shell. */
function saveReceipt(root, receipt) {
  const directory = locations(root).receipts;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${receipt.expected.request}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
  renameSync(temporary, file);
  return file;
}

/** Retry only finished observations, retaining a receipt if the relay cannot acknowledge it yet. */
export async function retryCheckBaselines(root, io, services) {
  const directory = locations(root).receipts;
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory).filter((name) => BASELINE_RECEIPT.test(name))) {
    const file = join(directory, name);
    try {
      const receipt = JSON.parse(readFileSync(file, 'utf8'));
      await complete(root, receipt, io, services);
      rmSync(file, { force: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue; // Another delivery may have removed this same receipt.
      io.err(`pullboard: baseline completion pending; retry with pullboard show (${error instanceof Refused ? error.code : 'BASELINE_RECEIPT'})`);
    }
  }
}

/** Start a detached child with independent streams so the caller exits while its check is running. */
export async function startCheckBaseline(root, id, baseline) {
  if (baseline?.result !== 'pending') return;
  const child = spawn(process.execPath, [WORKER, root, String(id), baseline.request], {
    cwd: root, env: gitChildEnv(root), detached: true, stdio: 'ignore',
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
}

/** Main's captured commit as a pinned runner source read from the object store, or null when it cannot be read. */
function mainSource(root, commit) {
  const tree = tryGit(root, ['rev-parse', '--verify', `${commit}^{tree}`], { env: gitChildEnv(root) });
  if (tree.status !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tree.stdout)) return null;
  return { commit, tree: tree.stdout, trunk: { ref: mainCheckout(root)?.branch ?? 'refs/heads/main', commit } };
}

/**
 * Measure the captured main's check. With a registered runner it runs there like any gate run, at main's exact commit
 * from the object store, and waits in the gate queue while none is free; only a machine with no runner runs it here, in
 * a temporary clone. Why: on 2 Nov ten baselines from one evening's edits ran on the coordinator Mac at load 107 [C7,#2520].
 *
 * @param {string} root
 * @param {number} id
 * @param {{ command: string, main: string }} expected
 * @param {{ gateExecutionServices?: () => Promise<{ runners: object, landing: object }> }} services
 */
async function measureBaseline(root, id, expected, services) {
  const executionServices = await services.gateExecutionServices?.();
  if (!executionServices) return checkBaseline(root, expected.command, { main: expected.main });
  if (!runnersRegistered(executionServices)) {
    // No runner exists: queue in this machine's gate queue (memory and slot admission) like any gate run, never start it unqueued.
    return withGateSlot(root, () => checkBaseline(root, expected.command, { main: expected.main }), { executionServices, remote: false,
      agent: 'coordinator', item: String(id), kind: 'check-baseline' });
  }
  const source = mainSource(root, expected.main);
  if (!source) return { command: expected.command, main: expected.main, result: 'unavailable', reason: 'the captured main commit could not be read for a runner' };
  return withGateSlot(root, async lease => {
    const started = Date.now();
    const command = runnerBaselineCommand(root, expected);
    const run = await lease.executionServices.runners.runOnRunnerAsync(root, command, { runner: lease.runner, source: lease.source,
      browser: lease.browser, metadata: lease.runMetadata });
    return runnerBaseline(expected, run, (Date.now() - started) / 1000);
  }, { executionServices, runnerOnly: true, remote: true,
    agent: 'coordinator', item: String(id), kind: 'check-baseline', pinnedSource: source });
}

/** Measure the captured main once, then seal its terminal result without overwriting a newer check. */
export async function runCheckBaselineWorker(root, id, request, services) {
  const expected = withBoard(root, (board) => store.getItem(board, id).item_check_baseline, services);
  if (expected?.result !== 'pending' || expected.request !== request) return;
  let baseline;
  try { baseline = await measureBaseline(root, id, expected, services); }
  catch { baseline = { command: expected.command, main: expected.main, result: 'unavailable', reason: 'background check could not run; set --check again from the coordinator' }; }
  const receipt = { id, expected, baseline };
  const file = saveReceipt(root, receipt);
  const io = {
    openBoard: services.openBoard, nativeBoardPorts: services.nativeBoardPorts,
    withOutboxGuard: services.withOutboxGuard,
    replayConflictRecord: services.replayConflictRecord,
    remoteBoardMissing: services.remoteBoardMissing,
    uncertainUploadFailure: services.uncertainUploadFailure,
    decideUncertainBaseline: services.decideUncertainBaseline,
    checkpointPublisher: services.checkpointPublisher,
    relayOrdering: services.relayOrdering,
    checkpointInBackground: services.checkpointInBackground,
    scheduleCheckpoint: services.scheduleCheckpoint,
    requestCheckpointCheck: services.requestCheckpointCheck, checkpointWorker: services.checkpointWorker,
    outboxPolicy: services.outboxPolicy, outboxFields: services.outboxFields, flushOutbox: services.flushOutbox, queueMove: services.queueMove, outboxHasPendingCreatedItem: services.outboxHasPendingCreatedItem,
    /** Discard normal relay prose in the detached worker. */
    say() {},
    /** Retain delivery failures in the receipt rather than an abandoned terminal stream. */
    err() {},
    stderr: {
      /** The worker cannot ask for an interactive sign-in; its receipt remains retryable. */
      write() {},
    },
  };
  try {
    await complete(root, receipt, io, services);
    rmSync(file, { force: true });
  } catch { /* The next CLI command retries the durable captured result. */ }
}
