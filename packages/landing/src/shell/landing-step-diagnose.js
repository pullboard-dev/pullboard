import { hasTestTiers } from '../../../gate/index.js';
import { requireTestTierAccount } from '../../../gate/index.js';
/** Coordinator landing diagnose step; source-preserving partition of land.js [B3,R3,C7]. */
import { runnerExecutionServices } from '../../../runners/index.js';
import { landingExecutionServices } from './landing-shards.js';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import * as store from '../../../../src/board.js';
import { headCommit } from '../../../../src/git.js';
import { headTree } from '../../../../src/git.js';
import { isClean } from '../../../../src/git.js';
import { runProfiledShell } from '../../../gate/index.js';
import { withLandingGateSlot } from '../../../gate/index.js';
import { laneOf } from '../../../seats/index.js';
import { Refused } from '../../../kernel/index.js';
import { itemRefusalText } from '../core/item-refusal.js';
import { quote } from './landing-step-gate.js';
import { save } from './landing-step-merge.js';
import { mergeGroup } from './landing-step-merge.js';
import { gateGroup } from './landing-step-gate.js';
import { waivedProof } from './landing-step-failures.js';
import { unwaivedFailures } from './landing-step-failures.js';
import { testHash } from './landing-step-selection.js';
import { testBlob } from './landing-step-selection.js';
import { compareMainFailures } from './main-red.js';
import { spawnSync } from 'node:child_process';

/** Require a green base for every failing file before attributing a red to an item. */
export async function landingBaseGreen(state, failures, compare = compareMainFailures) {
  const files = [...new Set(failures.map(failure => failure.file).filter(Boolean))];
  if (!files.length || failures.some(failure => !failure.file)) return false;
  try {
    const result = await compare(state.batch.root, { tests: files.map(file => ({ file, passed: false })) }, state.onWait, '',
      { commit: state.batch.base, detailed: true, allowCancelled: true });
    return result.main === state.batch.base && !result.unavailable
      && files.every(file => result.files?.some(row => row.file === file && row.result === 'green'));
  } catch { return false; }
}

/**
 * False only when the batch base commit resolves and does not contain this test file; anything undeterminable counts as
 * present, so an unreadable base still goes through the base comparison [C7,#2947].
 */
function fileOnBase(state, file) {
  const git = args => spawnSync('git', ['--no-replace-objects', ...args], { cwd: state.batch.root }).status === 0;
  if (!git(['cat-file', '-e', `${state.batch.base}^{commit}`])) return true;
  return git(['cat-file', '-e', `${state.batch.base}:${file}`]);
}

/**
 * Split named failures into those base main fails in the same file and test name, and the batch's own; null when main
 * cannot be compared for every file [C7,#2941]. Why: a red that main already has is not the batch's doing, and holding
 * the whole batch for it kept every landing waiting on reds no batch item caused.
 */
export async function splitBaseRed(state, failures, compare = compareMainFailures, onBase = (file) => fileOnBase(state, file)) {
  if (!failures.length || failures.some(failure => !failure.file)) return null;
  // A failing file that base main does not have is the batch's own new test, so it splits the batch [C7,#2947].
  const absent = failures.filter(failure => !onBase(failure.file));
  const present = failures.filter(failure => onBase(failure.file));
  if (!present.length) return { known: [], own: absent };
  const files = [...new Set(present.map(failure => failure.file))];
  // Each file is compared on its own: a file main cannot be compared on stays the batch's own red and never discards the
  // completed results of every other file, as one combined comparison did [C7,#3073]. Results are cached per file.
  const rows = new Map();
  // The files compare at once, each as a landing-class run: one after another as plain diagnostics, three red files
  // cost this split 25 minutes on 6 Nov while runner slots sat free [C7].
  await Promise.all(files.map(async file => {
    let result;
    try {
      // The known-main step already compared this file on the same base: reuse its answer instead of a second run.
      const kept = state.mainComparisons?.get(file);
      result = kept && (kept.carried || kept.main === state.batch.base) ? kept
        : await compare(state.batch.root, { tests: [{ file, passed: false }] }, state.onWait, '',
          { commit: state.batch.base, detailed: true, allowCancelled: true, runnerAdmission: { landing: true } });
    } catch (error) { state.say?.(`base split: ${file} could not be compared on main: ${error?.code ?? 'ERROR'} ${String(error?.message ?? '').slice(0, 160)}`); return; }
    const row = (result?.carried || result?.main === state.batch.base) && !result.unavailable ? result.files?.find(entry => entry.file === file) : null;
    // Every outcome is named, so a held batch says why its base comparison gave nothing usable [C7].
    state.say?.(`base split: ${file} on main ${result?.main?.slice(0, 12) ?? 'unknown'}: ${result?.unavailable ? `unavailable (${result.unavailable})` : row ? `${row.result}, ${(row.failures ?? []).length} failing case(s)` : 'no row for this file'}`);
    if (row) rows.set(file, row);
  }));
  if (!rows.size) return null;
  const known = [], own = [...absent];
  for (const failure of present) {
    const row = rows.get(failure.file);
    // Red on base with no named cases cannot be told apart from the batch's own red, so that case stays own [C7,#2945].
    (row?.result === 'red' && (row.failures ?? []).some(main => main.name === failure.name) ? known : own).push(failure);
  }
  return { known, own };
}

