import { EXIT_RULES_ENGINE } from "../../../state/index.js";
import { proofReceipts } from "./board/query.js";
import { hasAgent } from "./board/query.js";
export { proofReceipts };
/** Stamp the gate's own immutable receipt with the board's seat and recorded parent [C7,H16]. */
import {
  atomic,
  getItem,
  logEvent,
} from "./board.js";
import { ENGINE_VERSION } from "../../../state/index.js";
import { SUBMIT_PROOF_REUSE_ENGINE } from '../../../state/light.js';
import { PROOF_RUN_ENGINE } from "../../../state/light.js";
import { Refused } from "../../../kernel/index.js";
import { agentParent } from "../../../seats/index.js";
import { SHADOW_TIER1_ENGINE } from "../../../state/light.js";
import { QUARANTINE_VERDICT_ENGINE } from "../../../state/light.js";
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { fileSystemAdapter } from '../../../fs/index.js';
import { join } from 'node:path';
import { storeName } from './store-names.js';

const fs = fileSystemAdapter();

/** Read the native gate's file before sealing a replayable move; caller-supplied fields are not evidence. */
export function boundProofReceipt(board, request) {
  const { boardReceiptStore, readGateReceipt, receiptBody } = board.runtimePorts.sourceAdvanceReceipts;
  const id = request?.receiptId ?? request?.receipt?.id;
  const stored = readGateReceipt(boardReceiptStore(board), id);
  if (!stored || stored.version !== 2 || request?.receipt && receiptBody(request.receipt) !== receiptBody(stored)) {
    throw new Refused('PROOF_RUN_UNBOUND', 'proof provenance comes from the gate receipt it stored; run the check, then read pullboard show <id>');
  }
  if (!proofReceipts(board, stored.proof.item).some(run => run.id === stored.id)) board.nativePorts.quarantine.sealQuarantineVerdict(board, stored);
  return stored;
}

/** Validate native facts against current board-owned identities without changing the board. */
export function proofRunReceipt(board, request) {
  if (!hasAgent(board, request?.agentId)) throw new Refused('NOT_JOINED', 'join before recording a proof run');
  const run = board.executionEngineVersion === undefined ? boundProofReceipt(board, request) : board.runtimePorts.sourceAdvanceReceipts.receiptFields(request.receipt);
  return proofReceiptFields(board, request, run);
}

/** Check board state again under the atomic boundary using only origin-sealed immutable receipt bytes. */
function proofReceiptFields(board, request, run) {
  const { agentId, itemId } = request;
  if (!hasAgent(board, agentId)) throw new Refused('NOT_JOINED', 'join before recording a proof run');
  if (!run || run.version !== 2 || run.proof.item !== itemId) throw new Refused('PROOF_RUN_UNBOUND', 'the native receipt must name this item; run its check and read pullboard show <id>');
  if (run.proof.seat !== agentId) throw new Refused('PROOF_RUN_ACTOR', 'the native receipt belongs to another seat; use the receipts from your own check');
  const item = getItem(board, itemId);
  if (run.proof.frozenDigest !== (item.item_frozen_digest ?? null)) throw new Refused('PROOF_RUN_STALE', 'the criterion changed during this proof; read pullboard show <id> before checking again');
  const existing = proofReceipts(board, itemId).find(value => value.id === run.id);
  const exitFailures = (board.executionEngineVersion ?? ENGINE_VERSION) >= EXIT_RULES_ENGINE
    && (board.executionEngineVersion === undefined || request.exitFailures === true)
    && (!existing || Object.hasOwn(existing, 'failures'));
  const receipt = { id: run.id, kind: run.kind, item: itemId, commit: run.head, tree: run.tree,
    frozenDigest: run.proof.frozenDigest, environment: run.proof.environment, runner: run.proof.runner,
    seat: agentId, parentSession: agentParent?.(board, agentId) ?? null, exitCode: run.proof.exitCode,
    counts: run.proof.counts, durationMs: run.proof.durationMs, sourceClean: run.proof.sourceClean, at: run.at,
    ...(Object.hasOwn(run.proof, 'testRuntimes') ? { testRuntimes: run.proof.testRuntimes } : {}) };
  if (Object.hasOwn(run, 'blockingVerdict')) {
    receipt.blockingVerdict = run.blockingVerdict;
    receipt.failures = run.failures;
  } else if (exitFailures) receipt.failures = run.failures;
  if (Object.hasOwn(run, 'shadow') && (board.executionEngineVersion ?? ENGINE_VERSION) >= SHADOW_TIER1_ENGINE) receipt.shadow = run.shadow;
  if (Object.hasOwn(run.proof, 'submitPhase')) { receipt.submitPhase = run.proof.submitPhase; receipt.command = run.command; }
  if (Object.hasOwn(run.proof, 'submitAdmission')) receipt.submitAdmission = run.proof.submitAdmission;
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= SUBMIT_PROOF_REUSE_ENGINE && run.proof.submitReuse === true) {
    receipt.submitReuse = true; receipt.submitReusePlan = run.proof.submitReusePlan; receipt.main = run.main; receipt.command = run.command; receipt.green = run.green;
  }
  if (existing) {
    const { eventId, ...fields } = existing;
    // Later registration cannot retroactively upgrade an originally unknown parent.
    receipt.parentSession = existing.parentSession;
    if (JSON.stringify(fields) !== JSON.stringify(receipt)) throw new Refused('PROOF_RUN_CHANGED', 'that receipt id already binds different facts; keep the original and run a new check');
  }
  if (!existing) board.nativePorts.quarantine.validateQuarantineVerdict(board, run);
  return { receipt, existing };
}

