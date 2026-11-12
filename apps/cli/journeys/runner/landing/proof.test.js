/** A land job's proof reads only the board ledger: an unrelated main move reruns nothing, a moved import reruns its test, main's red is a lookup [P7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { git } from '../../../../../packages/git/index.js';
import { jobQueueCall } from '../../../../../packages/api/index.js';
import { offerLandingJob } from '../../../../../packages/api/index.js';
import { phaseLedger } from '../../../../../packages/gate/index.js';
import { planTestActions } from '../../../../../packages/gate/index.js';
import { takeLandingJob } from '../../../../../packages/landing/index.js';
import { recordTestResults } from '../../../../../packages/store/index.js';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { fixtureCommittedGraph } from '../../../tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';

const AS = ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'core.hooksPath=/dev/null'];
const GATE = pathToFileURL(fileURLToPath(new URL('../../../../../packages/gate/index.js', import.meta.url))).href;
// The fixture's runner: plan with the ledger hits run-tests reads, then run only the misses, as the project runner does.
const RUNNER = `import { spawnSync } from 'node:child_process';
import { planTestActions } from ${JSON.stringify(GATE)};
const files = process.argv.slice(2);
const plan = await planTestActions(process.cwd(), files, { fullSuite: false, landing: true, listFiles: () => files });
if (!plan.done) process.exitCode = spawnSync(process.execPath, ['--test', ...plan.args], { stdio: 'inherit' }).status ?? 1;
`;
const INHERITED = /^PULLBOARD_(TEST_(ACTIONS|STAGE|REUSE|RESULT_\w+)|LEDGER_HITS)$/u;

/** A bare trunk remote and a developer checkout holding two source files, a test for each and the fixture runner. */
function project(t) {
  const { root } = privateFixtureFiles('pullboard-land-proof-');
  const graph = fixtureCommittedGraph('pullboard-land-proof-dev-');
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(graph.root, { recursive: true, force: true }); });
  const dev = graph.root;
  const put = (file, text) => { mkdirSync(dirname(join(dev, file)), { recursive: true }); writeFileSync(join(dev, file), text); git(dev, ['add', file]); };
  const commit = message => { git(dev, [...AS, 'commit', '-q', '-m', message]); return git(dev, ['rev-parse', 'HEAD']); };
  // An ES-module package: run-tests keys only a complete ES-module import graph.
  put('package.json', '{ "type": "module" }\n');
  put('bin/proof.mjs', RUNNER);
  put('src/a.js', 'export const a = 1;\n');
  put('src/b.js', 'export const b = 2;\n');
  put('test/a.test.js', "import { test } from 'node:test';\nimport { a } from '../src/a.js';\ntest('a', () => { if (a !== 1) throw new Error('a'); });\n");
  put('test/b.test.js', "import { test } from 'node:test';\nimport { b } from '../src/b.js';\ntest('b', () => { if (b !== 2) throw new Error('b'); });\n");
  const seed = commit('chore: seed');
  const remote = join(root, 'trunk.git');
  git(root, ['clone', '-q', '--bare', dev, remote]);
  git(dev, ['remote', 'add', 'origin', remote]);
  return { root, dev, remote, seed, put, commit };
}

/** The item's gate run at its own commit, recorded as the board's ledger rows, as a posted gate receipt writes them; `red` files record as fail. */
async function proveItem(board, box, commit, red = []) {
  git(box.dev, ['checkout', '-q', '--detach', commit]);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !INHERITED.test(name))), PULLBOARD_TEST_REUSE: 'record',
    PULLBOARD_TEST_RESULT_STORE: join(box.root, 'gate-store') };
  const files = ['./test/a.test.js', './test/b.test.js'], written = [];
  await planTestActions(box.dev, files, { fullSuite: false, listFiles: () => files, env, write: text => written.push(text) });
  const ledger = phaseLedger(written.join(''), { status: 0 });
  assert.equal(ledger?.files.length, 2, `the gate run printed keyed frames: ${written.join('').slice(0, 2000)}`);
  const rows = ledger.files.map(([file, inputKey, context, status]) => ({ file, inputKey, command: 'proof', context: ledger.contexts[context], status: red.includes(file) ? 'fail' : status }));
  assert.equal(recordTestResults(board.db, { receipt: `gate:${commit.slice(0, 8)}#0`, origin: 'pulled:r-gate', commit, rows }), 2);
}

/** Offer the land job on the board and let a runner with an empty store take it; return its receipt and wall time. */
async function land(board, box, entry, name, expect = box.seed) {
  offerLandingJob(board.db, { items: [entry], expect, config: { trunk: { remote: box.remote }, affectedTests: 'node bin/proof.mjs' } });
  const started = Date.now();
  const taken = await takeLandingJob({ call: body => jobQueueCall(board.db, body, { mode: 'pull' }), runner: name, workdir: join(box.root, 'runners', name) });
  return { receipt: taken.receipt, ms: Date.now() - started };
}

