import { requireTestTierAccount } from '../../../../gate/index.js';
import { hasTestTiers } from '../../../../gate/index.js';
import { selectTestTiers } from '../../../../gate/index.js';
import { requireSealedSkips } from '../../../../gate/index.js';
import { landingRunFiles } from '../../../../gate/index.js';
import { packageHashesAt } from '../../../../gate/index.js';
import { TEST_TIERS_FILE } from '../../../../gate/index.js';
import { testTierCommand } from '../../../../gate/index.js';
import { VALUE_GATE } from '../../../../gate/index.js';
import { gateStages } from '../../../../gate/index.js';
import { blockingFailures } from '../../../../verify/index.js';
/** Coordinator landing gate step; source-preserving partition of land.js [B3,R3,C7]. */
import { completeGate } from '../completion.js';
import { landingReceiptReuse } from '../reuse.js';
import { landingSpan } from '../../../../resources/index.js';
import { reusableSubmitFiles } from '../reuse.js';
import { gateVerdictOf } from '../main/red/receipt.js';
import { toolingFor } from '../../../../pin/index.js';
import { runnerExecutionServices } from '../../../../runners/index.js';
import { landingExecutionServices } from '../shards.js';
import { runLocalLandingGuard } from '../../logic/land/guard.js';
import { requireNoRunnerRefusalOnlyRed } from '../../logic/land/guard.js';
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
import { runGate } from '../../../../gate/index.js';
import { stampGreen } from '../../../../gate/index.js';
import { runStaticChecks } from '../../../../gate/index.js';
import { readGateReceipt } from '../../../../gate/index.js';
import { receiptStore } from '../../../../gate/index.js';
import { selectAffectedTests } from '../../../../gate/index.js';
import { testClosures } from '../../../../gate/index.js';
import { ledgerFromOutput } from '../../../../gate/index.js';
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
import { timedPhase } from '../timing.js';
import { landingOperations } from './merge.js';

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
    // The README badge files the landing itself writes select nothing; counted as changes they sent the whole batch to
    // the full gate, which runs every unit the submits already proved [C7].
    const badges = new Set((state.landingWrites ?? []).filter(file => /^docs\/badges\/[^/]+\.json$/u.test(file)));
    const changed = badges.size ? git(root, ['diff', '--no-renames', '--name-only', '-z', state.batch.base, commit]).split('\0').filter(file => file && !badges.has(file)) : undefined;
    const affected = submitted === null ? selectAffectedTests(root, { base: state.batch.base, commit, ...(changed ? { changed } : {}) }) : { files: submitted };
    if (affected.full && affected.reason !== 'the change reaches every test file') {
      // One item's own submit proof is its floor: a landing never falls to the full plan for it, which on a runners-only
      // machine runs every test on one runner and cannot finish [C7].
      const own = state.batch.items.length === 1 ? submitProofFiles(state.batch.items[0], readEvents) : null;
      if (!own) return { full: true, fullGate: true, reason: affected.reason, mandatory, files: [] };
      return { full: false, mandatory, testTiers, files: [...new Set([...own, ...mandatory])].sort() };
    }
    const named = new Set(affected.files);
    // A5 keeps proved units out; journeys and deferred files still need actual merged-tree reach.
    const files = landingRunFiles({ ...testTiers, journeys: testTiers.journeys.filter(file => named.has(file)) }, submittedUnits(state, commit, readEvents));
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

