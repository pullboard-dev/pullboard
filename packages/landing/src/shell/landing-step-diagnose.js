import { hasTestTiers } from '../../../gate/index.js';
import { requireTestTierAccount } from '../../../gate/index.js';
/** Coordinator landing diagnose step; source-preserving partition of land.js [B3,R3,C7]. */
import { runnerExecutionServices } from '../../../runners/index.js';
import { landingExecutionServices } from './landing-shards.js';
import { dirname } from 'node:path';
import * as store from '../../../../src/board.js';
import { headCommit } from '../../../../src/git.js';
import { headTree } from '../../../../src/git.js';
import { isClean } from '../../../../src/git.js';
import { runProfiledShell } from '../../../gate/index.js';
import { withLandingGateSlot } from '../../../gate/index.js';
import { laneOf } from '../../../seats/index.js';
import { Refused } from '../../../kernel/index.js';
import { quote } from './landing-step-gate.js';
import { save } from './landing-step-merge.js';
import { mergeGroup } from './landing-step-merge.js';
import { gateGroup } from './landing-step-gate.js';
import { waivedProof } from './landing-step-failures.js';
import { unwaivedFailures } from './landing-step-failures.js';
import { testHash } from './landing-step-selection.js';
import { testBlob } from './landing-step-selection.js';
import { compareMainFailures } from './main-red.js';

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

/** Run each failing file once alone, with the same queued machine capacity as other checks. */
export async function diagnose(state, failures, gate) {
  // The enabled observer already made the only allowed exact-target pair under the original lease.
  // A saved gate retains that association, so adopting it cannot repeat a confidence measurement.
  const observations = gate?.flakeDiagnostics?.observations ?? [];
  // An observer failure without any observations provides no measurement to reuse; isolate the files instead.
  if (state.config.flakes?.rerun === true && !(gate?.flakeDiagnostics?.error && !observations.length)) {
    if (gate?.flakeDiagnostics?.error || !observations.length || observations.some(row => !row.recorded || row.classification === 'unclassified')) {
      await save(state, { state: 'blocked', failures, flakeDiagnostics: gate?.flakeDiagnostics });
      throw new Refused('LAND_DIAGNOSTIC', `the original red has no complete classified diagnostic; no additional run or landing is allowed; inspect ${gate.logPath} and pullboard flakes`);
    }
    return [...new Set(observations.filter(row => row.classification === 'flake' && row.file).map(row => row.file))];
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
  if (!await landingBaseGreen(state, failures, compare)) {
    await save(state, { state: 'blocked', failures, refusal: { code: 'LAND_DIAGNOSTIC',
      message: 'a failing file is red or unavailable on base main', at: state.board.clock.now().toISOString() } });
    state.flaky = true;
    state.say('landing held: a failing file is red or could not be compared on base main; accepted verdicts remain in place');
    return [];
  }
  if (items.length === 1) {
    const item = items[0];
    const text = `Landing batch ${state.batch.id} reproduces failures: ${failures.map((failure) => `${failure.file}: ${failure.name}`).join('; ')}`;
    if (!store.itemThread(state.board, item.id).some((entry) => entry.type === 'fact' && entry.text === text)) {
      await state.write('appendFact', [item.id, { agentId: 'coordinator', kind: 'measurement', text }]);
    }
    const mergeCommit = state.batch.tip;
    if (!state.culprits.some((entry) => entry.id === item.id)) state.culprits.push({ id: item.id, commit: item.commit, ...(item.reviewedCommit ? { reviewedCommit: item.reviewedCommit } : {}), mergeCommit, tests: failures });
    await save(state, { culprits: state.culprits });
    await returnCulprits(state);
    state.say(`culprit #${item.id}: ${failures.map((failure) => failure.name).join(', ')}`);
    return [];
  }
  const middle = Math.ceil(items.length / 2);
  const green = [];
  for (const [index, part] of [items.slice(0, middle), items.slice(middle)].entries()) {
    const build = await mergeGroup(state, part);
    await save(state, { ...build, state: 'bisecting' });
    const gate = await evaluate(state, `${label}-${index}`);
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

/** Return recorded red candidates once, including a saved failure interrupted before its move. */
export async function returnCulprits(state) {
  for (const culprit of state.culprits) {
    const item = store.getItem(state.board, culprit.id);
    if (item.item_status !== 'verified' || item.item_merged_commit || item.item_commit !== culprit.commit
      || (culprit.reviewedCommit ?? culprit.commit) !== store.checkedLandingCommit(state.board, item)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(culprit.mergeCommit ?? '')) continue;
    const evidence = `Landing failure evidence: main ${state.batch.base}; candidate ${culprit.commit}; merge ${culprit.mergeCommit}\n${culprit.tests.map((failure) => `${failure.file}: ${(failure.caseNames ?? [failure.name]).join(' > ')}\n${failure.assertion ?? 'Assertion details unavailable in the gate output.'}`).join('\n')}`;
    if (!store.itemThread(state.board, culprit.id).some((entry) => entry.type === 'fact' && entry.text === evidence)) {
      await state.write('appendFact', [culprit.id, { agentId: 'coordinator', kind: 'measurement', text: evidence }]);
    }
    const note = `Landing batch ${state.batch.id} failed ${culprit.tests.map((failure) => `${failure.file}: ${failure.name}`).join('; ')}; merge commit ${culprit.mergeCommit}; see landing failure evidence in pullboard show ${culprit.id}`;
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