/** Run each failing file once alone, with the same queued machine capacity as other checks. */
export async function diagnose(state, failures, gate) {
  // The enabled observer already made the only allowed exact-target pair under the original lease.
  // A saved gate retains that association, so adopting it cannot repeat a confidence measurement.
  const observations = gate?.flakeDiagnostics?.observations ?? [];
  // An observer failure without any observations provides no measurement to reuse; isolate the files instead.
  if (state.config.flakes?.rerun === true && !(gate?.flakeDiagnostics?.error && !observations.length)) {
    // An unrecorded or unclassified observation is treated as a real red: bisect is the safe fallback, and a
    // true flake passes in the split runs and lands. Only rows classified as flakes are filed as flakes [C7,#2914].
    return [...new Set(observations.filter(row => row.recorded === true && row.classification === 'flake' && row.file).map(row => row.file))];
  }
  if (!failures.length || failures.some((entry) => !entry.file)) throw new Refused('LAND_DIAGNOSTIC', `the gate did not name a failing test file; inspect ${state.batch.logPath} and make its reporter name source files`);
  const files = [...new Set(failures.map((entry) => entry.file))];
  const flakes = [];
  for (const file of files) {
    if (state.diagnosed.has(file)) { if (state.diagnosed.get(file)) flakes.push(file); continue; }
    const runner = state.config.affectedTests || (/\.[cm]?js$/u.test(file) ? 'node --test' : null);
    if (!runner) throw new Refused('LAND_DIAGNOSTIC', `no runner can isolate ${file}; configure affectedTests for the project’s test runner`);
    const commit = headCommit(state.batch.root);
    const tree = headTree(state.batch.root);
    const tiered = hasTestTiers(state.batch.root);
    const result = await withLandingGateSlot(state.batch.root, (lease) => {
      lease.testTiers = tiered;
      return runProfiledShell(state.batch.root, `${runner} ${quote(file)}`, {
      waitMs: lease.waitMs, artifactDirectory: dirname(state.batch.logPath), artifactPrefix: 'diagnostic', persistLog: true, pipefail: true, gateLease: lease,
    }); }, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, landing: true, browser: true, agent: 'coordinator', kind: 'land-diagnostic', onWait: state.onWait });
    if (tiered) requireTestTierAccount(result, [file]);
    if (headCommit(state.batch.root) !== commit || headTree(state.batch.root) !== tree || !isClean(state.batch.root)) {
      throw new Refused('LAND_SOURCE_CHANGED', `the landing source changed during its whole-file diagnostic; inspect ${result.logPath} before adopting`);
    }
    state.diagnosed.set(file, result.isGreen);
    const evidence = state.batch.invariantEvidence ?? { version: 1, gates: [], diagnostics: [] };
    await save(state, { diagnostics: [...state.diagnosed].map(([test, isGreen]) => ({ test, isGreen })),
      invariantEvidence: { ...evidence, diagnostics: [...evidence.diagnostics,
        { test: file, isGreen: result.isGreen, commit, wallMs: result.profile?.wallMs ?? null }] } });
    if (result.isGreen) flakes.push(file);
  }
  return flakes;
}

