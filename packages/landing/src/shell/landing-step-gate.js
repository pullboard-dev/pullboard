import { requireTestTierAccount } from '../../../gate/index.js';
import { selectTestTiers } from '../../../gate/index.js';
import { testTierCommand } from '../../../gate/index.js';
import { VALUE_GATE } from '../../../gate/index.js';
import { blockingFailures } from '../../../verify/index.js';
/** Coordinator landing gate step; source-preserving partition of land.js [B3,R3,C7]. */
import { completeGate } from './landing-completion.js';
import { runnerExecutionServices } from '../../../../src/runners.js';
import { landingExecutionServices } from './landing-shards.js';
import { runLocalLandingGuard } from '../core/land-local-guard.js';
import { createHash } from 'node:crypto';
import { copyFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import * as store from '../../../../src/board.js';
import { git } from '../../../../src/git.js';
import { headCommit } from '../../../../src/git.js';
import { headTree } from '../../../../src/git.js';
import { isClean } from '../../../../src/git.js';
import { runGate } from '../../../../src/gate.js';
import { readGateReceipt } from '../../../../src/gate-run-receipt.js';
import { receiptStore } from '../../../../src/gate-run-receipt.js';
import { selectAffectedTests } from '../../../../src/affected-tests.js';
import { selectRegistryGuards } from '../../../kernel/index.js';
import { placementLandingPlan } from '../../../../src/test-placement.js';
import { laneOf } from '../../../../src/lanes.js';
import { Refused } from '../../../kernel/index.js';
import { environmentLabel } from '../../../sandbox/index.js';
import { landingFileTimes } from '../../../items/index.js';
import { environmentWarnings } from './landing-step-selection.js';
import { landingFailures } from './landing-step-failures.js';
import { save } from './landing-step-merge.js';
import { coveredFailures } from './landing-step-failures.js';
import { accountedFailures } from './landing-step-failures.js';
import { liveWaiverProjection } from './landing-step-failures.js';
import { mergeGroup } from './landing-step-merge.js';
import { landingOperations } from './landing-step-merge.js';

/** Quote a command argument without allowing shell interpolation. */
export function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

/** Record the receipt the landing gate wrote for its run, in the lane that owns its first failing test [C7,D1]. */
async function recordLandingRun(state, receiptId) {
  const receipt = readGateReceipt(receiptStore(state.batch.root), receiptId);
  if (!receipt) return;
  const owner = receipt.failures.map(failure => laneOf(state.config, failure.file)).find(lane => lane !== 'coordinator');
  await state.write('recordGateRun', [{ agentId: 'coordinator', receipt, lane: owner ?? store.getItem(state.board, state.batch.items[0].id).item_lane }]);
}

/** Select one deduplicated merged-tree test plan for both inline and local-first landing paths. */
function batchAffectedTests(state) {
  const root = state.batch.root;
  const commit = headCommit(root);
  const testTiers = selectTestTiers(root, { base: state.batch.base, commit, runner: state.config.affectedTests });
  if (testTiers) return { full: false, mandatory: [], testTiers, files: [...new Set([...testTiers.journeys, ...deferredSelections(state).flatMap(row => row.files)])].sort() };
  const selection = state.config.affectedTests
    ? selectAffectedTests(root, { base: state.batch.base, commit })
    : { full: true, reason: 'affected-test selection is not enabled for this project', files: [] };
  const registry = selectRegistryGuards(root, state.config.registryGuards, { base: state.batch.base, git });
  const mandatory = [...new Set([...(state.config.submitInvariants ?? []), ...registry])].sort();
  return { ...selection, mandatory, files: [...new Set([...mandatory, ...(!selection.full ? selection.files : [])])].sort() };
}

/** Bind each cached result to its exact full-gate or local-trunk guard plan. */
function batchGatePlan(state, { localTrunk = false } = {}) {
  const selection = batchAffectedTests(state);
  if (selection.testTiers) {
    const command = testTierCommand(selection.testTiers, selection.files) || 'true';
    return { config: { ...state.config, gate: command, [VALUE_GATE]: true }, files: selection.files, subset: false, testTiers: true,
      affectedGate: createHash('sha256').update(command).digest('hex') };
  }
  const changed = git(state.batch.root, ['diff', '--no-renames', '--name-only', '-z', state.batch.base, 'HEAD']).split('\0').filter(Boolean);
  // Receipt-enabled publication runs the unchanged full command on its final envelope; this pass is only its floor.
  const receiptFloor = state.config.landing?.requireReceipts === true && Boolean(state.config.affectedTests);
  const deferred = localTrunk || receiptFloor ? deferredSelections(state).flatMap(row => row.files) : [];
  const valued = placementLandingPlan(state.batch.root, state.config, selection, [...selection.mandatory, ...deferred], changed);
  if (valued) return valued;
  if (localTrunk || receiptFloor) {
    const files = [...new Set([...selection.files, ...deferred])].sort();
    const affected = files.length ? `${state.config.affectedTests} ${files.map(quote).join(' ')}` : '';
    const command = selection.full && !receiptFloor ? affected ? `(\n${state.config.gate}\n) && ${affected}` : state.config.gate : affected || 'true';
    const config = { ...state.config, gate: command };
    return { config, files, subset: receiptFloor || !selection.full, affectedGate: createHash('sha256').update(command).digest('hex') };
  }
  const appended = selection.files.length ? `${state.config.affectedTests} ${selection.files.map(quote).join(' ')}` : '';
  const config = appended ? { ...state.config, gate: `(\n${state.config.gate}\n) && ${appended}` } : state.config;
  return { config, affectedGate: createHash('sha256').update(config.gate).digest('hex') };
}

/** Preserve the same native failure and gate-run observer for floors and exact envelope gates. */
export function landingRunObserver(state, config, commit) {
  const pin = state.landingPorts.flakeSource(state.batch.root, { commit, main: state.batch.base });
  return Object.assign((run, { root, command, lease }) => state.landingPorts.observeNativeFailure({ root, config, pin, run, command, lease, kind: 'land', checkAtCommit: state.checkAtCommit,
    record: observation => {
      const owner = observation.file ? laneOf(state.config, observation.file) : 'coordinator';
      const lane = owner === 'coordinator' ? store.getItem(state.board, state.batch.items[0].id).item_lane : owner;
      return state.write('recordFlakeObservation', [{ agentId: 'coordinator', observation, lane }]);
    } }), { main: pin.main, recordRun: receiptId => recordLandingRun(state, receiptId) });
}

/** Run one source-pinned gate or selective floor, retaining its complete immutable phase log. */
export async function gateGroup(state, label, options) {
  const tree = headTree(state.batch.root);
  const commit = headCommit(state.batch.root);
  const { config, affectedGate, files, subset, testTiers } = batchGatePlan(state, options);
  const recorded = state.gates.get(tree);
  if (recorded?.timedOut) throw new Refused('LAND_GATE_TIMEOUT', 'this exact tree has a recorded landing timeout; inspect its log before starting a new batch');
  let cached = recorded?.affectedGate === affectedGate ? recorded : null;
  if (cached?.blockingVerdict) {
    try { state.landingPorts.validateQuarantineGate(state.board, cached); } catch { cached = null; }
  }
  if (cached && (completeGate(cached) || !coveredFailures(state, cached))) return cached;
  const directory = join(dirname(state.batch.root), 'logs');
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, `${label}-${state.batch.revision}.log`);
  await save(state, { state: 'gating', tip: headCommit(state.batch.root), logPath });
  const onFailure = landingRunObserver(state, config, commit);
  const quarantines = state.landingPorts.quarantineVerdictSnapshot(state.board);
  const item = store.getItem(state.board, state.batch.items[0].id);
  const proofContext = { item: item.item_id, frozenDigest: item.item_frozen_digest, seat: 'coordinator', kind: 'land' };
  const gate = subset
    ? await runLocalLandingGuard(state.batch.root, config, { files, directory, label, onWait: state.onWait,
      waivers: liveWaiverProjection(state.board, state.landingPorts), onFailure, quarantines, proofContext })
    : await runGate(state.batch.root, config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, trustStamp: false, landing: true, agent: 'coordinator', onWait: state.onWait,
      stages: true, waivers: liveWaiverProjection(state.board, state.landingPorts), onFailure, quarantines, proofContext });
  if (testTiers) requireTestTierAccount(gate, files);
  if (subset && gate.proofReceiptId) await recordLandingRun(state, gate.proofReceiptId);
  if (gate.blockingVerdict) state.landingPorts.validateQuarantineGate(state.board, { ...gate, tree });
  copyFileSync(gate.log, logPath);
  if (gate.profilePath) copyFileSync(gate.profilePath, `${logPath}.profile.json`);
  if (headCommit(state.batch.root) !== commit || headTree(state.batch.root) !== tree || !isClean(state.batch.root)) {
    throw new Refused('LAND_SOURCE_CHANGED', `the landing source changed while the gate ran; inspect ${logPath} and restore the recorded batch before adopting`);
  }
  const failures = blockingFailures(gate, landingFailures(gate.output, state.batch.root));
  if (!failures) throw new Refused('LAND_DIAGNOSTIC', 'the gate lost its complete native quarantine failure account');
  const result = { ...gate, failures, accounted: blockingFailures(gate, accountedFailures(gate, state.batch.root)), complete: completeGate(gate),
    requiresGreen: Boolean(cached && !completeGate(cached)), tree, logPath, affectedGate };
  state.gates.set(tree, result);
  const evidence = state.batch.invariantEvidence ?? { version: 1, gates: [], diagnostics: [] };
  const tested = { commit, isGreen: gate.isGreen && completeGate(gate),
    submissions: state.batch.items.map(({ id, commit }) => ({ id, commit })),
    failures: [...new Set((gate.blockingVerdict ? failures : landingFailures(gate.output, state.batch.root, { excludeCancelled: true })).map(failure => failure.file).filter(Boolean))],
    fileTimes: landingFileTimes(state.batch.root, gate.profile) };
  const warnings = gate.environment ? environmentWarnings(state.board, state.batch.items, gate.environment) : [];
  for (const warning of warnings) state.say(`#${warning.item} was checked on ${environmentLabel(warning.recorded)}; this landing ran on ${environmentLabel(warning.landing)}`);
  await save(state, { environmentWarnings: warnings, gateResults: [...state.gates.values()].map(({ tree: testedTree, isGreen, failures, accounted, complete, requiresGreen, logPath: log, flakeDiagnostics, environment: executor, timedOut, affectedGate: plan, blockingVerdict, exitCode, quarantineFailures, receiptId, proofReceiptId }) =>
    ({ tree: testedTree, isGreen, ...(blockingVerdict ? { blockingVerdict, exitCode, quarantineFailures, receiptId, proofReceiptId } : {}), ...(timedOut ? { timedOut: true } : {}), failures, accounted: accounted ?? null, complete: complete ?? null, requiresGreen: Boolean(requiresGreen), logPath: log, ...(plan ? { affectedGate: plan } : {}),
      environment: executor ?? null, ...(flakeDiagnostics ? { flakeDiagnostics } : {}) })),
    invariantEvidence: { ...evidence, gates: [...evidence.gates, tested] } });
  if (gate.timedOut) {
    await save(state, { state: 'blocked', timedOut: true });
    throw new Refused('LAND_GATE_TIMEOUT', 'the landing gate timed out; its process tree is stopped and no candidate is a culprit');
  }
  return result;
}

