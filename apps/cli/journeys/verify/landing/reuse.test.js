/** @pullboard-test-input apps/lib/src/io/landing/candidate.js */
/**
 * A tiered one-item landing reuses its green submit proof when main moved since the submit: it reruns only the tests
 * whose import closure main's commits reach, so a batch whose closures did not move runs no test and lands [C7].
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import {
  fixtureAdd,
  fixtureProjectPolicy,
} from '../../../tests/fixtures/testkit.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import {
  openBoardReadOnly,
  handoffRecord,
} from '../../../../../packages/store/index.js';
import { landingReceiptReuse } from '../../../../../packages/landing/index.js';

const ITEM_TEST = 'web/item.test.js';

/** The pure verdict's input: one submit of c1 on main1 with a deferred proof, landing on main2 with closure `reach`. */
function closureInput({ moved = ['web/main.txt'], drift = moved, reach = {}, deferredFiles = [], candidates = [ITEM_TEST, 'web/other.test.js'] } = {}) {
  const trees = { main1: 'treeBase', main2: 'treeMoved' };
  const diffs = { 'treeBase>treeMoved': moved, 'treeC>treeM': drift, 'treeT>treeM': drift };
  const submit = { commit: 'c1', tree: 'treeC', policyCommit: 'main1', tooling: 'treeT', gateGreen: true,
    submissionProof: { version: 1, files: [ITEM_TEST], full: false, deferred: true, deferredFiles } };
  return { items: [{ id: 7, commit: 'c1' }], readEvents: () => [{ event_kind: 'submit', event_detail: JSON.stringify(submit) }],
    tree: 'treeM', base: 'main2', tooling: 'treeM', full: false, files: candidates, treeOf: rev => trees[rev] ?? null,
    changedPaths: (from, to) => diffs[`${from}>${to}`] ?? null,
    closure: { candidates: () => candidates, closureChanged: (file, changed) => (reach[file] ?? [file]).some(path => changed.has(path)) } };
}

test('clause 1: a deferred proof on a moved main is reused, rerunning only the files whose import closure main\'s commits reach [C7]', () => {
  assert.deepEqual(landingReceiptReuse(closureInput()).rerun, [], 'no closure reaches main\'s change: nothing reruns');
  const reached = landingReceiptReuse(closureInput({ reach: { [ITEM_TEST]: [ITEM_TEST, 'web/main.txt'] } }));
  assert.equal(reached.reuse, true);
  assert.deepEqual(reached.rerun, [ITEM_TEST], 'only the file whose closure main changed reruns');
  assert.deepEqual(landingReceiptReuse(closureInput({ deferredFiles: ['web/other.test.js'] })).rerun, ['web/other.test.js'], 'a file the submit deferred still runs');
});

test('clause 1: control: a merged tree that differs from the submit tree beyond main\'s commits runs the gate [C7]', () => {
  assert.equal(landingReceiptReuse(closureInput({ drift: ['web/main.txt', 'web/elsewhere.js'] })).code, 'CANDIDATE_CHANGED');
  assert.equal(landingReceiptReuse(closureInput({ moved: null, drift: [] })).code, 'BASE_MOVED', 'main\'s change set cannot be read');
  assert.equal(landingReceiptReuse({ ...closureInput(), closure: null }).code, 'NOT_GREEN', 'an untiered landing keeps exact-tree reuse');
});

/**
 * A real tiered repository with a bare origin, per-item separate-publish landing and queued submits, whose focused
 * runner appends every file it runs to a log outside the checkout; plus one item whose frozen check runs its own test.
 */