/** Bisect a reproducible red without retrying any previously tested group. */
export async function bisect(state, items, failures, label = 'split', evaluate = gateGroup, compare = compareMainFailures) {
  // A live-waived red never reaches the base-main comparison: only the batch's own reds decide a split [C7,#2900].
  failures = unwaivedFailures(state.board, failures, state.landingPorts);
  // Cases base main already fails the same way are set aside; only the batch's own reds split it [C7,#2941].
  const split = await splitBaseRed(state, failures, compare);
  if (!split) {
    await save(state, { state: 'blocked', failures, refusal: { code: 'LAND_DIAGNOSTIC',
      message: 'a failing file could not be compared on base main', at: state.board.clock.now().toISOString() } });
    state.flaky = true;
    state.say('landing held: a failing file could not be compared on base main; accepted verdicts remain in place');
    return [];
  }
  if (split.known.length) {
    await save(state, { knownMain: [...(state.batch.knownMain ?? []), ...split.known.map(({ file, name }) => ({ file, name }))] });
    state.say(`known main red, not this batch's: ${split.known.map(failure => `${failure.file} :: ${failure.name}`).join('; ')}`);
  }
  if (!split.own.length) return items;
  failures = split.own;
  if (items.length === 1) {
    await returnCulprit(state, items[0], failures, { isolated: true });
    return [];
  }
  const middle = Math.ceil(items.length / 2);
  const green = [];
  for (const [index, part] of [items.slice(0, middle), items.slice(middle)].entries()) {
    const build = await mergeGroup(state, part);
    await save(state, { ...build, state: 'bisecting' });
    // Each half runs only the files the batch failed, those its tree holds; a half without any of them cannot have
    // caused those reds and is green for this split. The final green set runs its whole plan before landing [C7].
    const focus = [...new Set(failures.map(failure => failure.file).filter(Boolean))].filter(file => existsSync(join(state.batch.root, file)));
    const gate = focus.length ? await evaluate(state, `${label}-${index}`, { focus }) : { isGreen: true, failures: [], absentFocus: true };
    // Only unwaived reds split a group further; a group red only on waived files is green for bisection [C7,#2900].
    const own = unwaivedFailures(state.board, gate.failures, state.landingPorts);
    if (gate.isGreen || waivedProof(state, gate) || !own.length) green.push(...build.items);
    else {
      const flakyFiles = await diagnose(state, own, gate);
      if (flakyFiles.length) {
        await fileFlakes(state, gate, flakyFiles);
        state.flaky = true;
        return [];
      }
      green.push(...await bisect(state, build.items, own, `${label}-${index}`, evaluate, compare));
    }
  }
  return green;
}

/**
 * The failures in a file the item changed or its check names; empty when its changed files cannot be read.
 * Why: a red in a file the item never touched is main's or the machine's, and reopening the item for it bounced
 * accepted work that was never at fault [C7,#2967].
 */
export function ownFailures(state, entry, failures) {
  const changed = spawnSync('git', ['--no-replace-objects', 'diff', '--name-only', '-z', `${state.batch.base}...${entry.commit}`], { cwd: state.batch.root, encoding: 'utf8' });
  if (changed.status !== 0) return [];
  const files = new Set(changed.stdout.split('\0').filter(Boolean));
  const check = store.getItem(state.board, entry.id)?.item_check ?? '';
  return failures.filter(failure => failure.file && (files.has(failure.file) || check.includes(failure.file)));
}

/**
 * Send an item back to open for the reds that are its own; true when it was recorded as a culprit. A red only in files
 * it neither changed nor names in its check reopens nothing: the batch keeps the failure and the item stays verified.
 * Why shared: a bisection's last item and a per-item landing's only item are the same case [C7,#2901,#2967].
 */
