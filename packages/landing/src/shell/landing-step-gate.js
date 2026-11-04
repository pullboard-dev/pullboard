import { requireTestTierAccount } from '../../../gate/index.js';
import { selectTestTiers } from '../../../gate/index.js';
import { requireSealedSkips } from '../../../gate/index.js';
import { landingRunFiles } from '../../../gate/index.js';
import { packageHashesAt } from '../../../gate/index.js';
import { TEST_TIERS_FILE } from '../../../gate/index.js';
import { testTierCommand } from '../../../gate/index.js';
import { VALUE_GATE } from '../../../gate/index.js';
import { blockingFailures } from '../../../verify/index.js';
/** Coordinator landing gate step; source-preserving partition of land.js [B3,R3,C7]. */
import { completeGate } from './landing-completion.js';
import { runnerExecutionServices } from '../../../runners/index.js';
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
import { tryGit } from '../../../git/index.js';
import { headCommit } from '../../../../src/git.js';
import { headTree } from '../../../../src/git.js';
import { isClean } from '../../../../src/git.js';
import { runGate } from '../../../gate/index.js';
import { readGateReceipt } from '../../../gate/index.js';
import { receiptStore } from '../../../gate/index.js';
import { selectAffectedTests } from '../../../gate/index.js';
import { selectRegistryGuards } from '../../../kernel/index.js';
import { literalShellWords } from '../../../kernel/index.js';
import { mappedCheck } from '../../../codemap/index.js';
import { laneOf } from '../../../seats/index.js';
import { Refused } from '../../../kernel/index.js';
import { environmentLabel } from '../../../sandbox/index.js';
import { landingFileTimes } from '../../../items/index.js';
import { environmentWarnings } from './landing-step-selection.js';
import { singleItemLanding } from './landing-step-selection.js';
import { runLandingCliSmoke } from './landing-cli-smoke.js';
import { landingFailures } from './landing-step-failures.js';
import { save } from './landing-step-merge.js';
import { coveredFailures } from './landing-step-failures.js';
import { accountedFailures } from './landing-step-failures.js';
import { knownMainAccount } from './landing-known-main.js';
import { knownMainFields } from './landing-known-main.js';
import { knownMainLine } from './landing-known-main.js';
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
function batchAffectedTests(state, readEvents, readItem) {
  const root = state.batch.root;
  const commit = headCommit(root);
  const submitted = submittedSelections(state.batch.items, readEvents, (entry, detail) => criterionTestFiles(root, entry, readItem(entry.id), state.config.affectedTests, detail));
  if (state.batch.items.length && submitted === null && state.config.affectedTests?.trim()) {
    throw new Refused('LAND_DIAGNOSTIC', 'the batch has no complete source-matched affected-test plan; refresh its items\' submit proofs before landing');
  }
  const registry = selectRegistryGuards(root, state.config.registryGuards, { base: state.batch.base, git });
  const mandatory = [...new Set([...(state.config.submitInvariants ?? []), ...registry])].sort();
  const testTiers = selectTestTiers(root, { base: state.batch.base, commit, runner: state.config.affectedTests });
  if (testTiers) {
    requireSealedSkips(root, testTiers);
    const affected = submitted === null ? selectAffectedTests(root, { base: state.batch.base, commit }) : { files: submitted };
    if (affected.full && affected.reason !== 'the change reaches every test file') throw new Refused('LAND_DIAGNOSTIC', `cannot establish the batch's affected files: ${affected.reason}`);
    const named = new Set(affected.files);
    // A5 keeps proved units out; journeys and deferred files still need actual merged-tree reach.
    const files = landingRunFiles({ ...testTiers, journeys: testTiers.journeys.filter(file => named.has(file)) }, submittedUnits(state, commit, readEvents));
    const deferred = submitted === null ? deferredSelections(state, readEvents).flatMap(row => row.files).filter(file => named.has(file)) : [];
    const explicit = submitted?.filter(file => !testTiers.units.includes(file)) ?? [];
    return { full: false, mandatory, testTiers, files: [...new Set([...files, ...explicit, ...deferred, ...mandatory])].sort() };
  }
  const selection = submitted !== null ? { full: false, files: submitted } : state.config.affectedTests
    ? selectAffectedTests(root, { base: state.batch.base, commit })
    : { full: true, reason: 'affected-test selection is not enabled for this project', files: [] };
  return { ...selection, mandatory, sourceProof: submitted !== null, files: [...new Set([...mandatory, ...selection.files])].sort() };
}

