/**
 * A red land receipt names its cause: the first run-tests refusal or first failing test, ahead of the output tail; and
 * a plain project's land job checks the merged tree, returning or parking the red item as 0.9.3's landing did [P7].
 */
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
import { applyLandingReceipt } from '../../../../../packages/api/index.js';
import { register } from '../../../../../packages/store/index.js';
import { claim } from '../../../../../packages/store/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { listItems } from '../../../../../packages/store/index.js';
import { verify } from '../../../../../packages/store/index.js';
import { openLandingJob } from '../../../../../packages/api/index.js';
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { itemThread } from '../../../../../packages/store/index.js';
import { recordTestResults } from '../../../../../packages/store/index.js';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { fixtureCommittedGraph } from '../../../tests/fixtures/testkit.js';
import { FIXTURE_MODEL } from '../../../tests/fixtures/testkit.js';
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
  register(board, { lane: 'coordinator', path: box.root, route: 'strong', model: FIXTURE_MODEL });
  seen.id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Item one', criterion: 'The item lands.' });
  assert.equal(recordTestResults(board.db, { receipt: `gate:${box.item.slice(0, 8)}#0`, origin: 'pulled:r-gate', commit: box.item,
    rows: [{ file: 'test/b.test.js', inputKey: 'a'.repeat(64), command: 'proof', context: 'c'.repeat(64), status: 'pass' }] }), 1);
  seen.job = offerLandingJob(board.db, { items: [{ id: seen.id, commit: box.item, ref: 'refs/heads/item/1' }], expect: box.seed,
    config: { trunk: { remote: box.remote }, affectedTests: runner } });
  const taken = await takeLandingJob({ call: body => jobQueueCall(board.db, body, { mode: 'pull' }), runner: 'r-red', workdir: join(box.root, 'runners', 'r-red') });
  seen.posted = { job: seen.job?.id ?? seen.job, receipt: taken.receipt };
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
  applyLandingReceipt(seen.board, seen.posted);
  const notes = itemThread(seen.board, seen.id).filter(entry => /^Land job .* red: /u.test(entry.text ?? ''));
  assert.equal(notes.length, 1, JSON.stringify(itemThread(seen.board, seen.id)));
  assert.match(notes[0].text, /run-tests: \[NO_POLICY\] no admitted trunk record/u);
});

const GREET_TEST = name => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/greet.js';\ntest('greets', () => assert.equal(greet('ann'), '${name} ann'));\n`;

/**
 * A plain project (a gate, no affectedTests) whose main moved after its items branched: main now says "hi", so an item
 * built on "hello" is green at its base and red on current main. Items are pushed to the trunk remote under refs/heads/item/<name>.
 */
