import { requireTestTierAccount } from '../../../gate/index.js';
import { hasTestTiers } from '../../../gate/index.js';
import { selectTestTiers } from '../../../gate/index.js';
import { requireSealedSkips } from '../../../gate/index.js';
import { landingRunFiles } from '../../../gate/index.js';
import { packageHashesAt } from '../../../gate/index.js';
import { TEST_TIERS_FILE } from '../../../gate/index.js';
import { testTierCommand } from '../../../gate/index.js';
import { VALUE_GATE } from '../../../gate/index.js';
import { gateStages } from '../../../gate/index.js';
import { blockingFailures } from '../../../verify/index.js';
/** Coordinator landing gate step; source-preserving partition of land.js [B3,R3,C7]. */
import { completeGate } from './landing-completion.js';
import { landingReceiptReuse } from './landing-receipt-reuse.js';
import { gateVerdictOf } from './main-red-receipt.js';
import { toolingFor } from '../../../pin/index.js';
import { runnerExecutionServices } from '../../../runners/index.js';
import { landingExecutionServices } from './landing-shards.js';
import { runLocalLandingGuard } from '../core/land-local-guard.js';
import { requireNoRunnerRefusalOnlyRed } from '../core/land-local-guard.js';
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
import { fileKnownMainReds } from './landing-known-main.js';
import { liveWaiverProjection } from './landing-step-failures.js';
import { mergeGroup } from './landing-step-merge.js';
import { timedPhase } from './landing-phase-timing.js';
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
  // No readable plan for some item falls back to selection over the merged change, then to the full gate; a missing
  // plan never stops landing, so repos whose checks are not literal Node test commands still land (#2897).
  const registry = selectRegistryGuards(root, state.config.registryGuards, { base: state.batch.base, git });
  const mandatory = [...new Set([...(state.config.submitInvariants ?? []), ...registry])].sort();
  const testTiers = selectTestTiers(root, { base: state.batch.base, commit, runner: state.config.affectedTests });
  if (testTiers) {
    requireSealedSkips(root, testTiers);
    const affected = submitted === null ? selectAffectedTests(root, { base: state.batch.base, commit }) : { files: submitted };
    if (affected.full && affected.reason !== 'the change reaches every test file') return { full: true, fullGate: true, reason: affected.reason, mandatory, files: [] };
    const named = new Set(affected.files);
    // A5 keeps proved units out; journeys and deferred files still need actual merged-tree reach.
    const files = landingRunFiles({ ...testTiers, journeys: testTiers.journeys.filter(file => named.has(file)) }, submittedUnits(state, commit, readEvents));
    const deferred = submitted === null ? deferredSelections(state, readEvents).flatMap(row => row.files).filter(file => named.has(file)) : [];
    const explicit = submitted?.filter(file => !testTiers.units.includes(file)) ?? [];
    return { full: false, mandatory, testTiers, files: [...new Set([...files, ...explicit, ...deferred, ...mandatory])].sort() };
  }
  // The submit's files are a floor: a later accepted-trunk importer of a file the merged batch changed is found only
  // on the merged tree, so its selection is added to the submitted union [C7,V4].
  let selection;
  if (!state.config.affectedTests) selection = submitted !== null ? { full: false, files: submitted } : { full: true, reason: 'affected-test selection is not enabled for this project', files: [] };
  else {
    const merged = selectAffectedTests(root, { base: state.batch.base, commit });
    selection = submitted === null ? merged : { ...merged, files: [...new Set([...submitted, ...merged.files])].sort() };
  }
  return { ...selection, mandatory, sourceProof: submitted !== null, files: [...new Set([...mandatory, ...selection.files])].sort() };
}

/**
 * The project's own full configured gate, used when no narrower plan can be established [#2897].
 * Why no VALUE_GATE mark: the command is the unchanged configured gate, so its green run stamps the tree and the
 * landing's own pre-push reads that stamp instead of running the whole gate a second time (#3137). With owed files the
 * command is no longer the configured gate, so it carries the mark like any affected plan.
 *
 * @param {any} state
 * @param {string[]} [owed] - deferred and invariant test files the plan must still run after the configured gate
 */