export async function returnCulprit(state, item, failures, { isolated = false } = {}) {
  // An item a bisection isolated is the only change in its tree: its named reds that main passes are its own even in
  // files it never touched. Why: "stays verified" sent such an item round again, a bisection each time [C7].
  const charged = isolated && failures.length && failures.every(failure => failure.file && !failure.watchdog) ? failures : ownFailures(state, item, failures);
  const own = charged;
  if (!own.length) {
    await save(state, { failures });
    state.say(`landing red is not #${item.id}'s: ${failures.map((failure) => `${failure.file ?? 'gate'}: ${failure.name}`).join('; ')}; it stays verified`);
    return false;
  }
  await recordCulprit(state, item, own);
  return true;
}

/** Record one item as the culprit of the given failures and send it back to open with the evidence, once. */
async function recordCulprit(state, item, failures) {
  const text = `Landing batch ${state.batch.id} reproduces failures: ${failures.map((failure) => `${failure.file ?? 'gate'}: ${failure.name}`).join('; ')}`;
  if (!store.itemThread(state.board, item.id).some((entry) => entry.type === 'fact' && entry.text === text)) {
    await state.write('appendFact', [item.id, { agentId: 'coordinator', kind: 'measurement', text }]);
  }
  const mergeCommit = state.batch.tip;
  if (!state.culprits.some((entry) => entry.id === item.id)) state.culprits.push({ id: item.id, commit: item.commit, ...(item.reviewedCommit ? { reviewedCommit: item.reviewedCommit } : {}), mergeCommit, tests: failures });
  await save(state, { culprits: state.culprits });
  await returnCulprits(state);
  state.say(`culprit #${item.id}: ${failures.map((failure) => failure.name).join(', ')}`);
}

/** The failures a red gate names, or one line naming its exit and log when the project's runner names none [C7,#2901]. */
export function namedFailures(gate) {
  return gate.failures?.length ? gate.failures : [{ file: 'gate', name: `the landing check exited ${gate.exitCode ?? 'non-zero'}; log ${gate.logPath ?? 'unavailable'}` }];
}

/**
 * Refusals the candidate's own content causes; every other refusal is the landing's infrastructure or diagnosis
 * (board busy, runners, git, timeouts, diagnostics) and reopens nothing [C7,#2901,#2967].
 */
// The codes live in core (item-refusal.js) so the batch sizer judges them the same way.

/**
 * Refusals that say the board was briefly unreachable, not that the landing or its item failed. A worker that gives up
 * on one keeps its batch state, worktree and log, so adoption resumes the batch instead of blocking it as gone [C7].
 */
// A locked board or slot database means the run never started, not that the batch or an item failed.
export const LANDING_FAULTS = new Set(['BOARD_BUSY', 'SLOT_DB_LOCKED']);

/** True when a refusal is a landing fault: retried or adopted, never a reason to block a batch or blame an item [C7]. */
export function landingFault(error) {
  return error instanceof Refused && LANDING_FAULTS.has(error.code);
}

/** True when a refusal is the candidate's own: an item code, or the CLI smoke naming the candidate's exit [C7,#2967]. */
export function itemRefusal(error) {
  if (!(error instanceof Refused)) return false;
  return itemRefusalText(error.code, error.message);
}

/**
 * Send a per-item landing's only item back to open with a refusal it caused, once; true when it went back.
 * Why: a refusal on one item's content otherwise leaves it verified and every later run stops on it again; a refusal
 * of the landing's own machinery leaves it verified, since the item did nothing wrong [C7,#2901,#2967].
 */
export async function returnRefusedItem(state, error) {
  if (!itemRefusal(error)) return false;
  const entry = (state.batch.items?.length ? state.batch.items : state.batch.candidates ?? [])[0];
  const item = entry && store.getItem(state.board, entry.id);
  if (!item || item.item_status !== 'verified' || item.item_merged_commit || item.item_commit !== entry.commit) return false;
  // The refusal is recorded as the item's culprit case, so the existing culprit return carries it with its evidence.
  await recordCulprit(state, entry, [{ file: 'landing', name: error.code, assertion: error.message }]);
  return store.getItem(state.board, entry.id).item_status !== 'verified';
}

