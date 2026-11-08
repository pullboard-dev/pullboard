/** @pullboard-test-input source-tree */
/** A landing batch never fails on a case already red on its main base, and still fails on a case red only in the batch [B3,C7]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { makeLandProjectFixtures } from './land-project-fixture.js';
import { runFixtureChild } from './fixture-child.js';
import { requireLocalGuardClassification } from '../packages/landing/src/core/land-local-guard.js';
import { diagnose } from '../packages/landing/src/shell/landing-step-diagnose.js';
import { completeGate } from '../packages/landing/src/shell/landing-completion.js';
import { failureSignatures } from '../packages/landing/src/shell/main-failure-matches.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem, moveMainPastSubmit } = makeLandProjectFixtures({ sandbox, project, commitFile });
const MAIN_RED = 'web/land-9.test.js';

test('known-main cancellation accounting excludes only fully accounted cancellations [B3,C7]', () => {
  const root = '/fixture';
  const output = [
    'TAP version 13', '# Subtest: broken', 'not ok 1 - broken', '  ---',
    '  location: /fixture/test/example.test.js:1:1', '  failureType: testCodeFailure', '  error: assertion failed', '  ...',
    '# Subtest: cancelled', 'not ok 2 - cancelled', '  ---',
    '  location: /fixture/test/example.test.js:2:1', '  failureType: cancelledByParent', '  error: pending promise', '  ...',
    '1..2', '# tests 2', '# pass 0', '# fail 1', '# cancelled 1', '',
  ].join('\n');
  const run = { isGreen: false, output, stages: [{ status: 1, output }] };
  const allowed = { allowCancelled: true };
  assert.equal(completeGate({ complete: true }, allowed), true, 'native positive completion remains sufficient');
  assert.equal(completeGate({ complete: false }, allowed), false, 'negative metadata without a raw account never permits landing');
  assert.equal(completeGate(run), false);
  assert.equal(failureSignatures(run, root), null);
  assert.equal(completeGate(run, allowed), true);
  assert.deepEqual(failureSignatures(run, root, allowed).map(row => [row.file, row.name]), [['test/example.test.js', 'broken']]);
  const interrupted = `${output}Interrupted test files: test/other.test.js\n`;
  assert.equal(completeGate({ ...run, output: interrupted }, allowed), false);
  assert.equal(failureSignatures({ ...run, stages: [{ status: 1, output: interrupted }] }, root, allowed), null);
  const wrongCount = output.replace('# cancelled 1', '# cancelled 2');
  assert.equal(completeGate({ ...run, output: wrongCount }, allowed), false);
  assert.equal(failureSignatures({ ...run, stages: [{ status: 1, output: wrongCount }] }, root, allowed), null);
  assert.equal(failureSignatures({ ...run, stages: [{ status: 2, output }] }, root, allowed), null);
});

/** A separate-publish landing project whose main already carries one red case, committed and pushed through real hooks. */
function redMainProject({ perItem = false, focused = true } = {}) {
  const box = landProject({ withWorktree: false });
  box.env.PULLBOARD_MODEL = 'landing-fixture';
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const projectConfig = { ...config, landing: { perItem, manualOverride: true, publish: 'separate' } };
  if (!focused) delete projectConfig.affectedTests; // main then has no focused runner, so its comparison is unavailable
  writeFileSync(path, JSON.stringify(projectConfig, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: land separately');
  box.env.LAND_SUPPRESS_RED = '1';
  try {
    assert.equal(commitFile(box, box.repo, MAIN_RED, '// RED NAME:main-red-case\n', 'test(web): a case red on main [G1]').status, 0);
  } finally { delete box.env.LAND_SUPPRESS_RED; }
  return box;
}

/**
 * Submit and accept one item with the fixture's red suppressed, as an item whose own check passed; main then moves, so
 * the landing runs its gate instead of reusing the suppressed submit receipt [C7,#3685].
 */
function acceptedItem(box, number, contents) {
  box.env.LAND_SUPPRESS_RED = '1';
  let entry;
  try {
    entry = itemWorktree(box, number);
    submitItem(box, entry, contents);
    acceptItem(box, entry);
  } finally { delete box.env.LAND_SUPPRESS_RED; }
  moveMainPastSubmit(box, number);
  return entry;
}

/** Run one real landing batch on the fixture board and return its record and the landing's own lines. */
function landBatch(box, itemId) {
  const source = [
    `import * as store from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/board.js')).href)};`,
    `import { openBoard } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../apps/lib/index.js')).href)};`,
    `import { loadConfig } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../packages/config/index.js')).href)};`,
    `import { runLandingBatch } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../packages/landing/index.js')).href)};`,
    `import { landingPorts } from ${JSON.stringify(new URL('./landing-ports-fixture.js', import.meta.url).href)};`,
    `import { checkAtCommit } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../apps/runner/index.js')).href)};`,
    `const candidateWorkerFile = ${JSON.stringify(join(import.meta.dirname, '../bin/landing-candidate.js'))};`,
    "import { join } from 'node:path';",
    'const [root, itemId] = process.argv.slice(1);',
    'const board = openBoard(join(root, ".git", "pullboard", "board.sqlite"));',
    'const lines = [];',
    'try {',
    'const write = async (operation, args) => board.enginePorts.store[operation](board, ...args);',
    'let error = null; try { await runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, root, board, config: loadConfig(root), owner: "coordinator", write, say: line => lines.push(line), checkLease: async () => {}, checkLeaseNow: () => {} }); } catch (failure) { error = failure.code ?? String(failure); }',
    'const batch = store.landingBatches(board).at(-1); const item = store.getItem(board, Number(itemId));',
    'console.log(JSON.stringify({ error, lines, batch, merged: item.item_merged_commit, status: item.item_status }));',
    '} finally { store.closeBoard(board); }',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo, String(itemId)], { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

/**
 * The published-main refresh runs in a detached child after the landing; its completion line in the lander's
 * refresh log is the signal, watched rather than polled, and the landing's own exit never waits for it.
 */
function refreshLogged(box, tip, exited) {
  const directory = join(box.repo, '.git', 'pullboard', 'automatic-landing');
  mkdirSync(directory, { recursive: true }); // the child creates it too; watching needs it now
  const file = join(directory, 'main-red-refresh.log');
  const done = () => existsSync(file) && readFileSync(file, 'utf8').includes(`refresh at ${tip.slice(0, 12)}:`);
  if (done()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const watcher = watch(directory, () => { if (done()) { watcher.close(); resolve(true); } });
    exited.then(() => { watcher.close(); resolve(done()); });
    if (done()) { watcher.close(); resolve(true); }
  });
}

test('clause 1: a batch red only in a case red on main lands and refreshes that named comparison at the published main [B3,C7]', async () => {
  const box = redMainProject();
  const entry = acceptedItem(box, 1, '// PASS\n');
  box.env.LAND_CANCEL = '1';
  const result = landBatch(box, entry.item);
  assert.equal(result.error, null, JSON.stringify(result.lines));
  assert.equal(result.batch.state, 'landed', JSON.stringify(result.batch));
  assert.ok(result.merged, 'the accepted item lands');
  assert.deepEqual(result.batch.proof.failures, [], 'no failure is waived or carried');
  assert.deepEqual(result.batch.proof.knownMain.map(row => [row.file, row.name]), [[MAIN_RED, 'main-red-case']]);
  assert.ok(result.lines.some(line => /known main red/u.test(line) && line.includes(`${MAIN_RED} :: main-red-case`)), result.lines.join('\n'));
  // The landing already returned; the detached refresh finishes on its own and logs its completion.
  const deadline = new Promise(resolve => { const timer = setTimeout(resolve, 120_000); timer.unref(); });
  assert.equal(await refreshLogged(box, result.batch.tip, deadline), true, 'the detached refresh completed within the test budget');
  const mainRedCache = JSON.parse(readFileSync(join(box.repo, '.git', 'pullboard', 'main-red.json'), 'utf8'));
  const refreshed = mainRedCache.entries[result.batch.tip]?.[MAIN_RED];
  assert.equal(refreshed?.result, 'red', 'the landing refresh targets the newly published main');
  assert.ok(refreshed.failures?.some(row => row.name === 'main-red-case'), JSON.stringify(refreshed));
});

test('a batch holding a main red and a case passing on base fails only on the merged-only case [B3,C7]', () => {
  const box = redMainProject();
  box.env.LAND_SUPPRESS_RED = '1';
  try {
    assert.equal(commitFile(box, box.repo, 'web/land-1.test.js', '// PASS\n', 'test(web): establish passing base case [G1]').status, 0);
  } finally { delete box.env.LAND_SUPPRESS_RED; }
  const base = runFixtureChild(process.execPath, [join(box.dir, 'land-gate.cjs'), '--alone', 'web/land-1.test.js'],
    { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(base.status, 0, `the case passes on the actual base main: ${base.stderr}\n${base.stdout}`);
  const entry = acceptedItem(box, 1, '// RED NAME:batch-red-case\n');
  box.env.LAND_CANCEL = '1';
  const result = landBatch(box, entry.item);
  assert.notEqual(result.batch.state, 'landed');
  assert.equal(result.merged, null, 'the batch-only red keeps the item off main');
  assert.ok(result.batch.knownMain, JSON.stringify(result));
  assert.deepEqual(result.batch.knownMain.map(row => [row.file, row.name]), [[MAIN_RED, 'main-red-case']], 'the main red is named as known-main');
  assert.ok(result.lines.some(line => /known main red/u.test(line) && line.includes(`${MAIN_RED} :: main-red-case`)), result.lines.join('\n'));
  assert.ok(result.batch.culprits.some(culprit => culprit.id === entry.item), `the batch-only case makes its item the culprit: ${JSON.stringify(result.batch)}`);
  assert.ok(!result.batch.culprits.some(culprit => JSON.stringify(culprit).includes(MAIN_RED)), 'the known-main case is never a culprit reason');
});

test('an observer error without observations isolates each failing file once; recorded evidence is reused [B3,C7]', async t => {
  const box = redMainProject();
  // diagnose runs in this process: it takes its slot from the fixture's machine, never the real runner pool.
  const saved = Object.fromEntries(['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME'].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  Object.assign(process.env, { PULLBOARD_HOME: box.env.PULLBOARD_HOME, PULLBOARD_MACHINE_HOME: box.env.PULLBOARD_MACHINE_HOME });
  const state = {
    config: { flakes: { rerun: true }, affectedTests: box.affected },
    batch: { root: box.repo, logPath: join(box.dir, 'diagnostic.log'), revision: 0 },
    diagnosed: new Map(),
    write: async (_operation, [options]) => options.batch,
  };
  const failures = [{ file: MAIN_RED, name: 'main-red-case' }, { file: MAIN_RED, name: 'another case' }];
  assert.doesNotThrow(() => requireLocalGuardClassification(state, { flakeDiagnostics: { error: 'observer failed', observations: [] } }),
    'the local-trunk boundary permits the same isolate fallback');
  assert.throws(() => requireLocalGuardClassification(state, { flakeDiagnostics: { observations: [] } }), { code: 'LAND_DIAGNOSTIC' });
  const callsBefore = readFileSync(box.calls, 'utf8').trim().split('\n').length;
  const result = await diagnose(state, failures, { flakeDiagnostics: { error: 'observer failed', observations: [] } });
  assert.deepEqual(result, [], 'the reproducible red remains attributable');
  const callsAfter = readFileSync(box.calls, 'utf8').trim().split('\n').slice(callsBefore).map(JSON.parse);
  assert.deepEqual(callsAfter, [['--alone', MAIN_RED]], 'duplicate failures run the file once');
  // A recorded flake observation is the flake itself, reused as is (#2914); nothing refuses or isolates again.
  assert.deepEqual(await diagnose(state, failures, { logPath: box.calls, flakeDiagnostics: {
    error: 'observer failed', observations: [{ file: MAIN_RED, recorded: true, classification: 'flake' }],
  } }), [MAIN_RED]);
  assert.equal(readFileSync(box.calls, 'utf8').trim().split('\n').length, callsBefore + 1, 'recorded evidence triggers no extra isolation');
});

test('clause 1: a per-item landing red only in a case red on main reruns it at base main and lands, charging nothing to the item [C7,#3073]', () => {
  const box = redMainProject({ perItem: true });
  const entry = acceptedItem(box, 1, '// PASS\n');
  box.env.LAND_CANCEL = '1';
  const result = landBatch(box, entry.item);
  assert.equal(result.error, null, JSON.stringify(result.lines));
  assert.ok(!result.lines.some(line => line.startsWith('main comparison unavailable')), `main is compared, not refused a slot: ${JSON.stringify(result.lines)}`);
  assert.ok(result.merged, `the item lands: ${JSON.stringify(result.lines)}`);
  assert.deepEqual(result.batch.proof.knownMain.map(row => [row.file, row.name]), [[MAIN_RED, 'main-red-case']]);
  assert.ok(!(result.batch.culprits ?? []).length, 'no culprit is recorded');
  assert.deepEqual(result.batch.mainRedRepairs.map(row => row.file), [MAIN_RED], 'main\'s red is filed as one Main red item for its file');
  assert.ok(Number.isInteger(result.batch.mainRedRepairs[0].item), JSON.stringify(result.batch.mainRedRepairs));
});

test('clause 2: a per-item landing red in a case green at main still blocks and names its item as the culprit [C7,#3073]', () => {
  const box = redMainProject({ perItem: true });
  box.env.LAND_SUPPRESS_RED = '1';
  try {
    assert.equal(commitFile(box, box.repo, 'web/land-1.test.js', '// PASS\n', 'test(web): establish passing base case [G1]').status, 0);
  } finally { delete box.env.LAND_SUPPRESS_RED; }
  const entry = acceptedItem(box, 1, '// RED NAME:batch-red-case\n');
  box.env.LAND_CANCEL = '1';
  const result = landBatch(box, entry.item);
  assert.equal(result.merged, null);
  assert.ok(result.batch.culprits.some(culprit => culprit.id === entry.item), JSON.stringify(result.batch));
  assert.ok(!result.batch.culprits.some(culprit => JSON.stringify(culprit).includes(MAIN_RED)), 'the main red is never a reason');
});

test('clause 3: a per-item landing whose base-main comparison is unavailable blocks as a landing fault and leaves the item verified [C7,#3065]', () => {
  const box = redMainProject({ perItem: true, focused: false });
  const entry = acceptedItem(box, 1, '// PASS\n');
  box.env.LAND_CANCEL = '1';
  const result = landBatch(box, entry.item);
  assert.ok(result.lines.some(line => line.includes('[LAND_MAIN_COMPARISON]')), JSON.stringify(result.lines));
  assert.equal(result.merged, null);
  assert.equal(result.status, 'verified', 'an unavailable comparison cannot reopen an accepted item');
});
