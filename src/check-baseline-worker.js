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
import * as store from './board.js';
import { checkBaseline } from './check-baseline.js';
import {
  codeIsFromMain,
  gitChildEnv,
  repoInfo,
} from './git.js';
import {
  relayLinked,
  relayOperation,
} from './relay.js';
import {
  BASELINE_RECEIPT,
  baselineReceiptDirectory,
} from './local-state.js';
import { Refused } from './refused.js';

const WORKER = resolve(import.meta.dirname, '../bin/check-baseline.js');

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

/** Measure the captured main once, then seal its terminal result without overwriting a newer check. */
export async function runCheckBaselineWorker(root, id, request, services) {
  const expected = withBoard(root, (board) => store.getItem(board, id).item_check_baseline, services);
  if (expected?.result !== 'pending' || expected.request !== request) return;
  let baseline;
  try { baseline = checkBaseline(root, expected.command, { main: expected.main }); }
  catch { baseline = { command: expected.command, main: expected.main, result: 'unavailable', reason: 'background check could not run; set --check again from the coordinator' }; }
  const receipt = { id, expected, baseline };
  const file = saveReceipt(root, receipt);
  const io = {
    withOutboxGuard: services.withOutboxGuard,
    replayConflictRecord: services.replayConflictRecord,
    remoteBoardMissing: services.remoteBoardMissing,
    uncertainUploadFailure: services.uncertainUploadFailure,
    decideUncertainBaseline: services.decideUncertainBaseline,
    checkpointPublisher: services.checkpointPublisher,
    relayOrdering: services.relayOrdering,
    checkpointInBackground: services.checkpointInBackground,
    scheduleCheckpoint: services.scheduleCheckpoint,
    requestCheckpointCheck: services.requestCheckpointCheck,
    outboxPolicy: services.outboxPolicy, flushOutbox: services.flushOutbox, queueMove: services.queueMove, outboxHasPendingCreatedItem: services.outboxHasPendingCreatedItem,
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
