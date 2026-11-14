/** A land job proves at most its item's gate set plus the tests main gained since, never the item's whole affected suite [C7,#7821]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { git } from '../../../../../packages/git/index.js';
import { jobQueueCall } from '../../../../../packages/api/index.js';
import { offerLandingJob } from '../../../../../packages/api/index.js';
import { takeLandingJob } from '../../../../../packages/landing/index.js';
import { recordTestResults } from '../../../../../packages/store/index.js';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { fixtureCommittedGraph } from '../../../tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';

const AS = ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'core.hooksPath=/dev/null'];
const TESTS = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js'];

/** A test file importing the shared module, so every one of them is affected by a change to it. */
function coreTest(name) {
  return `import { test } from 'node:test';\nimport { core } from '../src/core.js';\ntest('${name}', () => { if (core !== 1) throw new Error('${name}'); });\n`;
}

/** A bare trunk and a developer checkout: three tests import src/core.js; the runner logs each file list it is handed, then runs them. */
function project(t) {
  const { root } = privateFixtureFiles('pullboard-land-scope-');
  const graph = fixtureCommittedGraph('pullboard-land-scope-dev-');
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(graph.root, { recursive: true, force: true }); });
  const dev = graph.root, log = join(root, 'ran.jsonl');
  const put = (file, text) => { mkdirSync(dirname(join(dev, file)), { recursive: true }); writeFileSync(join(dev, file), text); git(dev, ['add', file]); };
  const commit = message => { git(dev, [...AS, 'commit', '-q', '-m', message]); return git(dev, ['rev-parse', 'HEAD']); };
  put('package.json', '{ "type": "module" }\n');
  put('bin/proof.mjs', `import { appendFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nconst files = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(files.map(file => file.replace(/^\\.\\//u, ''))) + '\\n');
const { NODE_TEST_CONTEXT, ...env } = process.env;\nprocess.exitCode = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env }).status ?? 1;\n`);
  put('src/core.js', 'export const core = 1;\n');
  for (const file of TESTS) put(file, coreTest(file));
  const seed = commit('chore: seed');
  const remote = join(root, 'trunk.git');
  git(root, ['clone', '-q', '--bare', dev, remote]);
  git(dev, ['remote', 'add', 'origin', remote]);
  const ran = () => { try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).flatMap(line => JSON.parse(line)); } catch { return []; } };
  return { root, dev, remote, seed, put, commit, ran };
}

/** Record the item's gate set as its ledger rows: only test/a.test.js, though its change reaches all three tests. */
function proveGateSet(board, commit) {
  const rows = [{ file: 'test/a.test.js', inputKey: 'a'.repeat(64), command: 'proof', context: 'c'.repeat(64), status: 'pass' }];
  assert.equal(recordTestResults(board.db, { receipt: `gate:${commit.slice(0, 8)}#0`, origin: 'pulled:r-gate', commit, rows }), 1);
}

/** The item changes the shared module every test imports, and its gate proves only test/a.test.js. */
function itemOnSeed(box, board) {
  git(box.dev, ['checkout', '-q', '--detach', box.seed]);
  box.put('src/core.js', 'export const core = 1; // item\n');
  const item = box.commit('feat(core): change the shared module [C7]');
  git(box.dev, ['push', '-q', 'origin', `${item}:refs/heads/item/1`]);
  proveGateSet(board, item);
  return item;
}

/** Offer the land job on the board and let a runner take it; return its receipt. */
async function land(board, box, item) {
  offerLandingJob(board.db, { items: [{ id: 1, commit: item, ref: 'refs/heads/item/1' }], expect: box.seed, config: { trunk: { remote: box.remote }, affectedTests: 'node bin/proof.mjs' } });
  const taken = await takeLandingJob({ call: body => jobQueueCall(board.db, body, { mode: 'pull' }), runner: 'r-scope', workdir: join(box.root, 'runner') });
  return taken.receipt;
}

test('clause 1: a land job for an item with a gate-proved set runs at most that set when main moved elsewhere [C7]', { timeout: 120_000 }, async t => {
  const box = project(t);
  const board = cellBoard(t, ':memory:');
  const item = itemOnSeed(box, board);
  git(box.dev, ['checkout', '-q', '--detach', box.seed]);
  box.put('docs/notes.md', 'unrelated\n');
  git(box.dev, ['push', '-q', 'origin', `${box.commit('docs: unrelated [C7]')}:refs/heads/main`]);
  const receipt = await land(board, box, item);
  assert.equal(receipt.outcome, 'landed', receipt.detail ?? '');
  assert.deepEqual([...new Set(box.ran())], ['test/a.test.js'], 'only the gate set ran; b and c, which the item reaches, were not reselected');
  assert.equal(receipt.contracts?.count ?? 0, 0, JSON.stringify(receipt.contracts));
});

test('clause 1: a test main gained after the item\'s base runs as a contract, and nothing else outside the gate set [C7]', { timeout: 120_000 }, async t => {
  const box = project(t);
  const board = cellBoard(t, ':memory:');
  const item = itemOnSeed(box, board);
  git(box.dev, ['checkout', '-q', '--detach', box.seed]);
  box.put('test/d.test.js', coreTest('test/d.test.js'));
  git(box.dev, ['push', '-q', 'origin', `${box.commit('test(core): main gains a contract [C7]')}:refs/heads/main`]);
  const receipt = await land(board, box, item);
  assert.equal(receipt.outcome, 'landed', receipt.detail ?? '');
  assert.deepEqual([...new Set(box.ran())].sort(), ['test/a.test.js', 'test/d.test.js'], 'the gate set and the contract main gained, never b or c');
  assert.deepEqual(receipt.contracts?.files, ['test/d.test.js']);
});