/** Bind each cached result to its exact full-gate or local-trunk guard plan. */
export function batchGatePlan(state, options = {}) {
  try { return selectedGatePlan(state, options); } catch (error) {
    // A per-item landing whose one item has no narrower readable plan runs the full configured gate instead of stopping [C7,#2901].
    if (!singleItemLanding(state) || error.code !== 'LAND_DIAGNOSTIC') throw error;
    const config = { ...state.config, [VALUE_GATE]: true };
    return { config, files: [], subset: false, affectedGate: createHash('sha256').update(config.gate).digest('hex') };
  }
}

/** The narrowest proved plan for the batch's merged tree, refusing LAND_DIAGNOSTIC when none can be read. */
function selectedGatePlan(state, { readEvents = id => store.events(state.board, { itemId: id }), readItem = id => store.getItem(state.board, id) } = {}) {
  const selection = batchAffectedTests(state, readEvents, readItem);
  if (selection.testTiers) {
    const command = testTierCommand(selection.testTiers, selection.files) || 'true';
    return { config: { ...state.config, gate: command, [VALUE_GATE]: true }, files: selection.files, subset: false, testTiers: true,
      affectedGate: createHash('sha256').update(command).digest('hex') };
  }
  const deferred = selection.sourceProof ? [] : deferredSelections(state, readEvents).flatMap(row => row.files);
  if (!state.config.affectedTests?.trim()) {
    // Projects without selective-runner policy keep their configured full gate. Its command is the legacy contract
    // for the project and already includes the item check (the source-matched proof was checked at submit).
    const config = { ...state.config, [VALUE_GATE]: true };
    return { config, files: selection.files, subset: false, affectedGate: createHash('sha256').update(config.gate).digest('hex') };
  }
  if (selection.full && selection.reason !== 'the change reaches every test file') throw new Refused('LAND_DIAGNOSTIC', `cannot establish the batch's affected files: ${selection.reason}`);
  const files = [...new Set([...selection.files, ...deferred])].sort();
  const command = files.length ? `${state.config.affectedTests.trimEnd()} ${files.map(file => quote('./' + file)).join(' ')}` : 'true';
  const config = { ...state.config, gate: command, [VALUE_GATE]: true };
  return { config, files, subset: false, affectedGate: createHash('sha256').update(command).digest('hex') };
}

/** Return a complete source-matched proof union, or null when any item lacks one. */
export function submittedSelections(items, readEvents, readCriterion) {
  if (!items.length) return null;
  const files = new Set();
  for (const entry of items) {
    const event = readEvents(entry.id).findLast(row => row.event_kind === 'submit');
    let detail;
    try { detail = event ? JSON.parse(event.event_detail) : null; } catch { return null; }
    if (detail?.commit !== entry.commit || detail.gateGreen !== true || detail.submissionProof?.full === true || !Array.isArray(detail.submissionProof?.files)
      || detail.submissionProof.files.some(file => typeof file !== 'string' || !file)) return null;
    const criterion = readCriterion(entry, detail);
    if (!Array.isArray(criterion)) return null;
    for (const file of [...detail.submissionProof.files, ...criterion]) files.add(file);
  }
  return [...files].sort();
}