function fullGatePlan(state, owed = []) {
  const config = { ...state.config };
  const runner = state.config.affectedTests?.trim();
  if (!runner || !owed.length) return { config, files: [], subset: false, affectedGate: createHash('sha256').update(config.gate).digest('hex') };
  // Files a submit deferred to landing, and the submit invariants, are owed whatever the plan: a configured gate such
  // as `true` runs none of them, so an unselectable merged change (a badge file) landed with no deferred test run [C7].
  const files = [...new Set(owed)].sort();
  const command = `(\n${config.gate}\n) && ${runner} ${files.map(file => quote('./' + file)).join(' ')}`;
  return { config: { ...config, gate: command, [VALUE_GATE]: true }, files, subset: false, affectedGate: createHash('sha256').update(command).digest('hex') };
}

/** Bind each cached result to its exact full-gate or local-trunk guard plan. */
export function batchGatePlan(state, options = {}) {
  try { return selectedGatePlan(state, options); } catch (error) {
    // A per-item landing whose one item has no narrower readable plan runs the full configured gate instead of stopping [C7,#2901].
    if (!singleItemLanding(state) || error.code !== 'LAND_DIAGNOSTIC') throw error;
    return fullGatePlan(state);
  }
}

/**
 * Split a gate plan's files into the ones the per-item gate runs and the ones landing.auditOnly leaves to the
 * post-landing audit (a red there is filed as a main red minutes later). Why: the lifecycle audit alone was 64 s of
 * every one-item gate, and any source change selects it [C7].
 */
export function auditOnlySplit(config, files) {
  const auditOnly = new Set(config.landing?.auditOnly ?? []);
  const sorted = [...new Set(files)].sort();
  return { files: sorted.filter(file => !auditOnly.has(file)), left: sorted.filter(file => auditOnly.has(file)) };
}

/** The narrowest proved plan for the batch's merged tree, refusing LAND_DIAGNOSTIC when none can be read. */
function selectedGatePlan(state, { readEvents = id => store.events(state.board, { itemId: id }), readItem = id => store.getItem(state.board, id), focus = null } = {}) {
  // A bisection round runs only the files the batch failed: a half's whole plan took a full gate per round, and the
  // final green set still runs its whole plan before landing (#landOnTrunk). Why: a four-item bisect cost 15 minutes.
  if (focus?.length && state.config.affectedTests?.trim() && !hasTestTiers(state.batch.root)) {
    const files = [...new Set(focus)].sort();
    const command = `${state.config.affectedTests.trimEnd()} ${files.map(file => quote('./' + file)).join(' ')}`;
    return { config: { ...state.config, gate: command, [VALUE_GATE]: true }, files, subset: false, focused: true,
      affectedGate: createHash('sha256').update(`focus:${command}`).digest('hex') };
  }
  const selection = batchAffectedTests(state, readEvents, readItem);
  if (selection.fullGate) return fullGatePlan(state);
  if (selection.testTiers) {
    // This repository plans by test tiers, so landing.auditOnly applies here too (it did not on 6 Nov's first batch).
    const { files, left } = auditOnlySplit(state.config, selection.files);
    if (left.length) state.say?.(`left to the audit (landing.auditOnly): ${left.join(', ')}`);
    const command = testTierCommand(selection.testTiers, files) || 'true';
    return { config: { ...state.config, gate: command, [VALUE_GATE]: true }, files, subset: false, testTiers: true,
      affectedGate: createHash('sha256').update(command).digest('hex') };
  }
  const deferred = selection.sourceProof ? [] : deferredSelections(state, readEvents).flatMap(row => row.files);
  if (!state.config.affectedTests?.trim()) {
    // Projects without selective-runner policy keep their configured full gate. Its command is the legacy contract
    // for the project and already includes the item check (the source-matched proof was checked at submit).
    return { ...fullGatePlan(state), files: selection.files };
  }
  if (selection.full && selection.reason !== 'the change reaches every test file') {
    return deferred.length ? fullGatePlan(state, auditOnlySplit(state.config, [...selection.mandatory, ...deferred]).files) : fullGatePlan(state);
  }
  const { files, left } = auditOnlySplit(state.config, [...new Set([...selection.files, ...deferred])]);
  if (left.length) state.say?.(`left to the audit (landing.auditOnly): ${left.join(', ')}`);
  const affectedCommand = files.length ? `${state.config.affectedTests.trimEnd()} ${files.map(file => quote('./' + file)).join(' ')}` : 'true';
  // An opaque configured gate (one the stage reader cannot split) still runs, ahead of the affected phase, and no stage
  // of it is guessed: a waiver names only the affected phase's accounted failures [C7,V4].
  const command = !gateStages(state.config.gate) && files.length ? `(\n${state.config.gate}\n) && ${affectedCommand}` : affectedCommand;
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
  // No frozen check names no files: the submit proof alone is the plan. Why: null here voided the whole batch's plan
  // and sent every batch holding such an item to the full configured gate, 25 minutes that never completed [C7].
  if (typeof frozen?.check !== 'string' || !frozen.check.trim()) return [];
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
  runLandingCliSmoke(state.batch.root, { record: true });
  state.smoked.add(tree);
}

