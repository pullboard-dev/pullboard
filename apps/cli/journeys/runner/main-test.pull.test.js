/** Pull runners claim main-test jobs: the board offers a queued main-test at main's commit, runner serve runs it, and its receipt is the keyed main receipt the gate's main-red verdict reads [C7,P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { apiHttpBox } from '../../tests/fixtures/api.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
import { mainRedLookup } from '../../../../packages/drive/index.js';
import { serveRunner } from '../../../../packages/drive/index.js';
import { returnedMainReceipts } from '../../../../packages/gate/src/io/main/verdict.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { jobView } from '../../../../packages/jobs/index.js';
import { mainRedStatus } from '../../../../packages/receipt/index.js';
import { provideMainTestRecorder } from '../../../../packages/api/index.js';
import { cachedMainComparison } from '../../../../packages/landing/index.js';
import { mainReceipts } from '../../../../packages/landing/index.js';
import { recordMainTestReceipt } from '../../../../packages/landing/index.js';

/** The project's test command; the job appends the one file it re-checks. */
const COMMAND = 'node --test --test-reporter=tap';

/** A board serving its job queue under pull, whose main holds one green and one red test file and is its trunk remote. */
async function mainBoard(t) {
  const box = await apiHttpBox(t);
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'pull' } });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: box.env, encoding: 'utf8' }).trim();
  mkdirSync(join(box.root, 'tests'), { recursive: true });
  writeFileSync(join(box.root, 'tests/green.test.js'), "import { test } from 'node:test';\ntest('main passes', () => {});\n");
  writeFileSync(join(box.root, 'tests/red.test.js'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('main fails', () => { assert.equal(1, 0); });\n");
  // The committed policy names the test command, which keys main's receipts in the comparison cache.
  const config = join(box.root, 'pullboard.json');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), affectedTests: COMMAND }, null, 2));
  git(box.root, 'add', 'tests', 'pullboard.json');
  git(box.root, 'commit', '-q', '-m', 'test: main test files');
  const trunk = join(box.dir, 'trunk.git');
  git(box.dir, 'clone', '-q', '--bare', box.root, trunk);
  const settings = join(box.root, 'pullboard.json');
  writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, 'utf8')), trunk: { remote: trunk } }, null, 2));
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => db.close());
  // The job's own test run is a top-level run, as on a real runner, not a child of this test's runner.
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (context !== undefined) process.env.NODE_TEST_CONTEXT = context; });
  return { db, root: box.root, main: git(box.root, 'rev-parse', 'HEAD'), tree: git(box.root, 'rev-parse', 'HEAD^{tree}'),
    board: `${box.origin}${box.path}?k=${box.key}`, cache: join(box.dir, 'runner-cache') };
}

/** Main's receipts as the gate's main-red verdict reads them from the board's main-test jobs. */
function ledger(db) {
  return returnedMainReceipts({ jobsOf }, db, 'main-test');
}

test('clause 1: a main-test job the main-red lookup enqueues is claimed by runner serve, run at the main commit, and its receipt is the one the main-red ledger reads [C7,P7]', { timeout: 120_000 }, // budget: hang ceiling for a private init, API start, a git fetch and two one-case test files.
async (t) => {
  const { db, main, tree, board, cache } = await mainBoard(t);
  const green = mainRedLookup(db, [], { tree, file: 'tests/green.test.js', command: COMMAND });
  const red = mainRedLookup(db, [], { tree, file: 'tests/red.test.js', command: COMMAND });
  assert.equal(jobView(db, green.job).step, 'queued', 'the lookup enqueues the job as before');
  assert.equal(green.status, 'missing');

  for (const runner of ['r-main-1', 'r-main-2']) {
    const served = await serveRunner({ board, runner, capabilities: ['node22'], cache: join(cache, runner), once: true, timing: { idleMs: 10 } });
    assert.equal(served.jobs.length, 1, JSON.stringify(served));
    assert.equal(served.jobs[0].outcome, 'posted', JSON.stringify(served.jobs[0]));
    assert.equal(served.jobs[0].receipt.commit, main, 'the job ran at the main commit holding the queued tree');
  }
  for (const job of [green.job, red.job]) assert.equal(jobView(db, job).step, 'done', `${job} finished`);

  const receipts = ledger(db);
  const greenStatus = mainRedStatus(receipts, { tree, file: 'tests/green.test.js', command: COMMAND });
  const redStatus = mainRedStatus(receipts, { tree, file: 'tests/red.test.js', command: COMMAND });
  assert.deepEqual([greenStatus.status, greenStatus.receipt], ['green', green.job], JSON.stringify(receipts));
  assert.deepEqual([redStatus.status, redStatus.receipt], ['red', red.job], JSON.stringify(receipts));
  assert.ok(receipts.filter(row => row.tree === tree).every(row => row.main === main && Number.isFinite(row.at)), 'each keyed receipt names main and when it was taken');
  assert.equal(mainRedLookup(db, receipts, { tree, file: 'tests/green.test.js', command: COMMAND }).job, null, 'a recorded receipt enqueues nothing more');
});

