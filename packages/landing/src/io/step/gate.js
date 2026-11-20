import { affectedCommand as affectedTestsCommand } from '../../../../gate/heavy.js';
import { requireTestTierAccount } from '../../../../gate/heavy.js';
import { hasTestTiers } from '../../../../gate/heavy.js';
import { selectTestTiers } from '../../../../gate/heavy.js';
import { requireSealedSkips } from '../../../../gate/heavy.js';
import { landingRunFiles } from '../../../../gate/heavy.js';
import { testTierCommand } from '../../../../gate/heavy.js';
import { VALUE_GATE } from '../../../../gate/heavy.js';
import { gateStages } from '../../../../gate/heavy.js';
import { detectLanguages } from '../../../../gate/heavy.js';
import { blockingFailures } from '../../../../verify/index.js';
/** Coordinator landing gate step; source-preserving partition of land.js [B3,R3,C7]. */
import { completeGate } from '../completion.js';
import { runnerExecutionServices } from '../../../../runners/index.js';
import { landingExecutionServices } from '../shards.js';
import { runLocalLandingGuard } from '../land/guard.js';
import { requireNoRunnerRefusalOnlyRed } from '../land/guard.js';
import { pipelineBase } from './base.js';
import { createHash } from 'node:crypto';
import { copyFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import * as store from '../../../../store/index.js';
import { git } from '../../../../git/index.js';
import { tryGit } from '../../../../git/index.js';
import { headCommit } from '../../../../git/index.js';
import { headTree } from '../../../../git/index.js';
import { isClean } from '../../../../git/index.js';
import { runGate } from '../../../../gate/heavy.js';
import { runProfiledShellAsync } from '../../../../gate/heavy.js';
import { pinRunMain } from '../../../../gate/heavy.js';
import { withLandingGateSlot } from '../../../../gate/heavy.js';
import { landingControllerPlacement } from '../../../../gate/heavy.js';
import { testsNeedBrowser } from '../../../../gate/heavy.js';
import { testsNeedGui } from '../../../../gate/heavy.js';
import { runStaticChecks } from '../../../../gate/heavy.js';
import { readGateReceipt } from '../../../../gate/heavy.js';
import { receiptStore } from '../../../../gate/heavy.js';
import { selectAffectedTests } from '../../../../gate/heavy.js';
import { ledgerFromOutput } from '../../../../gate/heavy.js';
import { selectRegistryGuards } from '../../../../kernel/index.js';
import { literalShellWords } from '../../../../kernel/index.js';
import { mappedCheck } from '../../../../codemap/index.js';
import { laneOf } from '../../../../seats/index.js';
import { Refused } from '../../../../kernel/index.js';
import { environmentLabel } from '../../../../sandbox/index.js';
import { landingFileTimes } from '../../../../items/index.js';
import { environmentWarnings } from './selection.js';
import { singleItemLanding } from './selection.js';
import { smokeCandidate } from '../smoke.js';
import { landingFailures } from './failures.js';
import { save } from './merge.js';
import { coveredFailures } from './failures.js';
import { accountedFailures } from './failures.js';
import { knownMainAccount } from '../known/main.js';
import { knownMainFields } from '../known/main.js';
import { knownMainLine } from '../known/main.js';
import { fileKnownMainReds } from '../known/main.js';
import { liveWaiverProjection } from './failures.js';
import { mergeGroup } from './merge.js';
import { sayGateSplit } from '../timing.js';
import { timedPhase } from '../timing.js';
import { landingOperations } from './merge.js';
import { gateComponentTier } from '../../../../config/index.js';
import { gateJunitReport } from '../../../../config/index.js';
import { landingJunitFailures } from '../../../../config/index.js';
import { landingCargoFailures } from '../../../../config/index.js';
import { readJunitReport } from './junit-report.js';
import { carriedMainOutcome } from '../main/red.js';

/** The gate functions the local landing guard calls, passed to it so its logic file never imports the gate door [C7,#8567]. */
const GUARD_PORTS = Object.freeze({ runProfiledShellAsync, pinRunMain, withLandingGateSlot, landingControllerPlacement, testsNeedBrowser, testsNeedGui, runnerExecutionServices, landingExecutionServices });

/**
 * The ports of the Sprint proof on the batch's tip: the changed paths, the code that ran, the static checks and one cell's own tests [V37].
 * Why here: the static checks and the guard's runner placement are this step's; the proof file imports nothing.
 * A cell with no test file has nothing to run and is green; the tests run under the guard's slot, on a runner when the machine is runners-only.
 */
export function sprintPorts(state) {
  const root = state.batch.root;
  const directory = join(dirname(root), 'logs');
  let plan;
  /** Run the tests of these files under the guard's slot: a cell with no test file has nothing to run and is green. */
  const runFiles = async (files, label, { required = false } = {}) => {
    const command = plan?.tiers ? testTierCommand(plan.tiers, files) : state.config.affectedTests?.trim() && files.length ? affectedTestsCommand(state.config, files) : '';
    if (!command) return required && files.length ? { isGreen: false, output: 'no test command is configured (affectedTests), so these test files cannot run' } : { isGreen: true };
    mkdirSync(directory, { recursive: true });
    const run = await runLocalLandingGuard(root, { ...state.config, gate: command, [VALUE_GATE]: true }, { files, directory, label,
      onWait: state.onWait, waivers: [], onFailure: async () => {}, quarantines: [], proofContext: undefined }, GUARD_PORTS);
    return { isGreen: run.isGreen === true, output: run.output };
  };
  /** The tier plan of the changed packages, read once; a repository without tiers selects by import reach [V37]. */
  const tiers = () => (plan ??= { tiers: selectTestTiers(root, { base: state.batch.base, commit: state.batch.tip, runner: state.config.affectedTests, componentTier: gateComponentTier() }) });
  return {
    // landing.sprintBarTests on: the batch items' frozen bar tests run on this exact tree besides the cells' own tests [U147].
    ...(state.config.landing?.sprintBarTests === true ? { runBar: barTestPort(state, (files, label, options) => { tiers(); return runFiles(files, label, options); }) } : {}),
    changedFiles: () => git(root, ['diff', '--no-renames', '--name-only', state.batch.base, state.batch.tip]).split('\n').filter(Boolean),
    pin: () => headCommit(state.root),
    runStatic: () => runStaticChecks(root, state.config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() },
      agent: 'coordinator', onWait: state.onWait, runnerAdmission: { landing: true, itemCheck: false, shortEligible: false } })
      .then(run => ({ isGreen: run === null || run.isGreen !== false, output: run?.output }), error => ({ isGreen: false, output: error?.message })),
    runCell: async cell => {
      // The change's own cells are the units the tier plan selects for the changed packages; a repository without tiers selects by import reach [V37].
      tiers();
      const named = plan.tiers ? plan.tiers.units : (plan.reach ??= selectAffectedTests(root, { base: state.batch.base, commit: state.batch.tip, suites: state.config.affectedSuites }).files);
      const run = await runFiles(named.filter(file => file.startsWith(`${cell}/`)), `sprint-${cell.replace('/', '-')}`);
      return run.isGreen ? run : { ...run, files: [...new Set(landingFailures(run.output ?? '', root).map(failure => failure.file).filter(Boolean))] };
    },
    // One rerun of a red file on the same tree, and main's own receipt for that file: the flake rule of the Sprint proof [V37].
    rerunFile: file => runFiles([file], `sprint-rerun-${file.replace(/[^a-z0-9]+/giu, '-').slice(-40)}`),
    mainReceipt: file => {
      const outcome = carriedMainOutcome(state.root, file)?.files[0];
      return outcome ? { result: outcome.result, main: outcome.main, receiptId: outcome.receiptId } : null;
    },
  };
}

