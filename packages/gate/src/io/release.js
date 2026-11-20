import { checkCoordinatorRelease } from './coordinator/release.js';
import { recordCoordinatorRelease } from './coordinator/release.js';
import { readCoordinatorRelease } from './coordinator/release.js';
/** A fresh release gate owns its execution; imported files can never create native release evidence [C7,I15]. */
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  join,
} from 'node:path';
import {
  runGate,
} from './main.js';
import {
  committedTree,
} from './main.js';
import {
  gitPath,
  headCommit,
  repoInfo,
} from '../../../git/index.js';
import {
  mainPolicy,
} from '../../../sandbox/index.js';
import {
  readGateReceipt,
  receiptBinds,
  receiptStore,
} from './run/receipt.js';
import { requireGateExecutionServices } from './slot.js';
import {
  releaseReceiptBody,
  releaseReceiptFields,
  releaseReceiptProblem,
  releaseTiming,
  readReleaseReceipt,
} from './release/receipt.js';
import {
  Refused,
} from '../../../kernel/index.js';
import { storeName } from './store-names.js';
import { fileSystemAdapter } from '../../../fs/index.js';
const fs = fileSystemAdapter();

/** Bind a release to the accepted coordinator head and accepted command, with no dirty-tree substitute. */
export function releaseSource(root) {
  const policy = mainPolicy(root);
  const head = headCommit(root), tree = committedTree(root);
  if (!tree || head !== policy.commit) throw new Refused('GATE_RUN_EVIDENCE', 'run the release gate on the clean accepted coordinator head');
  return { head, tree, command: createHash('sha256').update(policy.config.gate).digest('hex'), policy };
}

/** The folder of a repository's native release receipts: the one place that names it (registry owner, #6743). */
export function releaseReceiptDirectory(root) {
  return join(repoInfo(root).commonDir, 'pullboard', 'release-receipts');
}

/** The path of one native release receipt. */
export function releaseReceiptFile(root, id) {
  return join(releaseReceiptDirectory(root), storeName(id));
}

/** Verify only this repository's privately recorded execution and its native gate bytes, never an imported file. */
export function verifyNativeReleaseReceipt(root, id, executionServices) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/u.test(id)) return null;
  try {
    const source = releaseSource(root);
    const { releaseExecutors } = requireGateExecutionServices(executionServices).landing;
    const file = releaseReceiptFile(root, id);
    // Current registration is independently observed; a caller cannot shrink the required machine set.
    const expected = { head: source.head, tree: source.tree, command: source.command,
      required: releaseExecutors().map(entry => entry.id) };
    const envelope = readReleaseReceipt(file, expected);
    return readCoordinatorRelease(root, id)?.head === source.head && envelope?.participation.id === id && receiptBinds(receiptStore(root), envelope.gateReceipt) ? envelope : null;
  } catch { return null; }
}

/** Execute the actual accepted full gate with mandatory native placement before privately writing an envelope. */
export async function runReleaseGate(root, { agent = 'release', onWait, executionServices, personOverride } = {}) {
  const source = releaseSource(root);
  checkCoordinatorRelease(root, { personOverride });
  executionServices = requireGateExecutionServices(executionServices);
  const executors = executionServices.landing.releaseExecutors();
  const request = { version: 1, id: randomUUID(), executors };
  const startedAt = new Date().toISOString();
  const run = await runGate(root, source.policy.config, { trustStamp: false, landing: true, collectAll: true,
    releaseRequest: request, executionServices, agent, onWait });
  const after = releaseSource(root);
  if (after.head !== source.head || after.tree !== source.tree || after.command !== source.command) {
    throw new Refused('GATE_RUN_EVIDENCE', 'the accepted release source changed during execution; keep its logs and run again on the accepted head');
  }
  const gateReceipt = readGateReceipt(receiptStore(root), run.receiptId);
  const observed = run.releaseParticipation;
  const expected = { head: source.head, tree: source.tree, command: source.command, required: executors.map(entry => entry.id) };
  const timing = releaseTiming(observed);
  const envelope = { version: 1, gateReceipt, participation: observed, ...(timing ? { timing } : {}) };
  const problem = releaseReceiptProblem(envelope, expected);
  if (!run.isGreen || problem) {
    throw new Refused('GATE_RUN_EVIDENCE', `release gate did not produce complete green evidence: ${problem ?? 'the actual gate failed'}; inspect its native gate log`);
  }
  const coordinator = checkCoordinatorRelease(root, { personOverride });
  // Only this execution path writes native release custody. The structural reader has no writer.
  fs.mkdir(releaseReceiptDirectory(root), { recursive: true, mode: 0o700 });
  const file = releaseReceiptFile(root, request.id);
  const body = releaseReceiptBody(envelope, expected);
  fs.writeFile(file, body, { flag: 'wx', mode: 0o600 });
  recordCoordinatorRelease(root, request.id, source.head, coordinator);
  // This private execution path has now checked the actual full receipt, source and all executor custody.
  fs.writeFile(gitPath(root, 'pullboard-gate-green'), `${source.tree}\n`);
  return { receipt: releaseReceiptFields(envelope, expected), file, timing,
    seconds: timing?.seconds ?? Math.ceil((Date.now() - Date.parse(startedAt)) / 1000), overBudget: timing?.status === 'OVER_BUDGET', gateLog: run.log, profilePath: run.profilePath };
}