/** The plan batchGatePlan keeps: the selected plan, or the full gate for a per-item landing with no narrower plan. */
function choosePlan(state, options) {
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
  const affectedCommand = files.length ? `${state.config.affectedTests.trimEnd()} ${files.map(file => quote('./' + file)).join(' ')}` : 'true';
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
  await landingSpan('smoke', () => smokeCandidate(state.batch.root, { record: true }));
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

/**
 * The closure port of a tiered landing's receipt reuse: the plan's candidate test files (every test when the plan is the
 * full gate) and whether a changed path reaches a test's import closure. Null for an untiered project or one with no
 * focused runner. Why tiers only: an untiered project's gate may run tests by rules imports do not show (a gate that
 * runs every file in a folder), so only exact-tree reuse holds there [C7].
 *
 * @param {any} state
 * @param {string} commit - The composed candidate commit.
 * @param {boolean} full - Whether the plan is the full configured gate.
 * @param {string[]} files - The plan's selected files.
 */
function closurePort(state, commit, full, files) {
  if (!state.config.affectedTests?.trim() || !hasTestTiers(state.batch.root, commit)) return null;
  let closures = null;
  // A graph that cannot be read (a nested module scope) knows no closure, so every candidate runs again.
  const reach = () => { try { closures ??= testClosures(state.batch.root, commit).closures; } catch { closures = new Map(); } return closures; };
  return {
    candidates: () => (full ? auditOnlySplit(state.config, [...reach().keys()]).files : files),
    // An incomplete closure (an import the graph cannot resolve) is never trusted: that file runs again.
    closureChanged: (file, changed) => { const closure = reach().get(file); return !closure?.files || closure.files.some(path => changed.has(path)); },
  };
}

/** Run one source-pinned gate or selective floor, retaining its complete immutable phase log. */
async function runGateGroup(state, label, options) {
  const tree = headTree(state.batch.root);
  await smokeTree(state, tree);
  const commit = headCommit(state.batch.root);
  let { config, affectedGate, files, subset, testTiers, journeys, proved: proof } = batchGatePlan(state, options);
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
  let reuse = landingReceiptReuse({ items: state.batch.items, readEvents: id => store.events(state.board, { itemId: id }), tree, base: state.batch.base, tooling: landingTooling(state.batch.root, commit), full: config[VALUE_GATE] !== true, files, treeOf,
    generated: state.landingWrites ?? [], changedPaths: (from, to) => changedPathsBetween(state.batch.root, from, to), verdictOf: (item, candidate) => gateVerdictOf(state.board, item, candidate), closure: closurePort(state, commit, config[VALUE_GATE] !== true, files) });
  // T3 journeys are deferred to the landing batch by design: no submit ran them, so no submit receipt answers for the ones it did not run.
  // Why: a one-item bisect half reused its submit receipt, ran no journey and passed the item that broke it [C7,CS4,V4].
  if (reuse.reuse && journeys?.length) {
    // Read the proof the reuse code reads: the submit's recorded files plus the files its frozen check ran [C7,#3685].
    const proved = new Set(proof);
    const unproved = journeys.filter(file => !proved.has(file));
    if (unproved.length) reuse = { ...reuse, rerun: [...new Set([...(reuse.rerun ?? []), ...unproved])].sort() };
  }
  const receipts = reuse.items?.length > 1 ? `#${reuse.items.join(', #')}'s submit receipts` : `#${reuse.item}'s submit receipt`;
  if (reuse.reuse && reuse.rerun?.length) {
    // The proof answers for the rest of the plan; only the files main's commits reach since the submit run again [C7].
    state.say(`gate ${label}: reused ${receipts}; rerunning ${reuse.rerun.length} file(s) whose import closure changed since the submit: ${reuse.rerun.join(', ')}`);
    files = reuse.rerun;
    config = { ...state.config, gate: `${state.config.affectedTests.trimEnd()} ${files.map(file => quote('./' + file)).join(' ')}`, [VALUE_GATE]: true };
  } else if (reuse.reuse) {
    state.say(`gate ${label}: reused ${receipts} for tree ${tree.slice(0, 12)}; no test run started`);
    // A verdict recorded green by the main-owned rule keeps its cases owned by main, never charged to the item [C7,#3534,#3685].
    if (reuse.mainOwned) state.say(`gate ${label}: #${reuse.item}'s submit verdict is green with main-owned case(s): ${reuse.mainOwned.map(row => `${row.file} :: ${row.name}`).join('; ')}`);
    const reused = { isGreen: true, failures: [], accounted: [], complete: true, requiresGreen: false, tree, logPath: null, affectedGate, reusedReceipt: { item: reuse.item, commit: reuse.commit, ...(reuse.items?.length > 1 ? { items: reuse.items } : {}), ...(reuse.mainOwned ? { mainOwned: reuse.mainOwned } : {}) } };
    // The reused receipt covered the full configured gate, so the tree is stamped green as a gate run would, and pre-push accepts it.
    if (config[VALUE_GATE] !== true) stampGreen(state.batch.root, tree);
    state.gates.set(tree, reused);
    return reused;
  }
  if (!reuse.reuse && reuse.code !== 'BATCH_OF_MANY' && reuse.code !== 'NO_RECEIPT') state.say(`gate ${label}: submit receipt not reused (${reuse.code}); running the gate`);
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
  // The line above opens a running gate and the "run finished" line below closes it; the batch's no-progress stop
  // counts the time between as progress (landingProgress), since a runner returns nothing until its run ends [C7].
  const gate = await (subset
    ? runLocalLandingGuard(state.batch.root, config, { files, directory, label, onWait: state.onWait,
      waivers: liveWaiverProjection(state.board, state.landingPorts), onFailure, quarantines, proofContext })
    // Every file runs to completion: a fail-fast stop at main's first known red left the rest unrun, so the gate could
    // never be compared with main and one red test blocked every landing [C7,#3167].
    : runGate(state.batch.root, config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, trustStamp: false, landing: true, collectAll: true, agent: 'coordinator', onWait: state.onWait,
      stages: true, waivers: liveWaiverProjection(state.board, state.landingPorts), onFailure, quarantines, proofContext, shard: landingGateShard(state, files) }));
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

/**
 * Start the static checks on the candidate's tree beside its gate. Their green receipt is keyed by tree, so the
 * batch's trunk guards on this same tree cite it instead of queuing a second runner job after the gate; a red or
 * failed run records nothing here and the trunk guards run and refuse as before.
 * Why: the trunk's static checks waited 80 to 230 s on a runner after a green candidate gate on 9 Nov [C7].
 */
function earlyStaticChecks(state) {
  return landingSpan('static', () => runStaticChecks(state.batch.root, state.config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() },
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
  return { files: [...files], filesCommand: batch => `${runner} ${batch.map(file => quote('./' + file)).join(' ')}`, say: line => state.say?.(line) };
}

/**
 * The test files a main move during a landing can change the result of: those whose import closure reaches both a file
 * main's new commits changed and a file the batch changes. A test that reaches only main's change runs the same bytes
 * main's own landing proved; one that reaches only the batch's runs the bytes the batch's gate proved. A test whose
 * closure cannot be read reruns when either side changed it or the affected selection for main's move names it (all of
 * them when that selection is the full suite). Null when the repository has no import graph to read (no test tiers or
 * no focused runner): the caller keeps its own selection.
 * Why: every "main moved outside this batch's files" rebuild reran a selection, the full plan when the move was wide,
 * up to 2m07s a landing on 9 Nov, while the move rarely shared a test closure with the batch [C7].
 *
 * @param {any} state
 * @param {{ trunkFiles: Set<string>, batchFiles: Set<string>, trunkAffected: { full?: boolean, files?: string[] } }} changes - Paths
 *   main's move and the batch each changed, and the affected-test selection for main's move.
 * @returns {string[] | null}
 */
export function trunkMoveReruns(state, { trunkFiles, batchFiles, trunkAffected }) {
  const commit = headCommit(state.batch.root);
  if (!state.config.affectedTests?.trim() || !hasTestTiers(state.batch.root, commit)) return null;
  let closures;
  try { closures = testClosures(state.batch.root, commit).closures; } catch { return null; }
  return auditOnlySplit(state.config, interactingTests(closures, { trunkFiles, batchFiles, trunkAffected })).files;
}

/**
 * The tests of trunkMoveReruns from an import-closure map: each test file to `{ files }`, or `{ files: null }` when its
 * closure cannot be read.
 *
 * @param {Map<string, { files: string[] | null }>} closures
 * @param {{ trunkFiles: Set<string>, batchFiles: Set<string>, trunkAffected?: { full?: boolean, files?: string[] } }} changes
 * @returns {string[]}
 */
export function interactingTests(closures, { trunkFiles, batchFiles, trunkAffected }) {
  const named = new Set(trunkAffected?.files ?? []);
  const reruns = [];
  for (const [file, closure] of closures) {
    const reached = closure?.files;
    if (!reached) { if (trunkAffected?.full || named.has(file) || trunkFiles.has(file) || batchFiles.has(file)) reruns.push(file); continue; }
    if (reached.some(path => trunkFiles.has(path)) && reached.some(path => batchFiles.has(path))) reruns.push(file);
  }
  return reruns.sort();
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
  const staticChecks = claimed.cached ? null : earlyStaticChecks(state);
  const gate = claimed.cached ?? { ...await gateGroup(state, 'candidate'), proofRoot: state.batch.root, proofCommit: headCommit(state.batch.root) };
  await staticChecks;
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
    const proof = detail?.commit === entry.commit && detail.gateGreen === true ? detail.submissionProof : null;
    if (!proof?.files?.length) continue;
    const [then, now] = packageHashesAt(root, [entry.commit, commit]);
    const { reuse } = reusableSubmitFiles({ proof, closureUnchanged: file => {
      const row = rows.get(file);
      return Boolean(row) && blob(entry.commit, file) !== null && blob(entry.commit, file) === blob(commit, file)
        && row.packages.every(name => then.get(name)?.hash === now.get(name)?.hash);
    } });
    for (const file of reuse) proven.add(file);
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

/**
 * The reuse ledger line of a finished gate's log, or a line saying the log holds none. Why: reuse fails open, and a
 * landing that reused nothing looked only slow until this line named its keyless files and why (#5839).
 */
function runLedger(log) {
  let output = '';
  try { output = readFileSync(log, 'utf8'); } catch { /* An unreadable log reports no account below. */ }
  return ledgerFromOutput(output) ?? 'ledger: the run log holds no per-file reuse account';
}
