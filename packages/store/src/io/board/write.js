import { requireExitActive } from "../../logic/exit/rules/claim.js";
/** The native command prepares external work before its final ordered writer [B2,C7]. */
import * as store from "../board.js";
import { measureBoardWritePhase } from './write/lock.js';
import { observedWriterRecords } from './write/preparation.js';
import { prepareReserveNextReview } from "./reserve/next.js";
import { prepareReserveReview } from "./reserve/review.js";
import { requireHandoffActive } from "../../../../state/light.js";
import { requireAgentGrant } from "../../../../state/index.js";
import { ENGINE_VERSION } from "../../../../state/index.js";
import { REVIEW_GATE_RECEIPT_ENGINE } from "../../../../state/light.js";
import { Refused } from "../../../../kernel/index.js";
import { processMachineHome } from "../../../../kernel/light.js";
import { writeFileAtomic } from "../../../../kernel/light.js";
import { readCrossProcessWrites } from "../../../../config/index.js";
import { createFileWriteQueue } from "../write-queue-file.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireFileLease } from "../../../../items/index.js";

const PREPARE_ATTEMPTS = 4;

// Like the writer dispatch, each preparation belongs to its exact native operation, never the wire.
// Each returns the writer's arguments: item moves prepare their options; next --verify prepares its selection and a
// named reservation its witness, so no candidate scan or witness build runs in the writer's transaction (#3156).
const PREPARATIONS = Object.freeze({
  claim: (board, args) => [args[0], store.prepareClaim(board, args[0], args[1])],
  queueSubmitHandoff: (board, args) => [args[0], store.prepareQueueSubmitHandoff(board, args[0], args[1])],
  reserveNextReview: (board, args) => [prepareReserveNextReview(board, args[0]), ...args.slice(1)],
  reserveReview: (board, args) => [args[0], prepareReserveReview(board, args[0], args[1]), ...args.slice(2)],
  // A verdict on work whose gate has no captured receipt is refused before any write transaction opens (#5561).
  // Its slow evidence reads (every item, the quarantine proof's runs) run here too, and the writer re-checks only what it writes (#5576).
  verify: (board, args) => { refuseUnreceiptedVerdict(board, args[0]); return prepareVerdictEvidence(board, args); },
  // Gate-run and flake writes read every earlier run; read them here so the writer reads only the runs since (#2294).
  recordGateRun: (board, args) => { warmHistories(board); return args; },
  recordFlakeObservation: (board, args) => { warmHistories(board); return args; },
  // A coordinator's bar correction freezes from git (main policy, facts, spec, test hashes); freeze it here, not under the lock.
  editItem: (board, args) => [args[0], prepareEditFreeze(board, args[0], args[1]), ...args.slice(2)],
});

/** The rows an edit's freeze reads from the board: the item, its newest event, and the bar settings and item-keyed metadata. */
function editFreezeRows(board, id) {
  const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(id) ?? null;
  const lastEvent = board.db.prepare('SELECT MAX(event_id) AS id FROM event WHERE item_id=?').get(id)?.id ?? null;
  const meta = board.db.prepare(`SELECT meta_key,meta_value FROM board_meta WHERE meta_key IN ('row_decisions','bar_ready_setting')
    OR meta_key LIKE '%:' || ? OR meta_key LIKE '%\\_' || ? ESCAPE '\\' ORDER BY meta_key`).all(String(id), String(id));
  return JSON.stringify({ item, lastEvent, meta });
}

/**
 * Freeze a corrected bar with no lock held, and hand the writer a freeze that reuses it while nothing it read has changed.
 * Why: the freezer reads git for about a second on a busy machine, and an edit held the board's one write lock for all of it.
 * A changed item or bar setting freezes again under the lock, so the stored bar is the one a locked freeze would store.
 */
export function prepareEditFreeze(board, id, options) {
  if (!options?.correction || typeof options.freeze !== 'function') return options;
  let key;
  let rows;
  let frozen;
  try {
    const { item, next } = store.validateItemEdit(board, id, options);
    const candidate = { ...item, ...next };
    key = JSON.stringify(candidate);
    rows = editFreezeRows(board, id);
    frozen = options.freeze(candidate);
  } catch { return options; /* The writer runs the same checks and freeze under the lock and refuses there. */ }
  const freeze = options.freeze;
  return { ...options, freeze: candidate => JSON.stringify(candidate) === key && editFreezeRows(board, id) === rows ? frozen : freeze(candidate) };
}