/**
 * The Sprint proof's bar-test port: the union of every batch item's frozen bar test files, run once on the exact staged tree [U147].
 * Why: the white paper's "proven" is the exact tree that lands passing the tests frozen with the bar; the cells' own files cannot say that.
 * An item whose frozen bar names no readable file list, or a named file the staged tree lacks, or no test command, is refused naming the item (and file).
 * The item and event readers come from the state when it carries them (a test's board), else the board.
 *
 * @param {any} state The landing state.
 * @param {(files: string[], label: string, options?: { required?: boolean }) => Promise<{ isGreen: boolean, output?: string }>} runFiles Runs the files under the guard's slot.
 */
export function barTestPort(state, runFiles) {
  const root = state.batch.root;
  const readItem = state.readItem ?? (id => store.getItem(state.board, id));
  const readEvents = state.readEvents ?? (id => store.events(state.board, { itemId: id }));
  return async () => {
    const items = [];
    for (const entry of state.batch.items) {
      let detail = {};
      try { detail = JSON.parse(readEvents(entry.id).findLast(row => row.event_kind === 'submit')?.event_detail ?? '{}') ?? {}; } catch { detail = {}; }
      const files = criterionTestFiles(root, entry, readItem(entry.id), state.config.affectedTests, detail);
      if (files === null) return { isGreen: false, refused: true, item: entry.id, items, output: `the frozen bar of item #${entry.id} names no readable list of test files` };
      const absent = files.find(file => !existsSync(join(root, file)));
      if (absent) return { isGreen: false, refused: true, item: entry.id, file: absent, items, output: `the frozen bar test ${absent} of item #${entry.id} is missing from the staged tree` };
      items.push({ item: entry.id, files });
    }
    const union = [...new Set(items.flatMap(row => row.files))].sort();
    if (!union.length) return { isGreen: true, items };
    const run = await runFiles(union, 'sprint-bar', { required: true });
    if (run.isGreen) return { isGreen: true, items };
    const red = [...new Set(landingFailures(run.output ?? '', root).map(failure => failure.file).filter(Boolean))];
    if (!red.length) return { isGreen: false, refused: true, item: items[0].item, items, output: run.output };
    return { ...run, items, files: red };
  };
}

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
  const testTiers = selectTestTiers(root, { base: state.batch.base, commit, runner: state.config.affectedTests, componentTier: gateComponentTier() });
  if (testTiers) {
    requireSealedSkips(root, testTiers);
    // The README badge files the landing itself writes select nothing; counted as changes they sent the whole batch to
    // the full gate, which runs every unit the submits already proved [C7].
    const badges = new Set((state.landingWrites ?? []).filter(file => /^docs\/badges\/[^/]+\.json$/u.test(file)));
    const changed = badges.size ? git(root, ['diff', '--no-renames', '--name-only', '-z', state.batch.base, commit]).split('\0').filter(file => file && !badges.has(file)) : undefined;
    const affected = submitted === null ? selectAffectedTests(root, { base: state.batch.base, commit, suites: state.config.affectedSuites, ...(changed ? { changed } : {}) }) : { files: submitted };
    if (affected.full && affected.reason !== 'the change reaches every test file') {
      // One item's own submit proof is its floor: a landing never falls to the full plan for it, which on a runners-only
      // machine runs every test on one runner and cannot finish [C7].
      const own = state.batch.items.length === 1 ? submitProofFiles(state.batch.items[0], readEvents) : null;
      if (!own) return { full: true, fullGate: true, reason: affected.reason, mandatory, files: [] };
      return { full: false, mandatory, testTiers, files: [...new Set([...own, ...mandatory])].sort() };
    }
    const named = new Set(affected.files);
    // A5 keeps proved units out; journeys and deferred files still need actual merged-tree reach.
    const files = landingRunFiles({ ...testTiers, journeys: testTiers.journeys.filter(file => named.has(file)) }, new Set());
    const deferred = submitted === null ? deferredSelections(state, readEvents).flatMap(row => row.files).filter(file => named.has(file)) : [];
    const explicit = submitted?.filter(file => !testTiers.units.includes(file)) ?? [];
    return { full: false, mandatory, testTiers, journeys: testTiers.journeys.filter(file => named.has(file)), proved: submitted ?? [],
      files: [...new Set([...files, ...explicit, ...deferred, ...mandatory])].sort() };
  }
  // The submit's files are a floor: a later accepted-trunk importer of a file the merged batch changed is found only
  // on the merged tree, so its selection is added to the submitted union [C7,V4].
  let selection;
  if (!state.config.affectedTests) selection = submitted !== null ? { full: false, files: submitted } : { full: true, reason: 'affected-test selection is not enabled for this project', files: [] };
  else {
    const merged = selectAffectedTests(root, { base: state.batch.base, commit, suites: state.config.affectedSuites });
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
  const command = `(\n${config.gate}\n) && ${affectedTestsCommand({ affectedTests: runner }, files)}`;
  return { config: { ...config, gate: command, [VALUE_GATE]: true }, files, subset: false, affectedGate: createHash('sha256').update(command).digest('hex') };
}