/** Merge and test one speculative prefix without giving its worker publication authority. */
export async function runLandingCandidate({ root, board, config, batch, entries, write, say, onWait, checkLease, checkLeaseNow, claimGate, finishGate, checkAtCommit, landingPorts }) {
  landingPorts = landingOperations(landingPorts);
  await checkLease();
  if (!existsSync(batch.root)) {
    mkdirSync(dirname(batch.root), { recursive: true });
    checkLeaseNow();
    git(root, ['worktree', 'add', '--detach', batch.root, batch.base]);
  }
  board.quarantineEnabled = () => config.flakes?.quarantine === true;
  const state = { root, board, config, batch, write, say, onWait, checkLease, checkLeaseNow, checkAtCommit, landingPorts,
    culprits: [], flaky: false, gates: new Map(), diagnosed: new Map() };
  const build = await mergeGroup(state, entries);
  await save(state, { ...build });
  // A conflicting prefix is not its requested composition. Never test the smaller accidental tree.
  if (build.conflicts.length || !build.items.length) return { batch: state.batch, gate: null };
  const tree = headTree(batch.root);
  const claimed = await claimGate(tree, batchGatePlan(state).affectedGate);
  if (claimed.previous) state.gates.set(tree, claimed.previous);
  if (claimed.cached?.blockingVerdict) state.landingPorts.validateQuarantineGate(state.board, claimed.cached);
  const gate = claimed.cached ?? { ...await gateGroup(state, 'candidate'), proofRoot: state.batch.root, proofCommit: headCommit(state.batch.root) };
  if (!claimed.cached) await finishGate(tree, gate);
  await save(state, { state: gate.isGreen ? 'ready' : 'blocked' });
  return { batch: state.batch, gate };
}

/** The affected test files each batch item's submission moved to the landing gate, read from its exact submit. */
export function deferredSelections(state) {
  return state.batch.items.flatMap((entry) => {
    const event = store.events(state.board, { itemId: entry.id }).findLast((row) => row.event_kind === 'submit');
    const detail = event ? JSON.parse(event.event_detail) : null;
    const files = detail?.commit === entry.commit ? detail.submissionProof?.deferredFiles ?? [] : [];
    return files.length ? [{ entry, files }] : [];
  });
}