test('clause 1: a one-item landing after an unrelated main move runs 0 files and lands within 90 s on a runner [P7]', { timeout: 120_000 }, async t => {
  const box = project(t);
  const board = cellBoard(t, ':memory:');
  git(box.dev, ['checkout', '-q', '--detach', box.seed]);
  box.put('src/a.js', 'export const a = 1; // item 1\n');
  const item = box.commit('feat(core): item 1 [P7]');
  git(box.dev, ['push', '-q', 'origin', `${item}:refs/heads/item/1`]);
  await proveItem(board, box, item);
  // Main moves on a file no test reaches.
  git(box.dev, ['checkout', '-q', '--detach', box.seed]);
  box.put('docs/notes.md', 'unrelated\n');
  git(box.dev, ['push', '-q', 'origin', `${box.commit('docs: unrelated [P7]')}:refs/heads/main`]);
  const { receipt, ms } = await land(board, box, { id: 1, commit: item, ref: 'refs/heads/item/1' }, 'r-far');
  assert.equal(receipt.outcome, 'landed', receipt.detail ?? '');
  assert.deepEqual(receipt.proof, { files: 2, reused: 2, ran: 0 }, 'every plan file was a ledger hit, so none ran');
  assert.ok(ms < 90_000, `landed in ${ms} ms`);
});

test('clause 1: a test whose import closure main changed misses the ledger and reruns; its sibling is reused [P7]', { timeout: 120_000 }, async t => {
  const box = project(t);
  const board = cellBoard(t, ':memory:');
  git(box.dev, ['checkout', '-q', '--detach', box.seed]);
  box.put('src/a.js', 'export const a = 1; // item 2\n');
  const item = box.commit('feat(core): item 2 [P7]');
  git(box.dev, ['push', '-q', 'origin', `${item}:refs/heads/item/2`]);
  await proveItem(board, box, item);
  // Main moves src/b.js, which test/b.test.js imports: its old proof must not carry.
  git(box.dev, ['checkout', '-q', '--detach', box.seed]);
  box.put('src/b.js', 'export const b = 2; // main moved\n');
  git(box.dev, ['push', '-q', 'origin', `${box.commit('fix(core): main moves b [P7]')}:refs/heads/main`]);
  const { receipt } = await land(board, box, { id: 2, commit: item, ref: 'refs/heads/item/2' }, 'r-near');
  assert.equal(receipt.outcome, 'landed', receipt.detail ?? '');
  assert.deepEqual(receipt.proof, { files: 2, reused: 1, ran: 1 }, 'only the test reaching main\'s change reran');
});

/** Main breaks test/b.test.js and its gate records the fail row at main's commit; returns main's commit. */
async function redMain(board, box) {
  git(box.dev, ['checkout', '-q', '--detach', box.seed]);
  box.put('src/b.js', 'export const b = 3; // main red\n');
  const main = box.commit('fix(core): main breaks b [P7]');
  git(box.dev, ['push', '-q', 'origin', `${main}:refs/heads/main`]);
  await proveItem(board, box, main, ['test/b.test.js']);
  return main;
}

test('clause 1: a candidate whose only red file has a fail row at main\'s identical inputKey lands; that red is charged to main [P7]', { timeout: 120_000 }, async t => {
  const box = project(t);
  const board = cellBoard(t, ':memory:');
  const main = await redMain(board, box);
  box.put('src/a.js', 'export const a = 1; // item 3\n');
  const item = box.commit('feat(core): item 3 [P7]');
  git(box.dev, ['push', '-q', 'origin', `${item}:refs/heads/item/3`]);
  await proveItem(board, box, item, ['test/b.test.js']);
  const { receipt } = await land(board, box, { id: 3, commit: item, ref: 'refs/heads/item/3' }, 'r-main', main);
  assert.equal(receipt.outcome, 'landed', receipt.detail ?? '');
  assert.deepEqual(receipt.proof, { files: 2, reused: 1, ran: 0, mainRed: 1 }, 'b is main\'s red at its identical inputKey, so it never ran and held nothing');
});

test('clause 1: a red file whose inputKey differs from main\'s fail row is not charged to main and holds the landing [P7]', { timeout: 120_000 }, async t => {
  const box = project(t);
  const board = cellBoard(t, ':memory:');
  const main = await redMain(board, box);
  box.put('src/b.js', 'export const b = 3; // item 4 touches b\n');
  const item = box.commit('feat(core): item 4 [P7]');
  git(box.dev, ['push', '-q', 'origin', `${item}:refs/heads/item/4`]);
  await proveItem(board, box, item, ['test/b.test.js']);
  const { receipt } = await land(board, box, { id: 4, commit: item, ref: 'refs/heads/item/4' }, 'r-own', main);
  assert.notEqual(receipt.outcome, 'landed', 'the item changed b\'s inputs, so its red is its own');
  assert.equal(receipt.proof?.mainRed, undefined, 'nothing was charged to main');
});