/** Derive only literal committed test files from the criterion bound to this submission. */
function criterionTestFiles(root, entry, item, runner, detail) {
  if (!item || item.item_commit !== entry.commit || typeof item.item_frozen !== 'string'
    || createHash('sha256').update(item.item_frozen).digest('hex') !== item.item_frozen_digest
    || Object.hasOwn(detail, 'criterionDigest') && detail.criterionDigest !== item.item_frozen_digest) return null;
  let frozen;
  try { frozen = JSON.parse(item.item_frozen); } catch { return null; }
  let check;
  try { check = mappedCheck(root, frozen.check, { commit: entry.commit }); } catch { return null; }
  const words = literalShellWords(check);
  if (!words?.length) return null;
  const prefix = literalShellWords(runner);
  const ownRunner = prefix?.length && prefix.every((word, index) => words[index] === word) ? prefix.length : 0;
  const node = /(?:^|\/)node(?:\.exe)?$/u.test(words[0]);
  const length = ownRunner || (node && (words[1] === '--test' || /(?:^|\/)bin\/run-tests\.js$/u.test(words[1] ?? '')) ? 2 : 0);
  if (!length || words.length <= length) return null;
  const files = [];
  for (const raw of words.slice(length)) {
    const file = raw.replace(/^\.\//u, '');
    if (!file || file.startsWith('/') || file.startsWith('-') || /[:\\*?\[\]\p{Cc}]/u.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')
      || !(/(?:^|\/)(?:test|tests)\//u.test(file) || /\.(?:test|spec)\.[cm]?js$/u.test(file))) return null;
    const result = tryGit(root, ['ls-tree', entry.commit, '--', file]);
    if (result.status !== 0 || !/^100(?:644|755) blob [a-f0-9]{40,64}\t/u.test(result.stdout)) return null;
    files.push(file);
  }
  return files;
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

/**
 * Smoke the candidate's own CLI on a scratch board once per tree, before its gate [C7].
 * Why here: every automatic landing (inline, local trunk, parallel candidate, and their bisections) gates its final
 * tree through gateGroup before publication, so this one boundary covers them all with no skip list.
 */
function smokeTree(state, tree) {
  state.smoked ??= new Set();
  if (state.smoked.has(tree)) return;
  runLandingCliSmoke(state.batch.root);
  state.smoked.add(tree);
}

/** Run one source-pinned gate or selective floor, retaining its complete immutable phase log. */
export async function gateGroup(state, label, options) {
  const tree = headTree(state.batch.root);
  smokeTree(state, tree);
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
  // One item's red is its own: a per-item landing never compares main [C7,#2901].
  const known = singleItemLanding(state) ? null : await knownMainAccount(state, result);
  if (known) { Object.assign(result, knownMainFields(result, known)); state.say(knownMainLine(known)); await save(state, { knownMain: known.known }); }
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

/**
 * The unit and contract files some batch item's exact submit already ran on the same test bytes and the same content of
 * every package the test covers, so landing reuses that proof (RFC 0006 A4).
 * Why: any other freshly selected unit, such as a contract that reached main after the submit, must run at landing.
 */
function submittedUnits(state, commit, readEvents = id => store.events(state.board, { itemId: id })) {
  const root = state.batch.root, proven = new Set();
  let manifest;
  try { manifest = JSON.parse(git(root, ['show', `${commit}:${TEST_TIERS_FILE}`], { maxBuffer: 256 * 1024 * 1024 })); } catch { return proven; }
  const rows = new Map((manifest?.files ?? []).map(row => [row.file, row]));
  const blob = (rev, file) => { try { return git(root, ['rev-parse', `${rev}:${file}`]).trim(); } catch { return null; } };
  for (const entry of state.batch.items) {
    const event = readEvents(entry.id).findLast((row) => row.event_kind === 'submit');
    const detail = event ? JSON.parse(event.event_detail) : null;
    const files = detail?.commit === entry.commit && detail.gateGreen === true ? detail.submissionProof?.files ?? [] : [];
    if (!files.length) continue;
    const [then, now] = packageHashesAt(root, [entry.commit, commit]);
    for (const file of files) {
      const row = rows.get(file);
      if (!row || proven.has(file) || blob(entry.commit, file) === null || blob(entry.commit, file) !== blob(commit, file)) continue;
      if (row.packages.every(name => then.get(name)?.hash === now.get(name)?.hash)) proven.add(file);
    }
  }
  return proven;
}

/** The affected test files each batch item's submission moved to the landing gate, read from its exact submit. */
export function deferredSelections(state, readEvents = id => store.events(state.board, { itemId: id })) {
  return state.batch.items.flatMap((entry) => {
    const event = readEvents(entry.id).findLast((row) => row.event_kind === 'submit');
    const detail = event ? JSON.parse(event.event_detail) : null;
    const files = detail?.commit === entry.commit ? detail.submissionProof?.deferredFiles ?? [] : [];
    return files.length ? [{ entry, files }] : [];
  });
}
