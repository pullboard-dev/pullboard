/** @pullboard-test-input apps/lib/src/io/landing/candidate.js */
/** A complete selected Node run lets an exact-main red land only after later work runs [B3,C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });
const SOURCE = resolve(import.meta.dirname, '../../../..');
const RUNNER = join(SOURCE, 'apps/cli/src/io/run/tests.js');
const MAIN_RED = 'web/land-9.test.js';
const LATER_FILE = 'web/land-99.test.js';

/** Run real Node tests together when landing requests complete collection, and name any skipped selection on early stop. */
function nodeGate(box) {
  const gate = join(box.dir, 'real-node-land-gate.cjs');
  writeFileSync(gate, [
    "const fs = require('node:fs'); const path = require('node:path'); const { spawnSync } = require('node:child_process');",
    "const args = process.argv.slice(2); const alone = args.includes('--alone'); const files = args.filter(arg => arg !== '--alone');",
    "if (!files.length) files.push(...fs.readdirSync(path.join(process.cwd(), 'web')).filter(file => /^land-\\d+\\.test\\.js$/.test(file)).map(file => 'web/' + file));",
    "const collectAll = process.env.PULLBOARD_LANDING_COLLECT_ALL === '1'; const selected = collectAll || alone ? files : files.slice(0, 1);",
    "const run = spawnSync(process.execPath, ['--test', ...selected], { cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')), encoding: 'utf8' }); process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || '');",
    "if ((run.status ?? 1) !== 0 && !collectAll && !alone && files.length > selected.length) process.stdout.write('Interrupted test files: ' + files.slice(selected.length).join(', ') + '\\n');",
    "process.exitCode = run.status ?? 1;",
  ].join('\n'));
  return `node ${JSON.stringify(gate)}`;
}

/** Make the configured affected-test command run real Node test files with landing continuation semantics. */
/** Prepare a separate-publish landing project with one exact-main red and one passing selected test. */
function realNodeMainProject() {
  const box = landProject({ withWorktree: false });
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const gate = nodeGate(box);
  writeFileSync(join(box.repo, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(configPath, JSON.stringify({ ...config, gate, affectedTests: `${gate} --alone`,
    landing: { manualOverride: true, publish: 'separate' } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: land separately');
  const red = "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('main-red-case', () => { if (process.env.LAND_SUPPRESS_RED !== '1') assert.fail('main red'); });\n";
  const pass = "import { test } from 'node:test'; test('later-passing-case', () => {});\n";
  box.env.LAND_SUPPRESS_RED = '1';
  try {
    assert.equal(commitFile(box, box.repo, MAIN_RED, red, 'test(web): establish real main red [G1]').status, 0);
    assert.equal(commitFile(box, box.repo, LATER_FILE, pass, 'test(web): establish later pass [G1]').status, 0);
  } finally { delete box.env.LAND_SUPPRESS_RED; }
  return { box, red };
}

/** Submit both actual selected paths under a frozen node --test criterion. */
async function realNodeItem(box, number, red, later) {
  const path = join(box.dir, `land-${number}`);
  box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/land-${number}`, path, 'main');
  assert.equal(joinFixtureSeat(box, path, 'web').code, 0);
  const added = fileFixtureItem(box, box.repo, { lane: 'web', title: `Real Node landing fixture ${number}`, args: ['--specs', 'G1'],
    criterion: `real selected Node tests ${number} pass their frozen check`, check: `node ${RUNNER} ${MAIN_RED} ${LATER_FILE}` });
  const entry = { path, item: added.item_id, file: MAIN_RED };
  assert.equal((await box.runLocal(path, 'claim', String(entry.item))).code, 0);
  writeFileSync(join(entry.path, LATER_FILE), later);
  box.env.LAND_SUPPRESS_RED = '1';
  try { submitItem(box, entry, red); acceptItem(box, entry); return entry; }
  finally { delete box.env.LAND_SUPPRESS_RED; }
}

/** Run a native landing batch and return its durable batch record. */
function landBatch(box, itemId) {
  const source = [
    `import * as store from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../packages/store/index.js')).href)};`,
    `import { openBoard } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../lib/index.js')).href)};`,
    `import { loadConfig } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../packages/config/index.js')).href)};`,
    `import { runLandingBatch } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../packages/landing/index.js')).href)};`,
    `import { landingPorts } from ${JSON.stringify(new URL('../../tests/fixtures/landing/ports.js', import.meta.url).href)};`,
    `import { checkAtCommit } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../runner/index.js')).href)};`,
    `const candidateWorkerFile = ${JSON.stringify(join(import.meta.dirname, '../../../lib/src/io/landing/candidate.js'))};`,
    "import { join } from 'node:path';",
    'const [root, itemId] = process.argv.slice(1); const board = openBoard(join(root, ".git", "pullboard", "board.sqlite")); const lines = [];',
    'try { const write = async (operation, args) => board.enginePorts.store[operation](board, ...args); let error = null; let errorMessage = null; try { await runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, root, board, config: loadConfig(root), owner: "coordinator", write, say: line => lines.push(line), checkLease: async () => {}, checkLeaseNow: () => {} }); } catch (failure) { error = failure.code ?? String(failure); errorMessage = String(failure.message ?? "").slice(0, 600); } const batch = store.landingBatches(board).at(-1); const item = store.getItem(board, Number(itemId)); console.log(JSON.stringify({ error, errorMessage, lines, batch, merged: item.item_merged_commit })); } finally { store.closeBoard(board); }',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo, String(itemId)], { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

test('clause 1: an exact-main failure is fully collected with later selected work before landing; new red blocks [B3,C7]', async () => {
  const { box, red } = realNodeMainProject();
  const marker = join(box.dir, 'later-node-test-ran');
  const later = `import { test } from 'node:test'; import { writeFileSync } from 'node:fs'; test('later-passing-case', () => writeFileSync(${JSON.stringify(marker)}, 'ran'));\n`;
  const entry = await realNodeItem(box, 1, red, later);
  const landed = landBatch(box, entry.item);
  assert.equal(landed.error, null, `${landed.errorMessage}\n${JSON.stringify(landed.lines)}`);
  assert.equal(landed.batch.state, 'landed', JSON.stringify(landed.batch));
  assert.ok(landed.merged, 'the batch landed');
  assert.ok(readFileSync(marker, 'utf8'), 'the later selected test body ran');
  assert.deepEqual(landed.batch.proof.knownMain.map(row => [row.file, row.name]), [[MAIN_RED, 'main-red-case']], JSON.stringify(landed.batch.proof).slice(0, 1500));

  const blockedProject = realNodeMainProject();
  const newRed = "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('new-batch-red', () => { if (process.env.LAND_SUPPRESS_RED !== '1') assert.fail('new red'); });\n";
  const blockedEntry = await realNodeItem(blockedProject.box, 1, blockedProject.red, newRed);
  const blocked = landBatch(blockedProject.box, blockedEntry.item);
  assert.notEqual(blocked.batch.state, 'landed', 'a new selected red still blocks landing');
  assert.equal(blocked.merged, null);
  assert.ok(blocked.batch.knownMain.some(row => row.file === MAIN_RED && row.name === 'main-red-case'));
  assert.ok(blocked.batch.culprits.some(culprit => culprit.id === blockedEntry.item));
});