function plainProject(t) {
  const { root } = privateFixtureFiles('pullboard-land-plain-');
  const graph = fixtureCommittedGraph('pullboard-land-plain-dev-');
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(graph.root, { recursive: true, force: true }); });
  const dev = graph.root;
  const put = (file, text) => { mkdirSync(dirname(join(dev, file)), { recursive: true }); writeFileSync(join(dev, file), text); git(dev, ['add', file]); };
  const commit = message => { git(dev, [...AS, 'commit', '-q', '-m', message]); return git(dev, ['rev-parse', 'HEAD']); };
  put('package.json', '{ "type": "module" }\n');
  put('pullboard.json', '{ "lanes": {} }\n');
  put('src/greet.js', 'export const greet = name => `hello ${name}`;\n');
  put('test/greet.test.js', GREET_TEST('hello'));
  const seed = commit('chore: seed');
  const remote = join(root, 'trunk.git');
  git(root, ['clone', '-q', '--bare', dev, remote]);
  git(dev, ['remote', 'add', 'origin', remote]);
  const item = (name, files) => {
    git(dev, ['checkout', '-q', '--detach', seed]);
    for (const [file, text] of Object.entries(files)) put(file, text);
    const sha = commit(`feat(core): ${name} [P7]`);
    git(dev, ['push', '-q', 'origin', `${sha}:refs/heads/item/${name}`]);
    return { sha, ref: `refs/heads/item/${name}` };
  };
  const items = {
    bang: item('bang', { 'src/bang.js': "import { greet } from './greet.js';\nexport const bang = name => `${greet(name)}!`;\n",
      'test/bang.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { bang } from '../src/bang.js';\ntest('bang', () => assert.equal(bang('ann'), 'hello ann!'));\n" }),
    upper: item('upper', { 'src/upper.js': 'export const upper = name => name.toUpperCase();\n',
      'test/upper.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { upper } from '../src/upper.js';\ntest('upper', () => assert.equal(upper('ann'), 'ANN'));\n" }),
    // Siblings: both add src/sibling.js, so the second collides with the first, never with main.
    hey: item('hey', { 'src/sibling.js': "export const sibling = 'hey';\n" }),
    yo: item('yo', { 'src/sibling.js': "export const sibling = 'yo';\n" }),
  };
  // Main moves on: greet says "hi" now, so #bang (built on "hello") is red on current main.
  git(dev, ['checkout', '-q', '--detach', seed]);
  put('src/greet.js', 'export const greet = name => `hi ${name}`;\n');
  put('test/greet.test.js', GREET_TEST('hi'));
  const main = commit('feat(core): say hi [P7]');
  git(dev, ['push', '-q', 'origin', `${main}:refs/heads/main`]);
  // The board's checkout sits on its main branch, as a coordinator's does, so claims read its policy.
  git(dev, ['checkout', '-q', '-B', 'main', main]);
  const board = cellBoard(t, ':memory:', undefined, { gitRoot: dev });
  register(board, { lane: 'coordinator', path: root, route: 'strong', model: FIXTURE_MODEL });
  return { root, dev, remote, seed, main, items, board };
}

/** Accept one item on the board at its pushed commit, built by its own seat, with its own check. */
function accept(box, name, check = null) {
  const { board } = box;
  const actor = register(board, { lane: 'core', path: join(box.root, `builder-${name}`), route: 'strong', model: FIXTURE_MODEL });
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: `Item ${name}`, criterion: 'The item lands.', ...(check ? { check } : {}) });
  const frozen = JSON.stringify({ criterion: 'The item lands.' });
  const digest = createHash('sha256').update(frozen).digest('hex');
  claim(board, id, { agentId: actor, lane: 'core', leaseMs: 3_600_000, head: box.seed, freeze: () => ({ text: frozen, digest }) });
  const { sha } = box.items[name];
  submitFixture(board, id, { agentId: actor, commit: sha, tree: git(box.dev, ['rev-parse', `${sha}^{tree}`]) });
  verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'fixture acceptance', head: sha, digest, policy: 'any' });
  return { id, actor, commit: sha, ref: box.items[name].ref };
}

/** Offer one land job for `entries` under `config`, let a runner take it, apply its receipt, and return both. */
async function landJob(box, entries, config = {}) {
  const { board } = box;
  const job = offerLandingJob(board.db, { items: entries.map(({ id, commit, ref }) => ({ id, commit, ref })), expect: box.main,
    config: { trunk: { remote: box.remote }, gate: 'node --test', ...config } });
  const taken = await takeLandingJob({ call: body => jobQueueCall(board.db, body, { mode: 'pull' }), runner: 'r-land', workdir: join(box.root, 'runners', 'r-land') });
  const applied = applyLandingReceipt(board, { job: job.id ?? job, receipt: taken.receipt });
  return { receipt: taken.receipt, applied, trunk: git(box.remote, ['rev-parse', 'refs/heads/main']) };
}

