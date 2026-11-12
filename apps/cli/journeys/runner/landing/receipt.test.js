/** A red land receipt names its cause: the first run-tests refusal or first failing test, ahead of the output tail [P7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { git } from '../../../../../packages/git/index.js';
import { jobQueueCall } from '../../../../../packages/api/index.js';
import { offerLandingJob } from '../../../../../packages/api/index.js';
import { takeLandingJob } from '../../../../../packages/landing/index.js';
import { addItem } from '../../../../../packages/store/index.js';
import { itemThread } from '../../../../../packages/store/index.js';
import { recordTestResults } from '../../../../../packages/store/index.js';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { fixtureCommittedGraph } from '../../../tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';

const AS = ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'core.hooksPath=/dev/null'];
const NOISE = `{"suiteTiming":${JSON.stringify('x'.repeat(500))}}`;
// The refusing runner: run-tests' NO_POLICY line on stderr, then 500+ chars of timing noise on stdout, as tonight's land reds printed.
const REFUSER = `process.stderr.write('run-tests: [NO_POLICY] no admitted trunk record in this checkout; next: pin the runner trunk\\n');
process.stdout.write(${JSON.stringify(`${NOISE}\n`)});
process.exitCode = 1;
`;
// The failing runner: a real node --test run of a red file, then the same noise.
const FAILER = `import { spawnSync } from 'node:child_process';
const { NODE_TEST_CONTEXT, ...env } = process.env;
const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...process.argv.slice(2)], { encoding: 'utf8', env });
process.stdout.write(run.stdout + ${JSON.stringify(`${NOISE}\n`)});
process.exitCode = run.status ?? 1;
`;

/** A bare trunk remote and a checkout with a red test and both runners; one item commit pushed under refs/heads/item/1. */
function project(t) {
  const { root } = privateFixtureFiles('pullboard-land-receipt-');
  const graph = fixtureCommittedGraph('pullboard-land-receipt-dev-');
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(graph.root, { recursive: true, force: true }); });
  const dev = graph.root;
  const put = (file, text) => { mkdirSync(dirname(join(dev, file)), { recursive: true }); writeFileSync(join(dev, file), text); git(dev, ['add', file]); };
  const commit = message => { git(dev, [...AS, 'commit', '-q', '-m', message]); return git(dev, ['rev-parse', 'HEAD']); };
  put('package.json', '{ "type": "module" }\n');
  put('bin/refuse.mjs', REFUSER);
  put('bin/fail.mjs', FAILER);
  put('test/b.test.js', "import { test } from 'node:test';\ntest('b holds', () => { throw new Error('b broke'); });\n");
  const seed = commit('chore: seed');
  const remote = join(root, 'trunk.git');
  git(root, ['clone', '-q', '--bare', dev, remote]);
  git(dev, ['remote', 'add', 'origin', remote]);
  put('src/a.js', 'export const a = 1;\n');
  const item = commit('feat(core): item 1 [P7]');
  git(dev, ['push', '-q', 'origin', `${item}:refs/heads/item/1`]);
  return { root, seed, remote, item };
}

/** Record the item's ledger row so the land job carries a proof, offer the job with `runner`, and return the runner's receipt. */
async function landWith(t, runner, seen = {}) {
  const box = project(t);
  const board = cellBoard(t, ':memory:');
  seen.board = board;
  seen.id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Item one', criterion: 'The item lands.' });
  assert.equal(recordTestResults(board.db, { receipt: `gate:${box.item.slice(0, 8)}#0`, origin: 'pulled:r-gate', commit: box.item,
    rows: [{ file: 'test/b.test.js', inputKey: 'a'.repeat(64), command: 'proof', context: 'c'.repeat(64), status: 'pass' }] }), 1);
  offerLandingJob(board.db, { items: [{ id: seen.id, commit: box.item, ref: 'refs/heads/item/1' }], expect: box.seed,
    config: { trunk: { remote: box.remote }, affectedTests: runner } });
  const taken = await takeLandingJob({ call: body => jobQueueCall(board.db, body, { mode: 'pull' }), runner: 'r-red', workdir: join(box.root, 'runners', 'r-red') });
  return taken.receipt;
}

test('clause 1: a land job whose run-tests refuses NO_POLICY keeps the refusal line ahead of 500 chars of noise [P7]', { timeout: 60_000 }, async t => {
  const receipt = await landWith(t, 'node bin/refuse.mjs');
  assert.equal(receipt.outcome, 'red', JSON.stringify(receipt));
  const detail = receipt.detail ?? '';
  const at = detail.indexOf('run-tests: [NO_POLICY] no admitted trunk record');
  assert.ok(at >= 0, `the receipt keeps the refusal: ${detail}`);
  assert.ok(at < detail.indexOf('xxxxxxxx'), `the refusal comes ahead of the output tail: ${detail}`);
});

test('clause 1: a land job with a failing test keeps its name and error ahead of the noise [P7]', { timeout: 60_000 }, async t => {
  const receipt = await landWith(t, 'node bin/fail.mjs');
  assert.equal(receipt.outcome, 'red', JSON.stringify(receipt));
  const detail = receipt.detail ?? '';
  assert.match(detail, /not ok \d+ - b holds/u, `the receipt names the failing test: ${detail}`);
  assert.match(detail, /b broke/u, `the receipt keeps its error: ${detail}`);
  assert.ok(detail.indexOf('b broke') < detail.indexOf('xxxxxxxx'), `the failure comes ahead of the output tail: ${detail}`);
});

test('clause 1: a red land receipt reaches the item thread, which show prints, with its refusal line [P7]', { timeout: 60_000 }, async t => {
  const seen = {};
  const receipt = await landWith(t, 'node bin/refuse.mjs', seen);
  assert.equal(receipt.outcome, 'red', JSON.stringify(receipt));
  const notes = itemThread(seen.board, seen.id).filter(entry => /^Land job .* red: /u.test(entry.text ?? ''));
  assert.equal(notes.length, 1, JSON.stringify(itemThread(seen.board, seen.id)));
  assert.match(notes[0].text, /run-tests: \[NO_POLICY\] no admitted trunk record/u);
});