/** Return recorded red candidates once, including a saved failure interrupted before its move. */
export async function returnCulprits(state) {
  for (const culprit of state.culprits) {
    const item = store.getItem(state.board, culprit.id);
    if (item.item_status !== 'verified' || item.item_merged_commit || item.item_commit !== culprit.commit
      || (culprit.reviewedCommit ?? culprit.commit) !== store.checkedLandingCommit(state.board, item)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(culprit.mergeCommit ?? '')) continue;
    const evidence = `Landing failure evidence: main ${state.batch.base}; candidate ${culprit.commit}; merge ${culprit.mergeCommit}\n${culprit.tests.map((failure) => `${failure.file ?? 'gate'}: ${(failure.caseNames ?? [failure.name]).join(' > ')}\n${failure.assertion ?? 'Assertion details unavailable in the gate output.'}`).join('\n')}`;
    if (!store.itemThread(state.board, culprit.id).some((entry) => entry.type === 'fact' && entry.text === evidence)) {
      await state.write('appendFact', [culprit.id, { agentId: 'coordinator', kind: 'measurement', text: evidence }]);
    }
    const note = `Landing batch ${state.batch.id} failed ${culprit.tests.map((failure) => `${failure.file ?? 'gate'}: ${failure.name}`).join('; ')}; merge commit ${culprit.mergeCommit}; see landing failure evidence in pullboard show ${culprit.id}`;
    await state.write('reopen', [culprit.id, { agentId: 'coordinator', note }]);
  }
}

/** Reopen only exact saved conflicting submissions after candidate composition has completed. */
export async function returnMergeConflicts(state) {
  for (const conflict of state.batch.conflicts ?? []) {
    const item = store.getItem(state.board, conflict.id);
    if (item.item_status !== 'verified' || item.item_merged_commit || item.item_commit !== conflict.commit
      || store.checkedLandingCommit(state.board, item) !== conflict.reviewedCommit) continue;
    await state.write('reopen', [item.item_id, { agentId: 'coordinator',
      note: `landing conflict: ${conflict.files.join(', ')}; merge current main and resubmit`, conflict: { files: conflict.files, trunk: conflict.trunk } }]);
  }
}

/** File a flake once against its named test and leave the batch stopped. */
export async function fileFlakes(state, gate, files) {
  if (state.config.flakes?.rerun === true) {
    await save(state, { state: 'blocked', failures: gate.failures, flakeDiagnostics: gate.flakeDiagnostics });
    state.say(`flake observed: ${files.join(', ')}; the original gate stays red and nothing lands; inspect pullboard flakes`);
    return;
  }
  const flakes = [];
  for (const file of files) {
    const owner = laneOf(state.config, file);
    const lane = owner === 'coordinator' ? store.getItem(state.board, state.batch.items[0].id).item_lane : owner;
    flakes.push(await state.write('recordLandingFlake', [{ agentId: 'coordinator', test: file, hash: testHash(state.batch.root, file),
      names: gate.failures.filter((entry) => entry.file === file).map((entry) => entry.name), lane, batchId: state.batch.id }]));
  }
  await save(state, { state: 'flaky', failures: gate.failures, flakes });
  state.say(`flake: ${files.join(', ')}; nothing landed; fix the test or ask the person for an expiring waiver`);
}

/** File a neutral test defect for the exact no-culprit red and leave its proof available for a waiver. */
export async function fileTestDefects(state, gate) {
  const defects = [];
  const files = [...new Set(gate.failures.map(failure => failure.file).filter(Boolean))];
  if (!files.length) throw new Refused('LAND_DIAGNOSTIC', 'the no-culprit gate did not identify a failing test file');
  for (const file of files) {
    const owner = laneOf(state.config, file);
    const lane = owner === 'coordinator' ? store.getItem(state.board, state.batch.items[0].id).item_lane : owner;
    defects.push(await state.write('recordLandingTestDefect', [{ agentId: 'coordinator', test: file,
      hash: testHash(state.batch.root, file), blob: testBlob(state.batch.root, state.batch.tip, file),
      trunkBlob: testBlob(state.root, state.batch.base, file),
      names: gate.failures.filter(failure => failure.file === file).map(failure => failure.name),
      lane, batchId: state.batch.id, branch: state.batch.branch }]));
  }
  await save(state, { state: 'test-defect', failures: gate.failures, testDefects: defects });
  state.say(`the trunk is held by a test defect: ${files.join(', ')}; correct the test or ask an approver for an expiring waiver`);
}