test('clause 1: a plain project\'s land job checks the merged tree; red lands nothing and returns the item to its builder [P7]', { timeout: 60_000 }, async t => {
  const box = plainProject(t);
  const bang = accept(box, 'bang', 'node --test test/bang.test.js');
  const { receipt, trunk } = await landJob(box, [bang]);
  assert.equal(receipt.outcome, 'red', JSON.stringify(receipt));
  assert.deepEqual(receipt.returned.map(row => [row.id, row.reason]), [[bang.id, 'red']]);
  assert.equal(trunk, box.main, 'trunk stays on main');
  const item = getItem(box.board, bang.id);
  assert.equal(item.item_status, 'open', 'the accept is withdrawn and the item reopens');
  assert.equal(item.item_merged_commit, null);
  const shouts = box.board.db.prepare('SELECT shout_text FROM shout WHERE shout_to = ?').all(bang.actor).map(row => row.shout_text);
  assert.ok(shouts.some(text => text.startsWith(`#${bang.id} is back with you: land job`)), JSON.stringify(shouts));
  const note = itemThread(box.board, bang.id).find(entry => /^Land job .* red: /u.test(entry.text ?? ''))?.text ?? '';
  assert.match(note, /check node --test test\/bang\.test\.js exited 1: not ok 1 - bang/u, 'the note names the red check and its failing case');
  assert.match(note, /hello ann!/u, 'the note keeps the failing assertion');
});

test('clause 2: under separate publish the red item parks and the clean item in the same job lands [P7]', { timeout: 60_000 }, async t => {
  const box = plainProject(t);
  const bang = accept(box, 'bang');
  const upper = accept(box, 'upper');
  const { receipt, trunk } = await landJob(box, [bang, upper], { landing: { publish: 'separate' } });
  assert.equal(receipt.outcome, 'landed', JSON.stringify(receipt));
  assert.deepEqual(receipt.landed, [upper.id]);
  assert.deepEqual(receipt.returned.map(row => [row.id, row.reason]), [[bang.id, 'red']]);
  assert.equal(getItem(box.board, upper.id).item_merged_commit, trunk, 'the clean item is merged at the pushed tip');
  const parked = getItem(box.board, bang.id);
  assert.equal(parked.item_merged_commit, null);
  assert.ok(parked.item_hold_at, 'the red item parks on a hold');
  assert.equal(git(box.remote, ['cat-file', '-t', `${trunk}:src/upper.js`]), 'blob');
  assert.notEqual(git(box.remote, ['ls-tree', trunk, 'src/bang.js']).length > 0, true, 'the red item\'s file is not on trunk');
});

test('clause 3: a red land job leaves no item accepted and no job open, so the next accept lands alone [P7]', { timeout: 60_000 }, async t => {
  const box = plainProject(t);
  const bang = accept(box, 'bang');
  await landJob(box, [bang]);
  assert.equal(openLandingJob(box.board.db), null, 'the red job is done');
  const upper = accept(box, 'upper');
  // The next accept offers what the lander offers: accepted, unmerged, unheld items.
  const waiting = listItems(box.board, { all: true }).filter(item => item.item_status === 'verified' && !item.item_merged_commit && !item.item_hold_at).map(item => item.item_id);
  assert.deepEqual(waiting, [upper.id], 'the red item is not accepted, so it is not bundled again');
  const { receipt, trunk } = await landJob(box, [upper]);
  assert.equal(receipt.outcome, 'landed', JSON.stringify(receipt));
  assert.equal(getItem(box.board, upper.id).item_merged_commit, trunk);
});

test('siblings that collide in one land job: the first lands, only the colliding one goes back to its builder [P7]', { timeout: 60_000 }, async t => {
  const box = plainProject(t);
  const hey = accept(box, 'hey');
  const yo = accept(box, 'yo');
  const { receipt, trunk } = await landJob(box, [hey, yo]);
  assert.equal(receipt.outcome, 'landed', JSON.stringify(receipt));
  assert.deepEqual(receipt.landed, [hey.id]);
  assert.deepEqual(receipt.returned.map(row => [row.id, row.reason]), [[yo.id, 'conflict']]);
  assert.match(receipt.returned[0].detail, new RegExp(`^#${yo.id} does not merge on ${box.main.slice(0, 12)}: .*src/sibling\\.js`, 'su'), 'the receipt names the colliding item and file');
  assert.equal(getItem(box.board, hey.id).item_merged_commit, trunk, 'the first sibling lands');
  assert.equal(getItem(box.board, yo.id).item_status, 'open', 'only the colliding sibling goes back');
});