/**
 * Bind each cached result to its exact full-gate or local-trunk guard plan. A plan read with the board's own readers is
 * kept on the state for its tree, base, items and focus, so a candidate's gate claim and its gate share one selection.
 * Why: each selection walks every test's import closure, about 20 s on this repository, and a candidate made it twice
 * before its gate started on 9 Nov [C7].
 */
export function batchGatePlan(state, options = {}) {
  const key = Object.keys(options).every(name => name === 'focus') ? planKey(state, options.focus) : null;
  if (key && state.plans?.has(key)) return state.plans.get(key);
  const plan = choosePlan(state, options);
  if (key) (state.plans ??= new Map()).set(key, plan);
  return plan;
}

/** The key a kept plan is filed under, or null when the batch's tree cannot be read, so nothing is kept. */
function planKey(state, focus) {
  try { return JSON.stringify([headTree(state.batch.root), state.batch.base, state.batch.items.map(entry => [entry.id, entry.commit]), focus ?? null]); }
  catch { return null; }
}

/**
 * Whether the landing pushes the remote main itself: the default shape, every project without landing.publish
 * "separate" (landsOnTrunk in publish.js, which imports this file). Why: 0.9.3's promise is that the remote main only
 * gets a tree that passed the whole suite, so this shape lands only on whole-suite proof [C7,#6271].
 */