/**
 * Refuse a verdict whose gate has no captured proof receipt, reading with no lock held; the writer checks it again.
 * Why: a refusal rolls back, yet it still held the board's one write lock while it read the receipts (#5561).
 */
function refuseUnreceiptedVerdict(board, id) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < REVIEW_GATE_RECEIPT_ENGINE) return;
  const problem = store.gateReceiptProblem(board, store.getItem(board, id) ?? {});
  if (problem) throw problem;
}

/** Run a verdict's evidence checks with no lock held and mark the options so the writer skips the slow reads. */
export function prepareVerdictEvidence(board, args) {
  const [id, options] = args;
  if (!options || (options.knownMainFailures === undefined && options.quarantineProofId === undefined)) return args;
  store.verdictEvidence(board, id, { agentId: options.agentId, isAccept: options.decision === 'ACCEPT', engine: board.executionEngineVersion ?? ENGINE_VERSION,
    review: options.review, knownMainFailures: options.knownMainFailures, quarantineProofId: options.quarantineProofId });
  return [id, { ...options, prechecked: true }, ...args.slice(2)];
}

/** Read the shared gate-run and flake histories with no lock held. */
function warmHistories(board) {
  board.enginePorts.store.gateRuns(board);
  board.enginePorts.store.flakeLedger(board);
}

/** One file queue handle per queue folder for this process, so every claim shares its pending records and drain lock. */
const FILE_QUEUES = new Map();