/** Run one source-pinned gate or selective floor and say how long it took, so a slow landing names its gate [C7]. */
export function gateGroup(state, label, options) {
  return timedPhase(state.say, 'gate', () => runGateGroup(state, label, options));
}

/**
 * The tooling tree that judges this landing (RFC 0007 SC8), or null when the pin is unreadable, so nothing is reused.
 *
 * @param {string} root - The batch worktree.
 * @param {string} commit - The composed candidate commit.
 * @returns {string | null} The tooling tree id.
 */
function landingTooling(root, commit) {
  try { return toolingFor(root, commit).tooling; } catch { return null; }
}

/** The paths that differ between two trees, or null when Git cannot say. */
function changedPathsBetween(root, from, to) {
  const result = tryGit(root, ['diff-tree', '-r', '--name-only', '-z', '--no-commit-id', from, to]);
  return result.status === 0 ? result.stdout.split('\0').filter(Boolean) : null;
}

/** Run one source-pinned gate or selective floor, retaining its complete immutable phase log. */
async function runGateGroup(state, label, options) {
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
  // A recorded run that was stopped before any test failed (every shard "stopped", no named failure) is no verdict:
  // an adopting worker reran nothing and refused LAND_DIAGNOSTIC on it, so the batch stays blocked on a run that never
  // finished [C7]. Only a complete run, or an incomplete one with its own named reds, is reused.
  if (cached && (completeGate(cached) || (cached.failures?.length > 0 && !coveredFailures(state, cached)))) return cached;
  // The submit's green receipt already proved this exact candidate on this exact base: landing records the reuse and runs nothing [C7, RFC 0007].
  const treeOf = rev => { const result = tryGit(state.batch.root, ['rev-parse', `${rev}^{tree}`]); return result.status === 0 ? result.stdout.trim() : null; };
  const reuse = landingReceiptReuse({ items: state.batch.items, readEvents: id => store.events(state.board, { itemId: id }), tree, base: state.batch.base, tooling: landingTooling(state.batch.root, commit), full: config[VALUE_GATE] !== true, files, treeOf,
    generated: state.landingWrites ?? [], changedPaths: (from, to) => changedPathsBetween(state.batch.root, from, to), verdictOf: (item, candidate) => gateVerdictOf(state.board, item, candidate) });
  if (reuse.reuse) {
    state.say(`gate ${label}: reused #${reuse.item}'s submit receipt for tree ${tree.slice(0, 12)}; no test run started`);
    // A verdict recorded green by the main-owned rule keeps its cases owned by main, never charged to the item [C7,#3534,#3685].
    if (reuse.mainOwned) state.say(`gate ${label}: #${reuse.item}'s submit verdict is green with main-owned case(s): ${reuse.mainOwned.map(row => `${row.file} :: ${row.name}`).join('; ')}`);
    const reused = { isGreen: true, failures: [], accounted: [], complete: true, requiresGreen: false, tree, logPath: null, affectedGate, reusedReceipt: { item: reuse.item, commit: reuse.commit, ...(reuse.mainOwned ? { mainOwned: reuse.mainOwned } : {}) } };
    state.gates.set(tree, reused);
    return reused;
  }
  if (reuse.code !== 'BATCH_OF_MANY' && reuse.code !== 'NO_RECEIPT') state.say(`gate ${label}: submit receipt not reused (${reuse.code}); running the gate`);
  const directory = join(dirname(state.batch.root), 'logs');
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, `${label}-${state.batch.revision}.log`);
  state.say(`gate ${label}: saving the gating record`);
  await save(state, { state: 'gating', tip: headCommit(state.batch.root), logPath });
  state.say(`gate ${label}: gating record saved`);
  const onFailure = landingRunObserver(state, config, commit);
  const quarantines = state.landingPorts.quarantineVerdictSnapshot(state.board);
  const item = store.getItem(state.board, state.batch.items[0].id);
  const proofContext = { item: item.item_id, frozenDigest: item.item_frozen_digest, seat: 'coordinator', kind: 'land' };
  state.say(`gate ${label}: ${subset ? `${files.length} files` : 'the full plan'} selected; running`);
  const gate = subset
    ? await runLocalLandingGuard(state.batch.root, config, { files, directory, label, onWait: state.onWait,
      waivers: liveWaiverProjection(state.board, state.landingPorts), onFailure, quarantines, proofContext })
    // Every file runs to completion: a fail-fast stop at main's first known red left the rest unrun, so the gate could
    // never be compared with main and one red test blocked every landing [C7,#3167].
    : await runGate(state.batch.root, config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, trustStamp: false, landing: true, collectAll: true, agent: 'coordinator', onWait: state.onWait,
      stages: true, waivers: liveWaiverProjection(state.board, state.landingPorts), onFailure, quarantines, proofContext });
  state.say(`gate ${label}: run finished ${gate.isGreen ? 'green' : 'red'}`);
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
  // A red run whose only non-green shards are runner refusals decided nothing: it is retried as a landing fault and
  // never reaches diagnosis or the repeat guard [C7,#3693].
  requireNoRunnerRefusalOnlyRed({ ...gate, failures, logPath });
  const result = { ...gate, failures, accounted: blockingFailures(gate, accountedFailures(gate, state.batch.root)), complete: completeGate(gate),
    requiresGreen: Boolean(cached && !completeGate(cached)), tree, logPath, affectedGate };
  // An item lands unless its own change breaks a case that passes on main, so every landing compares main [C7,#3073]:
  // cases red there too are filed as Main red and never charged to the items.
  const known = await knownMainAccount(state, result);
  // A per-item landing cannot tell its item's red from main's without the comparison: it blocks as a landing fault and
  // the verified item stays verified, never reopened on a guess [C7,#3065].
  if (singleItemLanding(state) && known?.unavailable?.length) {
    throw new Refused('LAND_MAIN_COMPARISON', `the per-item landing could not compare its red cases with base main ${state.batch.base.slice(0, 12)} (${known.unavailable.join('; ')}); retry the landing once main can run those files`);
  }
  if (known?.known.length) { Object.assign(result, knownMainFields(result, known)); state.say(knownMainLine(known)); await save(state, { knownMain: known.known, mainRedRepairs: await fileKnownMainReds(state, known.known) }); }
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