function pushesOnLanding(config) {
  return config?.landing?.publish !== 'separate';
}

/** The plan batchGatePlan keeps: the selected plan, or the full gate for a per-item landing with no narrower plan. */
function choosePlan(state, options) {
  // The default shape pushes what it lands, so a landing that cannot reuse a whole-suite receipt runs the whole
  // configured gate on the merged tree; a bisection round keeps its focus, its final tree still runs this plan [C7,#6271].
  if (pushesOnLanding(state.config) && !options.focus?.length) return fullGatePlan(state);
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
    const command = affectedTestsCommand(state.config, files);
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
      journeys: (selection.journeys ?? []).filter(file => files.includes(file)), proved: selection.proved ?? [],
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
  const affectedCommand = files.length ? affectedTestsCommand(state.config, files) : 'true';
  // An opaque configured gate (one the stage reader cannot split) still runs, ahead of the affected phase, and no stage
  // of it is guessed: a waiver names only the affected phase's accounted failures [C7,V4].
  const command = !gateStages(state.config.gate) && files.length ? `(\n${state.config.gate}\n) && ${affectedCommand}` : affectedCommand;
  const config = { ...state.config, gate: command, [VALUE_GATE]: true };
  return { config, files, subset: false, affectedGate: createHash('sha256').update(command).digest('hex') };
}

/**
 * Whether a submit event records a proving gate: green, or red only in the cases main fails the same way, which the
 * submit recorded as its knownMainFailures and was admitted on.
 * Why: such a submit records gateGreen false, so its proof files were ignored, selection over the merged change fell to
 * the full plan, and #3489's runners-only landing gate ran every test on one runner until the 10-minute stop (9 Nov) [C7].
 *
 * @param {any} detail - The submit event's detail.
 * @returns {boolean}
 */
export function submitProved(detail) {
  if (detail?.gateGreen === true) return true;
  return detail?.gateGreen === false && Array.isArray(detail.submissionProof?.knownMainFailures?.failures)
    && detail.submissionProof.knownMainFailures.failures.length > 0
    && detail.submissionProof.knownMainFailures.failures.every(row => typeof row?.file === 'string' && row.file);
}