async function tieredProject(helpers) {
  const box = helpers.project('true');
  const runs = join(box.dir, 'runner-runs.log');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  fixtureProjectPolicy(box.repo, { config: { ...config, submit: { ...config.submit, handoff: true }, affectedTests: 'node web/runner.js',
    landing: { ...(config.landing ?? {}), perItem: true, manualOverride: true, publish: 'separate', splitRed: false } } });
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  mkdirSync(join(box.repo, 'packages/gate/data/tests'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/gate/data/tests/tiers.json'), JSON.stringify({ version: 1, files: [] }));
  writeFileSync(join(box.repo, 'web/runner.js'), [
    "import { appendFileSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    'const files = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(runs)}, files.join(' ') + '\\n');`,
    "const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { encoding: 'utf8', env: process.env });",
    "process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');",
    'process.exitCode = run.status ?? 1;',
  ].join('\n') + '\n');
  // One module scope for the whole tree: a nested package.json leaves the import graph, and so every closure, unknown.
  const manifest = join(box.repo, 'package.json');
  writeFileSync(manifest, JSON.stringify({ ...(existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : {}), type: 'module' }));
  writeFileSync(join(box.repo, ITEM_TEST), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('item case [G1]', () => assert.equal(1, 1));\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-qm', 'chore: tiered project with a focused runner');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  const added = await fixtureAdd(box.runIn, box.repo, 'web', 'Change with its own test', '--specs', 'G1', '--route', 'strong',
    '--criterion', 'The change lands on its submit proof.', '--brief', `Files:\n- web/snapshot.txt\nTest:\n- ${ITEM_TEST}\n`,
    '--check', `node web/runner.js ${ITEM_TEST}`, '--wait', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  return { box, id: JSON.parse(added.out).item.item_id, runs: () => (existsSync(runs) ? readFileSync(runs, 'utf8').trim().split('\n').filter(Boolean).length : 0) };
}

/** The queued submit's job and the item's last submit event, read from the real board file read-only. */
function boardRecord(box, id) {
  const db = openBoardReadOnly(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    const submit = db.prepare("SELECT event_detail FROM event WHERE item_id = ? AND event_kind = 'submit' ORDER BY event_id DESC LIMIT 1").get(id);
    return { job: handoffRecord(db, id) ?? null, submit: submit ? JSON.parse(submit.event_detail) : null };
  } finally { db.close(); }
}

/** Claim, commit and submit the item through the real queued worker; returns its submitted commit. */
async function submitQueued(helpers, box, id) {
  const claimed = await box.runIn(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  const source = JSON.parse(claimed.out).itemFolder ?? box.web;
  const committed = helpers.commitFile(box, source, 'web/snapshot.txt', 'candidate\n', 'feat(web): change with its own test [G1]');
  assert.equal(committed.status, 0, committed.stderr);
  const submitted = await box.runIn(source, 'submit', String(id), '--no-next', '--json');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  await helpers.waitFor(() => ['green', 'infrastructure', 'red', 'incomplete'].includes(boardRecord(box, id).job?.state), // budget: real queued worker hang ceiling
    'queued worker terminal result', 100_000); // budget: hang ceiling for one real queued gate; no elapsed-time assertion
  return box.git(source, 'rev-parse', 'HEAD');
}

/** Accept the item at its submitted commit as the coordinator, from the main checkout. */
async function accept(box, id, commit) {
  box.git(box.repo, 'switch', '-q', '--detach', commit);
  try {
    const verdict = await box.runIn(box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'private landing fixture check passed');
    assert.equal(verdict.code, 0, verdict.err + verdict.out);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
}

/** Run one real landing batch on the fixture board and return its record and the landing's own lines. */
function landBatch(box, itemId) {
  const href = path => JSON.stringify(pathToFileURL(join(import.meta.dirname, path)).href);
  const source = [
    `import * as store from ${href('../../../../../packages/store/index.js')};`,
    `import { openBoard } from ${href('../../../../lib/index.js')};`,
    `import { loadConfig } from ${href('../../../../../packages/config/index.js')};`,
    `import { runLandingBatch } from ${href('../../../../../packages/landing/index.js')};`,
    `import { landingPorts } from ${JSON.stringify(new URL('../../../tests/fixtures/landing/ports.js', import.meta.url).href)};`,
    `import { checkAtCommit } from ${href('../../../../runner/index.js')};`,
    `const candidateWorkerFile = ${JSON.stringify(join(import.meta.dirname, '../../../../lib/src/io/landing/candidate.js'))};`,
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

/** Remove the fixtures without blocking the main thread once the owned worker has let go. */
async function cleanupQueued(helpers, box) {
  try {
    const jobsDir = join(box.repo, '.git/pullboard/submit-handoffs');
    const idle = () => !existsSync(jobsDir) || readdirSync(jobsDir).every(job => !existsSync(join(jobsDir, job, 'source')));
    await helpers.waitFor(idle, 'owned worker cleanup', 20_000); // budget: hang ceiling for the owned worker's exit; no elapsed-time assertion
  } catch { /* A worker still running past the ceiling is removed with its fixture below. */ }
  await Promise.all(helpers.sandboxes.map(dir => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
}

test('clause 2: a one-item batch with a green submit receipt and no changed closures runs zero tests at landing and lands [C7]', { timeout: 200_000 }, async t => {
  const helpers = createE2eHelpers();
  const { box, id, runs } = await tieredProject(helpers);
  t.after(() => cleanupQueued(helpers, box));
  const commit = await submitQueued(helpers, box, id);
  const record = boardRecord(box, id);
  assert.equal(record.job.state, 'green', JSON.stringify(record.job));
  assert.equal(record.submit.gateGreen, true, JSON.stringify(record.submit));
  await accept(box, id, commit);
  // Main moves past the submit by a file no test imports, so the merged tree differs from the submit's by main alone.
  assert.equal(helpers.commitFile(box, box.repo, 'web/main-moved.txt', 'main moved past the submit\n', 'chore(web): main moves past the submit [G1]').status, 0);
  const before = runs();
  const result = landBatch(box, id);
  assert.equal(result.error, null, JSON.stringify(result.lines));
  assert.ok(result.lines.some(line => line.includes(`reused #${id}'s submit receipt`) && line.includes('no test run started')), `landing reuses the submit receipt: ${result.lines.join('\n')}`);
  assert.ok(!result.lines.some(line => /not reused|selected; running|run finished/u.test(line)), `no landing test run started: ${result.lines.join('\n')}`);
  assert.equal(runs(), before, 'the focused runner ran no file at landing');
  assert.equal(result.batch.state, 'landed', JSON.stringify(result.batch));
  assert.ok(result.merged, 'the item lands on its reused submit proof');
});
