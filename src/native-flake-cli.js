/** CLI diagnostic adapters keep policy capture, execution and evidence inside the existing gate admission. */
import { readFileSync } from 'node:fs';
import { COORDINATOR } from './config.js';
import { laneOf } from './lanes.js';
import {
  mainPolicy,
  policyAt,
} from './trusted-policy.js';
import { pinRunMain } from './gate.js';
import {
  readGateReceipt,
  receiptStore,
} from './gate-run-receipt.js';
import { runProfiledShell } from './gate.js';
import { runFrozenProof } from './gate.js';
import { recordNativeProof } from './proof-cli.js';
import {
  diagnosticUnavailable,
  flakeSource,
  observeNativeFailure,
} from './native-flakes.js';
export { flakesCommand as command } from './flake-command.js';

/** Capture owner policy and source before admission, recording through the CLI's ordinary ordered board moves. */
export function observer(ctx, { kind, board, main, commit, privateCheck = false, config = ctx.config } = {}, { ordered, withBoard, resourceAgent }) {
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
  /**
   * Record the receipt the gate just wrote for its run; the board reads the receipt itself, never a run object [C7,D1].
   * Only the coordinator's runs go on the board, since only they can prove a flake; a seat's run keeps its receipt on
   * disk, so every seat's gate does not add a board move to each submit.
   */
  const recordRun = async receiptId => {
    const receipt = agentId === COORDINATOR ? readGateReceipt(receiptStore(ctx.info.root), receiptId) : null;
    if (!receipt) return;
    const owners = receipt.failures.map(failure => laneOf(acceptedConfig, failure.file)).filter(owner => owner !== COORDINATOR);
    const lane = owners[0] ?? Object.keys(acceptedConfig.lanes)[0];
    const write = target => ordered(ctx, target, 'recordGateRun', [{ agentId, receipt, lane }]);
    await (board ? write(board) : withBoard(ctx, write));
  };
  // The pinned main rides on the observer, so a remote runner's receipt can name the main this run used (#925).
  return Object.assign(async (run, { root = ctx.info.root, command, lease }) => {
    await observeNativeFailure({ root, config: acceptedConfig, pin, run, command, lease, kind,
      record: observation => {
        const ownerLane = observation.file ? laneOf(acceptedConfig, observation.file) : COORDINATOR;
        const lane = ownerLane === COORDINATOR ? Object.keys(acceptedConfig.lanes)[0] : ownerLane;
        const write = target => ordered(ctx, target, 'recordFlakeObservation', [{ agentId, observation, lane }]);
        return board ? write(board) : withBoard(ctx, write);
      } });
  }, { main: pin.main, recordRun });
}

/** Prepare an ordinary check callback before it queues; the callback observes red under that same lease. */
export function check(ctx, item, command, services) {
  const observe = observer(ctx, { kind: 'check' }, services);
  return async lease => {
    pinRunMain(lease, observe);
    lease.proof = { item: item.item_id, frozenDigest: item.item_frozen_digest ?? null, seat: services.resourceAgent(ctx), kind: 'check' };
    const run = runProfiledShell(ctx.info.root, command, { waitMs: lease.waitMs, artifactPrefix: `pullboard-check-${item.item_id}`, persistLog: true, gateLease: lease });
    await recordNativeProof(ctx, item, run, services);
    if (!run.isGreen) await observe(run, { command, lease });
    return run;
  };
}

/** Prepare the private frozen-check callback without losing its retained raw output, profile or execution root. */
export function verify(ctx, item, command, options, services) {
  const observe = observer(ctx, { ...options, kind: 'verify', privateCheck: true }, services);
  return async lease => {
    pinRunMain(lease, observe);
    lease.proof = { seat: services.resourceAgent(ctx) };
    const result = runFrozenProof(ctx.info.root, item, { waitMs: lease.waitMs, gateLease: lease });
    await recordNativeProof(ctx, item, result, services, options.board);
    if (result.state === 'red') await observe({ isGreen: false, output: result.outputPath ? readFileSync(result.outputPath, 'utf8') : result.output,
      log: result.outputPath, profilePath: result.profilePath, executionRoot: result.executionRoot, executionSourceUnchanged: result.executionSourceUnchanged, executionRunner: result.executionRunner,
      executionLoad: result.executionLoad, executionMain: result.executionMain, executionSource: result.executionSource,
      environment: result.environment, profile: result.profile, rawOutputPath: result.rawOutputPath, rawOutputSha256: result.rawOutputSha256 }, { root: ctx.info.root, command, lease });
    return result;
  };
}