/** Return a complete source-matched proof union, or null when any item lacks one. */
export function submittedSelections(items, readEvents, readCriterion) {
  if (!items.length) return null;
  const files = new Set();
  for (const entry of items) {
    const event = readEvents(entry.id).findLast(row => row.event_kind === 'submit');
    let detail;
    try { detail = event ? JSON.parse(event.event_detail) : null; } catch { return null; }
    if (detail?.commit !== entry.commit || !submitProved(detail) || detail.submissionProof?.full === true || !Array.isArray(detail.submissionProof?.files)
      || detail.submissionProof.files.some(file => typeof file !== 'string' || !file)) return null;
    const criterion = readCriterion(entry, detail);
    if (!Array.isArray(criterion)) return null;
    for (const file of [...detail.submissionProof.files, ...criterion]) files.add(file);
  }
  return [...files].sort();
}

/** The test files one item's exact submit proved, or null when its submit names none or proved the full suite. */
function submitProofFiles(entry, readEvents) {
  const event = readEvents(entry.id).findLast(row => row.event_kind === 'submit');
  let detail;
  try { detail = event ? JSON.parse(event.event_detail) : null; } catch { return null; }
  const files = detail?.commit === entry.commit && submitProved(detail) && detail.submissionProof?.full !== true ? detail.submissionProof?.files : null;
  return Array.isArray(files) && files.length && files.every(file => typeof file === 'string' && file) ? files : null;
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
  const length = ownRunner || (node && (words[1] === '--test' || /(?:^|\/)(?:bin\/run-tests|(?:packages\/gate|apps\/cli)\/src\/io\/run\/tests)\.js$/u.test(words[1] ?? '')) ? 2 : 0);
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
async function smokeTree(state, tree) {
  state.smoked ??= new Set();
  if (state.smoked.has(tree)) return;
  // With gate.runnersOnly on, the smoke queues for a runner like the gate itself (#3011).
  await timedPhase(state.say, 'cli smoke', () => smokeCandidate(state.batch.root, { record: true }));
  state.smoked.add(tree);
}

/** Run one source-pinned gate or selective floor and say how long it took, so a slow landing names its gate [C7]. */
export function gateGroup(state, label, options) {
  return timedPhase(state.say, 'gate', () => runGateGroup(state, label, options));
}

/**
 * The one language a project root is gated in, or null when it has none, several, or one per folder.
 * Why: a JUnit row maps a case to a file by its language, and a guess in a multi-language repo would name the wrong file [C7,#10591].
 */
export function landingJunitLanguage(root) {
  const entries = detectLanguages(root);
  const languages = new Set(entries.map(entry => entry.language));
  return languages.size === 1 && entries.every(entry => !entry.folder) ? entries[0].language : null;
}

/** Run one source-pinned gate or selective floor, retaining its complete immutable phase log. */
async function runGateGroup(state, label, options) {
  const tree = headTree(state.batch.root);
  await smokeTree(state, tree);
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
  state.say(`gate ${label}: ${subset || config[VALUE_GATE] === true ? `${files.length} files` : 'the full plan'} selected; running`);
  const gate = await (subset
    ? runLocalLandingGuard(state.batch.root, config, { files, directory, label, onWait: state.onWait,
      waivers: liveWaiverProjection(state.board, state.landingPorts), onFailure, quarantines, proofContext }, GUARD_PORTS)
    // Every file runs to completion: a fail-fast stop at main's first known red left the rest unrun, so the gate could
    // never be compared with main and one red test blocked every landing [C7,#3167].
    : runGate(state.batch.root, config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, trustStamp: false, landing: true, collectAll: true, agent: 'coordinator', onWait: state.onWait,
      stages: true, waivers: liveWaiverProjection(state.board, state.landingPorts), onFailure, quarantines, proofContext, shard: landingGateShard(state, files) }));
  // The gate job's marks split the gate phase: submitted is queued, need or ready is the runner's claim, done is the result [C7,B3].
  sayGateSplit(state.say, { queuedAt: gate.phases?.submitted, claimedAt: gate.phases?.need ?? gate.phases?.ready, resultAt: gate.phases?.done });
  state.say(`gate ${label}: run finished ${gate.isGreen ? 'green' : 'red'}`);
  state.say(`gate ${label}: ${runLedger(gate.log)}`);
  if (testTiers) requireTestTierAccount(gate, files);
  if (subset && gate.proofReceiptId) await recordLandingRun(state, gate.proofReceiptId);
  if (gate.blockingVerdict) state.landingPorts.validateQuarantineGate(state.board, { ...gate, tree });
  copyFileSync(gate.log, logPath);
  if (gate.profilePath) copyFileSync(gate.profilePath, `${logPath}.profile.json`);
  if (headCommit(state.batch.root) !== commit || headTree(state.batch.root) !== tree || !isClean(state.batch.root)) {
    throw new Refused('LAND_SOURCE_CHANGED', `the landing source changed while the gate ran; inspect ${logPath} and restore the recorded batch before adopting`);
  }
  // With landing.junitFailures on and gate.junitReport set, the report names failing cases too; a report that cannot be
  // read is recorded and the output parse stands, never a refusal of the step [C7].
  const reportPath = landingJunitFailures() ? gateJunitReport() : null;
  const report = reportPath ? readJunitReport(state.batch.root, reportPath) : null;
  if (report?.code || report?.unreadable?.length) state.say(`gate ${label}: JUnit report ${reportPath} ${report.code ? `not used (${report.code}); parsing the output` : `skipped ${report.unreadable.join(', ')}`}`);
  const junit = { ...(report?.xml ? { junitFailures: true, junitXml: report.xml, junitLanguage: landingJunitLanguage(state.batch.root) } : {}), cargoFailures: landingCargoFailures() };
  const failures = blockingFailures(gate, landingFailures(gate.output, state.batch.root, junit));
  if (!failures) throw new Refused('LAND_DIAGNOSTIC', 'the gate lost its complete native quarantine failure account');
  // A red run whose only non-green shards are runner refusals decided nothing: it is retried as a landing fault and
  // never reaches diagnosis or the repeat guard [C7,#3693].
  requireNoRunnerRefusalOnlyRed({ ...gate, failures, logPath });
  const result = { ...gate, failures, ...(report?.code ? { junitCode: report.code } : {}), accounted: blockingFailures(gate, accountedFailures(gate, state.batch.root)), complete: completeGate(gate),
    requiresGreen: Boolean(cached && !completeGate(cached)), tree, logPath, affectedGate };
  // An item lands unless its own change breaks a case that passes on main, so every landing compares main [C7,#3073]:
  // cases red there too are filed as Main red and never charged to the items.
  const known = await knownMainAccount(state, result);
  // A per-item landing cannot tell its item's red from main's without the comparison: it blocks as a landing fault and
  // the verified item stays verified, never reopened on a guess [C7,#3065]. With no focused runner configured (the init
  // default) no comparison can ever run, so the per-item rule holds: the one item's red is its own and goes back to its
  // builder; parked, nobody could move it [C7,#6270].
  if (singleItemLanding(state) && known?.unavailable?.length && state.config.affectedTests?.trim()) {
    throw new Refused('LAND_MAIN_COMPARISON', `the per-item landing could not compare its red cases with base main ${state.batch.base.slice(0, 12)} (${known.unavailable.join('; ')}); retry the landing once main can run those files`);
  }
  if (known?.known.length) { Object.assign(result, knownMainFields(result, known)); state.say(knownMainLine(known)); await save(state, { knownMain: known.known, mainRedRepairs: await fileKnownMainReds(state, known.known) }); }
  state.gates.set(tree, result);
  const evidence = state.batch.invariantEvidence ?? { version: 1, gates: [], diagnostics: [] };
  const tested = { commit, isGreen: gate.isGreen && completeGate(gate),
    submissions: state.batch.items.map(({ id, commit }) => ({ id, commit })),
    failures: [...new Set((gate.blockingVerdict ? failures : landingFailures(gate.output, state.batch.root, { excludeCancelled: true, ...junit })).map(failure => failure.file).filter(Boolean))],
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

/**
 * Start the static checks on the candidate's tree beside its gate. Their green receipt is keyed by tree, so the
 * batch's trunk guards on this same tree cite it instead of queuing a second runner job after the gate; a red or
 * failed run records nothing here and the trunk guards run and refuse as before.
 * Why: the trunk's static checks waited 80 to 230 s on a runner after a green candidate gate on 9 Nov [C7].
 */
function earlyStaticChecks(state) {
  return timedPhase(state.say, 'static checks', () => runStaticChecks(state.batch.root, state.config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() },
    agent: 'coordinator', onWait: state.onWait, runnerAdmission: { landing: true, itemCheck: false, shortEligible: false } }))
    .catch(() => null); // The trunk guards rerun a red or failed static check and refuse with its output.
}

