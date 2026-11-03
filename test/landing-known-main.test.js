/** A landing batch never fails on a case already red on its main base, and still fails on a case red only in the batch [B3,C7]. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { makeLandProjectFixtures } from './land-project-fixture.js';
import { runFixtureChild } from './fixture-child.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });
const MAIN_RED = 'web/land-9.test.js';

/** A separate-publish landing project whose main already carries one red case, committed and pushed through real hooks. */
function redMainProject() {
  const box = landProject();
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing: { manualOverride: true, publish: 'separate' } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: land separately');
  box.env.LAND_SUPPRESS_RED = '1';
  try {
    assert.equal(commitFile(box, box.repo, MAIN_RED, 'RED NAME:main-red-case\n', 'test(web): a case red on main [G1]').status, 0);
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
    `import { openBoard } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/native-board.js')).href)};`,
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
  const entry = acceptedItem(box, 1, 'PASS\n');
  const result = landBatch(box, entry.item);
  assert.equal(result.error, null, JSON.stringify(result.lines));
  assert.equal(result.batch.state, 'landed', JSON.stringify(result.batch));
  assert.ok(result.merged, 'the accepted item lands');
  assert.deepEqual(result.batch.proof.failures, [], 'no failure is waived or carried');
  assert.deepEqual(result.batch.proof.knownMain.map(row => [row.file, row.name]), [[MAIN_RED, 'main-red-case']]);
  assert.ok(result.lines.some(line => /known main red/u.test(line) && line.includes(`${MAIN_RED} :: main-red-case`)), result.lines.join('\n'));
});

test('a batch holding one case red on main and one red only in the batch fails only on the second [B3,C7]', () => {
  const box = redMainProject();
  const entry = acceptedItem(box, 1, 'RED NAME:batch-red-case\n');
  const result = landBatch(box, entry.item);
  assert.notEqual(result.batch.state, 'landed');
  assert.equal(result.merged, null, 'the batch-only red keeps the item off main');
  assert.deepEqual(result.batch.knownMain.map(row => [row.file, row.name]), [[MAIN_RED, 'main-red-case']], 'the main red is named as known-main');
  assert.ok(result.lines.some(line => /known main red/u.test(line) && line.includes(`${MAIN_RED} :: main-red-case`)), result.lines.join('\n'));
  assert.ok(result.batch.culprits.some(culprit => culprit.id === entry.item), `the batch-only case makes its item the culprit: ${JSON.stringify(result.batch)}`);
  assert.ok(!result.batch.culprits.some(culprit => JSON.stringify(culprit).includes(MAIN_RED)), 'the known-main case is never a culprit reason');
});