/** Record native facts atomically, revalidating after the native adapter's read-only preflight. */
export function recordProofRun(board, request) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < PROOF_RUN_ENGINE) {
    throw new Refused('ENGINE_VERSION', `proof receipts require engine ${PROOF_RUN_ENGINE}; upgrade Pullboard`);
  }
  if (!hasAgent(board, request?.agentId)) throw new Refused('NOT_JOINED', 'join before recording a proof run');
  const run = board.executionEngineVersion === undefined ? boundProofReceipt(board, request) : board.runtimePorts.sourceAdvanceReceipts.receiptFields(request.receipt);
  return atomic(board, () => {
    const { receipt, existing } = proofReceiptFields(board, request, run);
    if (existing) return existing;
    logEvent(board, request.agentId, 'proof-run', request.itemId, { engine: Object.hasOwn(receipt, 'shadow') ? SHADOW_TIER1_ENGINE : Object.hasOwn(receipt, 'failures') && !Object.hasOwn(receipt, 'blockingVerdict') ? EXIT_RULES_ENGINE : receipt.blockingVerdict ? QUARANTINE_VERDICT_ENGINE : PROOF_RUN_ENGINE, receipt });
    if (receipt.shadow) logEvent(board, request.agentId, 'fact', request.itemId, { id: randomUUID(), kind: 'measurement',
      text: `Tier-1 shadow for gate receipt ${receipt.id} at ${receipt.commit}: ${receipt.shadow.verdict}; real gate result: ${receipt.shadow.real}; differs: ${receipt.shadow.differs}.`,
      ref: { kind: 'proof-run', id: receipt.id }, supersedes: null });
    return receipt;
  });
}

/**
 * Store a green `pullboard test` run as an immutable native check receipt, naming the item, the checkout's commit,
 * the files (as the command digest) and the runner, and return its id for recordProofRun to bind. Null when the board keeps no receipt folder.
 * Why: a test run is proof only when show <id> can name the item and commit it covered [C7].
 * @param {any} board
 * @param {{ agentId: string, itemId: number, commit: string, tree?: string|null, files: string[], runner?: string|null, durationMs?: numbercounts?: object }} run
 * @returns {string|null}
 */
export function storeTestReceipt(board, run) {
  const { boardReceiptStore, receiptBody } = board.runtimePorts?.sourceAdvanceReceipts ?? {};
  const folder = typeof boardReceiptStore === 'function' ? boardReceiptStore(board) : null;
  if (!folder) return null;
  const item = getItem(board, run.itemId);
  const counts = { passed: run.counts?.passed ?? null, failed: run.counts?.failed ?? null, skipped: run.counts?.skipped ?? null };
  const body = { version: 2, id: randomUUID(), kind: 'check', tree: run.tree ?? null, head: run.commit, main: null,
    command: createHash('sha256').update(`pullboard test ${run.files.join(' ')}`).digest('hex'), green: true, failures: [], load: null, at: new Date().toISOString(),
    proof: { item: run.itemId, frozenDigest: item.item_frozen_digest ?? null, seat: run.agentId, runner: run.runner ?? null, exitCode: 0,
      durationMs: Number.isSafeInteger(run.durationMs) && run.durationMs >= 0 ? run.durationMs : 0, sourceClean: true, environment: null, counts } };
  const text = receiptBody(body);
  if (!text) return null;
  fs.mkdir(folder, { recursive: true, mode: 0o700 });
  fs.writeFile(join(folder, `${storeName(body.id)}`), text, { mode: 0o600, flag: 'wx' });
  return body.id;
}

/** A short pointer replaces repeated provenance narratives in shouts. */
export function refuseLongShout(text) {
  if (Array.from(String(text)).length > 400) {
    throw new Refused('SHOUT_TOO_LONG', 'a shout is at most 400 characters; cite proof receipt ids and use pullboard show <id> for the chain');
  }
}