/**
 * The rerun files a landing gate may fan out over runner slots, with the command that runs a subset of them under the
 * focused runner; the gate shards only when that command over every file is exactly the gate's command [C7].
 *
 * @param {any} state
 * @param {string[]} files - The plan's files.
 * @returns {{ files: string[], filesCommand: (files: string[]) => string, say: (line: string) => void } | null}
 */
export function landingGateShard(state, files) {
  const runner = state.config.affectedTests?.trimEnd();
  if (!runner || !Array.isArray(files) || files.length < 2) return null;
  return { files: [...files], filesCommand: batch => affectedTestsCommand({ affectedTests: runner }, batch), say: line => state.say?.(line) };
}

/** Merge and test one speculative prefix without giving its worker publication authority. */
export async function runLandingCandidate({ root, board, config, batch, entries, write, say, onWait, checkLease, checkLeaseNow, claimGate, finishGate, checkAtCommit, landingPorts }) {
  landingPorts = landingOperations(landingPorts);
  await checkLease();
  if (!existsSync(batch.root)) {
    mkdirSync(dirname(batch.root), { recursive: true });
    checkLeaseNow();
    git(root, ['worktree', 'add', '--detach', batch.root, pipelineBase({ config, board }, batch)]);
  }
  board.quarantineEnabled = () => config.flakes?.quarantine === true;
  const state = { root, board, config, batch, write, say, onWait, checkLease, checkLeaseNow, checkAtCommit, landingPorts,
    culprits: [], flaky: false, gates: new Map(), diagnosed: new Map() };
  // With landing.pipeline on, the batch gates on main plus the earlier batch's merge; its record names that base [C7,#8937].
  const base = pipelineBase(state, batch);
  if (base !== batch.base) await save(state, { base });
  const build = await mergeGroup(state, entries);
  await save(state, { ...build });
  // A conflicting prefix is not its requested composition. Never test the smaller accidental tree.
  if (build.conflicts.length || !build.items.length) return { batch: state.batch, gate: null };
  const tree = headTree(batch.root);
  const claimed = await claimGate(tree, batchGatePlan(state).affectedGate);
  if (claimed.previous) state.gates.set(tree, claimed.previous);
  if (claimed.cached?.blockingVerdict) state.landingPorts.validateQuarantineGate(state.board, claimed.cached);
  const staticChecks = claimed.cached ? null : earlyStaticChecks(state);
  const gate = claimed.cached ?? { ...await gateGroup(state, 'candidate'), proofRoot: state.batch.root, proofCommit: headCommit(state.batch.root) };
  await staticChecks;
  if (!claimed.cached) await finishGate(tree, gate);
  await save(state, { state: gate.isGreen ? 'ready' : 'blocked' });
  return { batch: state.batch, gate };
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

/**
 * The reuse ledger line of a finished gate's log, or a line saying the log holds none. Why: reuse fails open, and a
 * landing that reused nothing looked only slow until this line named its keyless files and why (#5839).
 */
function runLedger(log) {
  let output = '';
  try { output = readFileSync(log, 'utf8'); } catch { /* An unreadable log reports no account below. */ }
  return ledgerFromOutput(output) ?? 'ledger: the run log holds no per-file reuse account';
}