test('clause 2: with a free slot serving, no main-test job stays queued past one serve cycle: the claim after the enqueue takes it [C7,P7]', { timeout: 120_000 }, // budget: hang ceiling for a private init, API start, a git fetch and two one-case test files.
async (t) => {
  const { db, tree, board, cache } = await mainBoard(t);
  const jobs = ['tests/green.test.js', 'tests/red.test.js'].map(file => mainRedLookup(db, [], { tree, file, command: COMMAND }).job);
  const stop = new AbortController();
  const claims = [];
  const fetchImpl = async (url, init) => {
    const response = await fetch(url, init);
    const body = JSON.parse(init.body);
    if (body.action === 'claim') claims.push((await response.clone().json()).claim?.job ?? null);
    if (body.action === 'receipt' && jobs.every(job => jobView(db, job).step === 'done')) stop.abort();
    return response;
  };
  const served = await serveRunner({ board, runner: 'r-cycle', capabilities: ['node22'], cache, jobs: 2, cores: 4, signal: stop.signal, fetchImpl, timing: { idleMs: 50 } });
  assert.deepEqual(served.jobs.map(entry => entry.outcome).sort(), ['posted', 'posted'], JSON.stringify(served.jobs));
  assert.deepEqual(claims.slice(0, 2).sort(), [...jobs].sort(), `the first two claims took both queued jobs, none answered empty first: ${JSON.stringify(claims)}`);
  assert.deepEqual(db.prepare("SELECT job_id FROM job WHERE job_kind = 'main-test' AND job_step = 'queued'").all(), [], 'no main-test job is left queued');
});

test('clause 3: a finished main-test job reaches the main comparison cache, so a later receipt lookup at that main finds it instead of reporting it missing [C7,P7]', { timeout: 120_000 }, // budget: hang ceiling for a private init, API start, a git fetch and two one-case test files.
async (t) => {
  provideMainTestRecorder(recordMainTestReceipt);
  t.after(() => provideMainTestRecorder(null));
  const { db, main, tree, board, cache, root } = await mainBoard(t);
  const files = ['tests/green.test.js', 'tests/red.test.js'];
  const [green, red] = files.map(file => mainRedLookup(db, [], { tree, file, command: COMMAND }));
  assert.deepEqual(mainReceipts(root, main, files).rows.size, 0, 'before the job the cache holds no receipt');
  for (const runner of ['r-cache-1', 'r-cache-2']) {
    const served = await serveRunner({ board, runner, capabilities: ['node22'], cache: join(cache, runner), once: true, timing: { idleMs: 10 } });
    assert.equal(served.jobs[0]?.outcome, 'posted', JSON.stringify(served));
  }
  const cached = cachedMainComparison(root, main, files);
  assert.deepEqual(cached.files.map(row => [row.file, row.result, row.receiptId]).sort(), [['tests/green.test.js', 'green', green.job], ['tests/red.test.js', 'red', red.job]].sort(), JSON.stringify(cached));
  const known = mainReceipts(root, main, files);
  for (const file of files) assert.notEqual(mainRedStatus(known.receipts, { tree, file, command: known.command }).status, 'missing', `${file} is no longer missing`);
});