/** How long a stored queue answer is kept: long enough for a crashed caller's retry, short enough that the folder never fills (#10089). */
const QUEUE_RESULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The operations that go through the file write queue with board.crossProcessWrites on: one list, never a copy per operation (#9816, #9817, #8163). */
const QUEUED_OPERATIONS = new Set(['claim', 'release', 'verify']);

/**
 * The write id of a queued write: the caller's own move id when its options carry one, else a digest of the board, the
 * operation and the arguments. Why args and never time or pid: a caller that crashed and retries the same claim must
 * reach the same result file, so it gets the first answer and never a second claim event (#9816, #8163).
 */
function queuedWriteId(board, operation, args) {
  const moveId = typeof args[1]?.moveId === 'string' && args[1].moveId ? args[1].moveId : null;
  return createHash('sha256').update(JSON.stringify([store.boardId(board), operation, moveId ?? args])).digest('hex').slice(0, 40);
}

/**
 * Submit a claim, release or verdict to the machine's shared file write queue and give back what its result file holds.
 * With board.crossProcessWrites on this returns a promise; the queue answers across processes, so it cannot be synchronous.
 */
async function writeThroughFileQueue(board, operation, args, actor, options) {
  const dir = join(processMachineHome(), 'board-write-queue');
  if (!FILE_QUEUES.has(dir)) FILE_QUEUES.set(dir, createFileWriteQueue(dir));
  const queue = FILE_QUEUES.get(dir);
  queue.prune(QUEUE_RESULT_MAX_AGE_MS);
  const id = queuedWriteId(board, operation, args);
  const mark = join(dir, `${id}.mark`);
  const item = Number.isInteger(args[0]) ? args[0] : null;
  const newest = () => (item === null ? 0 : board.db.prepare('SELECT MAX(event_id) AS id FROM event WHERE item_id=?').get(item)?.id ?? 0);
  // A stored answer is for the item as that write left it. A repeat after the item moved on (claim, release, claim again) is a new write, not a retry [#10089].
  if (queue.result(id) && newest() > Number(readMark(mark))) queue.forget(id);
  const outcome = await queue.submit({ id, run: () => {
    try { return writeBoardDirect(board, operation, args, actor, options); } finally { writeFileAtomic(mark, String(newest())); }
  } });
  if (outcome.ok) return outcome.value;
  throw new Refused(outcome.error.code, outcome.error.message.replace(new RegExp(`^\\[${outcome.error.code}\\] `, 'u'), ''));
}

/** The item event id a queued write's result was stored at, or -1 when the mark is missing so the result counts as stale. */
function readMark(file) {
  try { return readFileSync(file, 'utf8'); } catch { return '-1'; }
}

/**
 * Preserve native authority before preparation and revalidate it under the actual writer lock. With
 * board.crossProcessWrites on, a claim, a release and a verdict go through the machine's file write queue instead and the call returns a promise;
 * every other operation, and every operation with the setting off, writes directly as before.
 * @param {any} board
 * @param {string} operation
 * @param {any[]} args
 * @param {string|undefined} actor
 * @returns {any}
 */
export function writeBoardCommand(board, operation, args, actor, options = {}) {
  if (QUEUED_OPERATIONS.has(operation) && readCrossProcessWrites()) return writeThroughFileQueue(board, operation, args, actor, options);
  return writeBoardDirect(board, operation, args, actor, options);
}

/** The direct write: guards, preparation and the one ordered writer transaction. */
function writeBoardDirect(board, operation, args, actor, { prepareInWriter } = {}) {
  requireHandoffActive(board, actor, operation, args);
  requireExitActive(board, actor, operation, args);
  // claims.fileLease (off by default): a live claim's predicted files are leased to it; a refusal writes nothing [C7,#8521].
  if (board.fileLease && operation === 'claim' && actor) {
    const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(args[0]);
    if (item) requireFileLease(board.db, item, actor, board.fileLease, board.clock.now().toISOString());
  }
  requireAgentGrant(board, { operation, args, engine: ENGINE_VERSION, ...(board.itemsInGate > 0 ? { itemsInGate: board.itemsInGate } : {}) });
  const prepare = PREPARATIONS[operation];
  // Another connection's commit (a peer's renewal, a baseline worker) can land between preparation and
  // the writer lock; the prepared plan is then stale, so prepare again from the new board. Bounded so a
  // continuously changing board still reports BOARD_BUSY. This is why concurrent renewals all succeed.
  for (let attempt = 0; ; attempt++) {
    let preparing = true;
    let rollbackPrepared;
    try {
      const prepared = prepare ? prepare(board, args) : args;
      preparing = false;
      return store.atomic(board, () => {
        const writerResult = prepareInWriter ? prepareInWriter(board) : null;
        if (writerResult && typeof writerResult.then === 'function') throw new TypeError('board writer preparation must be synchronous');
        rollbackPrepared = typeof writerResult?.rollback === 'function' ? writerResult.rollback : undefined;
        if (writerResult && (!Array.isArray(writerResult.args)
          || writerResult.rollback !== undefined && typeof writerResult.rollback !== 'function')) {
          throw new TypeError('board writer preparation must return args and an optional rollback function');
        }
        const current = writerResult ? writerResult.args : prepared;
        if (writerResult) args.splice(0, args.length, ...current);
        measureBoardWritePhase(board.db, 'handoff-guard', () => requireHandoffActive(board, actor, operation, current));
        measureBoardWritePhase(board.db, 'exit-guard', () => requireExitActive(board, actor, operation, current));
        measureBoardWritePhase(board.db, 'agent-grant', () => requireAgentGrant(board, { operation, args: current, engine: ENGINE_VERSION, ...(board.itemsInGate > 0 ? { itemsInGate: board.itemsInGate } : {}) }));
        return measureBoardWritePhase(board.db, 'native-move', () => board.enginePorts.store[operation](board, ...current), operation);
      });
    } catch (error) {
      rollbackPrepared?.();
      // Claim preparation already owns its bounded retries; only queue sealing needs this outer retry.
      if (preparing && operation !== 'queueSubmitHandoff') throw observedWriterRecords(error);
      // The lock is released here, so a final refusal can read the machine write log to name its writer (#6016).
      if (!prepare || !(error instanceof Refused) || error.code !== 'BOARD_BUSY' || attempt >= PREPARE_ATTEMPTS - 1) throw observedWriterRecords(error);
      // Jitter outside the rolled-back transaction, so contending preparations stop retrying in step (#6016).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.floor(Math.random() * 25 * (attempt + 1)));
    }
  }
}
