import { receiptRecorder } from "./receipts.js";
import { recordRun } from "../../../../gate/index.js";
/** CLI diagnostic adapters keep policy capture, execution and evidence inside the existing gate admission. */
import { readFileSync } from 'node:fs';
import { COORDINATOR } from "../../../../config/index.js";
import { mappedCheck } from "../../../../codemap/index.js";
import { laneOf } from "../../../../seats/index.js";
import {
  mainPolicy,
  policyAt,
} from "../../../../sandbox/index.js";
import { pinRunMain } from "../../../../gate/index.js";
import {
  readGateReceipt,
  receiptStore,
} from "../../../../gate/index.js";
import { runProfiledShell } from "../../../../gate/index.js";
import { runFrozenProof } from "../../../../gate/index.js";
import { recordNativeProof } from "../../../../verify/index.js";
import { proofRunReceipt } from "../../../../store/index.js";
import { quarantineVerdictSnapshot } from "../quarantine.js";
import {
  diagnosticUnavailable,
  flakeSource,
  observeNativeFailure,
} from "../native.js";
export { flakesCommand as command } from "../command.js";

/** Record the canonical direct-suite receipt through the existing authenticated board move. */
export async function recordSuiteRun(root, receiptId, { context, ordered, withBoard, resourceAgent, nativeBoard }) {
  try {
    const ctx = context({ cwd: root, nativeBoard, say() {}, err() {}, stderr: { write() {} } });
    const receipt = readGateReceipt(receiptStore(root), receiptId);
    if (!receipt || receipt.kind !== 'suite' || !receipt.timing) return;
    await withBoard(ctx, board => ordered(ctx, board, 'recordGateRun', [{ agentId: resourceAgent(ctx), receipt,
      lane: Object.keys(ctx.config.lanes)[0] }]));
  } catch { /* Unavailable board recording preserves the private receipt and the actual suite verdict. */ }
}

/** Record one fresh partial main comparison without lending it full-gate or flake authority. */
export async function recordMainComparison(ctx, receiptId, { ordered, withBoard, resourceAgent }) {
  const receipt = readGateReceipt(receiptStore(ctx.info.root), receiptId);
  if (!receipt || receipt.kind !== 'main-red' || !receipt.timing || receipt.full !== false) return;
  await withBoard(ctx, board => ordered(ctx, board, 'recordGateRun', [{ agentId: resourceAgent(ctx), receipt,
    lane: Object.keys(ctx.config.lanes)[0] }]));
}

/** Capture owner policy and source before admission, recording through the CLI's ordinary ordered board moves. */
export function observer(ctx, { kind, board, main, commit, privateCheck = false, config = ctx.config } = {}, { ordered, withBoard, resourceAgent, checkAtCommit }) {
  let acceptedConfig, pin, agentId;
  try {
    const owner = main ? policyAt(ctx.info.root, main) : mainPolicy(ctx.info.root);
    acceptedConfig = { ...config, flakes: owner.config.flakes };
    pin = flakeSource(ctx.info.root, { main: main ?? owner.commit, commit, privateCheck });
    agentId = resourceAgent(ctx);
  } catch (error) {
    // Diagnostics cannot block an existing check when its coordinator is detached or its observer cannot initialize.
    return async run => { if (!run.isGreen) diagnosticUnavailable({ run }, error); };
  }
  const recordRun = receiptRecorder(ctx, { agentId, acceptedConfig, board, ordered, withBoard });
  // The pinned main rides on the observer, so a remote runner's receipt can name the main this run used (#925).
  /** Record each observation in its owning lane through the ordinary ordered move, opening the board once. */
  const recordAll = observations => {
    const write = async target => {
      for (const observation of observations) {
        const ownerLane = observation.file ? laneOf(acceptedConfig, observation.file) : COORDINATOR;
        const lane = ownerLane === COORDINATOR ? Object.keys(acceptedConfig.lanes)[0] : ownerLane;
        await ordered(ctx, target, 'recordFlakeObservation', [{ agentId, observation, lane }]);
      }
    };
    return board ? write(board) : withBoard(ctx, write);
  };
  return Object.assign(async (run, { root = ctx.info.root, command, lease }) => {
    if (kind === 'submit' && run.proofReceiptId) await recordRun(run.proofReceiptId);
    // A composed Submit phase runs in a private copy removed when the gate returns, while detached diagnostics still run; its commit lives in the board's repository.
    await observeNativeFailure({ root: pin.privateCheck ? ctx.info.root : root, config: acceptedConfig, pin, run, command, lease, kind, checkAtCommit,
      record: observation => recordAll([observation]),
      // One board session records every case after all probes finish, rather than one open per case [#1899].
      recordBatch: observations => recordAll(observations), recordRun });
  }, { main: pin.main, recordRun });
}

/** Prepare an ordinary check callback before it queues; the callback observes red under that same lease. */
export function check(ctx, item, command, services) {
  command = mappedCheck(ctx.info.root, command);
  const observe = observer(ctx, { kind: 'check' }, services);
  return async lease => {
    pinRunMain(lease, observe);
    lease.quarantines = await services.withBoard(ctx, quarantineVerdictSnapshot);
    lease.proof = { item: item.item_id, frozenDigest: item.item_frozen_digest ?? null, seat: services.resourceAgent(ctx), kind: 'check' };
    const run = runProfiledShell(ctx.info.root, command, { waitMs: lease.waitMs, artifactPrefix: `pullboard-check-${item.item_id}`, persistLog: true, gateLease: lease, stages: lease.quarantines.length > 0 });
    await recordNativeProof(ctx, item, run, { ...services, proofRunReceipt });
    await recordRun(observe, run);
    if (!run.isGreen) await observe(run, { command, lease });
    return run;
  };
}

/** Prepare the private frozen-check callback without losing its retained raw output, profile or execution root. */
export function verify(ctx, item, command, options, services) {
  const observe = observer(ctx, { ...options, kind: 'verify', privateCheck: true }, services);
  return async lease => {
    pinRunMain(lease, observe);
    lease.quarantines = options.board ? quarantineVerdictSnapshot(options.board) : await services.withBoard(ctx, quarantineVerdictSnapshot);
    lease.proof = { seat: services.resourceAgent(ctx) };
    const result = runFrozenProof(ctx.info.root, item, { waitMs: lease.waitMs, gateLease: lease }, services);
    await recordNativeProof(ctx, item, result, { ...services, proofRunReceipt }, options.board);
    await recordRun(observe, result);
    if (result.state === 'red') await observe({ isGreen: false, output: result.outputPath ? readFileSync(result.outputPath, 'utf8') : result.output,
      log: result.outputPath, profilePath: result.profilePath, executionRoot: result.executionRoot, executionSourceUnchanged: result.executionSourceUnchanged, executionRunner: result.executionRunner,
      executionLoad: result.executionLoad, executionMain: result.executionMain, executionSource: result.executionSource,
      environment: result.environment, profile: result.profile, rawOutputPath: result.rawOutputPath, rawOutputSha256: result.rawOutputSha256 }, { root: ctx.info.root, command, lease });
    return result;
  };
}
