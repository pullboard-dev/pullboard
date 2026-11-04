/** A landing batch never fails on a case already red on its main base, and still fails on a case red only in the batch [B3,C7]. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
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
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });
const MAIN_RED = 'web/land-9.test.js';
const LATER_FILE = 'web/land-99.test.js';

/** Replace the canned gate with real Node tests and preserve the canonical early-stop contract. */
function realNodeGate(box) {
  writeFileSync(box.gate, [
    "const fs = require('node:fs'); const { spawnSync } = require('node:child_process'); const path = require('node:path');",
    "const args = process.argv.slice(2).filter(arg => arg !== '--alone');",
    "const files = args.length ? args : fs.readdirSync(path.join(process.cwd(), 'web')).filter(name => /^land-\\d+\\.test\\.js$/u.test(name)).map(name => './web/' + name).sort();",
    "let status = 0; for (let index = 0; index < files.length; index++) { const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', files[index]], { cwd: process.cwd(), env: process.env, encoding: 'utf8' }); process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || ''); if (run.status !== 0) status = run.status || 1; if (run.status && process.env.PULLBOARD_LANDING_COLLECT_ALL !== '1') { for (const skipped of files.slice(index + 1)) process.stdout.write('Interrupted test files: ' + skipped + '\\n'); break; } } process.exitCode = status;",
  ].join('\n'));
}

/** Use real selected Node test files: main has the first red, then item work changes the later file. */
function realNodeMainProject() {
  const box = redMainProject();
  realNodeGate(box);
  const red = "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('main-red-case', () => { if (process.env.LAND_SUPPRESS_RED !== '1') assert.fail('main red'); });\n";
  const pass = "import { test } from 'node:test'; test('later-passing-case', () => {});\n";
  box.env.LAND_SUPPRESS_RED = '1';
  try {
    assert.equal(commitFile(box, box.repo, MAIN_RED, red, 'test(web): establish real main red [G1]').status, 0);
    assert.equal(commitFile(box, box.repo, LATER_FILE, pass, 'test(web): add later passing case [G1]').status, 0);
  } finally { delete box.env.LAND_SUPPRESS_RED; }
  return { box, red, pass };
}

/** Submit an item that carries the known main red and selects a later real test body. */
function acceptedRealNodeItem(box, number, red, later) {
  const path = join(box.dir, `land-${number}`);
  box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/land-${number}`, path, 'main');
  assert.equal(box.run(path, 'join', 'web').code, 0);
  const added = box.run(box.repo, 'add', 'web', `Real Node landing fixture ${number}`, '--specs', 'G1',
    '--criterion', `real selected Node tests ${number} pass their frozen check`, '--check', `node --test ${MAIN_RED} ${LATER_FILE}`, '--json');
  assert.equal(added.code, 0, added.err);
  const entry = { path, item: JSON.parse(added.out).item.item_id, file: MAIN_RED };
  assert.equal(box.run(path, 'claim', String(entry.item)).code, 0);
  writeFileSync(join(entry.path, LATER_FILE), later);
  box.env.LAND_SUPPRESS_RED = '1';
  try { submitItem(box, entry, red); acceptItem(box, entry); return entry; }
  finally { delete box.env.LAND_SUPPRESS_RED; }
}

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
function redMainProject() {
  const box = landProject({ withWorktree: false });
  box.env.PULLBOARD_MODEL = 'landing-fixture';
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing: { manualOverride: true, publish: 'separate' } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: land separately');
  box.env.LAND_SUPPRESS_RED = '1';
  try {
    assert.equal(commitFile(box, box.repo, MAIN_RED, '// RED NAME:main-red-case\n', 'test(web): a case red on main [G1]').status, 0);
  } finally { delete box.env.LAND_SUPPRESS_RED; }
  return box;
}

/** Submit and accept one item with the fixture's red suppressed, as an item whose own check passed. */
function acceptedItem(box, number, contents) {
  box.env.LAND_SUPPRESS_RED = '1';
  try {
    const entry = itemWorktree(box, number);
    submitItem(box, entry, contents);
    acceptItem(box, entry);
    return entry;
  } finally { delete box.env.LAND_SUPPRESS_RED; }
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
    'console.log(JSON.stringify({ error, lines, batch, merged: item.item_merged_commit }));',
    '} finally { store.closeBoard(board); }',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo, String(itemId)], { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

test('a batch red only in a case red on main lands and names that case as known-main [B3,C7]', () => {
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

test('an observer error without observations isolates each failing file once; recorded evidence still refuses [B3,C7]', async () => {
  const box = redMainProject();
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
  await assert.rejects(diagnose(state, failures, { logPath: box.calls, flakeDiagnostics: {
    error: 'observer failed', observations: [{ file: MAIN_RED, recorded: true, classification: 'flake' }],
  } }), { code: 'LAND_DIAGNOSTIC' });
  assert.equal(readFileSync(box.calls, 'utf8').trim().split('\n').length, callsBefore + 1, 'recorded evidence triggers no extra isolation');
});

test('a complete real selected run lands its exact-main red after later files finish, while a new red blocks [B3,C7]', () => {
  const { box, red } = realNodeMainProject();
  const marker = join(box.dir, 'later-node-test-ran');
  const later = `import { test } from 'node:test'; import { writeFileSync } from 'node:fs'; test('later-passing-case', () => writeFileSync(${JSON.stringify(marker)}, 'ran'));\n`;
  const entry = acceptedRealNodeItem(box, 1, red, later);
  const landed = landBatch(box, entry.item);
  assert.equal(landed.error, null, JSON.stringify(landed.lines));
  assert.equal(landed.batch.state, 'landed', JSON.stringify(landed.batch));
  assert.ok(landed.merged, 'the fully accounted known-main batch lands');
  assert.ok(readFileSync(marker, 'utf8'), 'the later selected test body ran after the known-main failure');
  assert.deepEqual(landed.batch.proof.knownMain.map(row => [row.file, row.name]), [[MAIN_RED, 'main-red-case']]);

  const blockedProject = realNodeMainProject();
  const redLater = "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('new-batch-red', () => assert.fail('new red'));\n";
  const blockedEntry = acceptedRealNodeItem(blockedProject.box, 1, blockedProject.red, redLater);
  const blocked = landBatch(blockedProject.box, blockedEntry.item);
  assert.notEqual(blocked.batch.state, 'landed', 'a new selected failure still blocks the landing');
  assert.equal(blocked.merged, null);
  assert.ok(blocked.batch.proof.knownMain.some(row => row.file === MAIN_RED && row.name === 'main-red-case'));
  assert.ok(blocked.batch.culprits.some(culprit => culprit.id === blockedEntry.item));
});
