/** @pullboard-test-input packages/drive/src/io/queue.js packages/gate/data/ceilings/cells-edges.json */
/** @pullboard-world-pin: the apps-free clause reads the queue source and the committed ceiling. A finished test run reports its verdict through --status, and a run no worker took reports a typed refusal [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { after } from 'node:test';
import { test } from 'node:test';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { takeJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { parseStub } from '../../../jobs/index.js';
import { START_BOUND_MS } from '../../index.js';
import { endLostTestRuns } from '../../index.js';
import { ownTestRuns } from '../../index.js';
import { queueTestRun } from '../../index.js';
import { readTestRun } from '../../index.js';
import { testRunLines } from '../../index.js';
import { workTestRun } from '../../index.js';

const { root } = privateFixtureFiles('run-status-finished-');
after(() => rmSync(root, { recursive: true, force: true }));

/** A queued run on a fresh board whose detached worker is a stand-in that never starts. */
function queued(t, now) {
  const board = fixtureBoard(t);
  const ctx = { info: { commonDir: root, root } };
  const run = queueTestRun(ctx, work => work(board), { agent: 'seat', files: ['test/a.test.js'] },
    { launch: () => ({ unref() {} }), now });
  return { board, run };
}

test('drive.queue.a-run-whose-log-ends: a run whose log ends with the worker verdict reports it, not running [C7]: the result record never landed', (t) => {
  const { board, run } = queued(t, Date.now());
  takeJob(board.db, run.id, 'test-run:1', { leaseMs: 600_000 });
  writeStep(board.db, run.id, 'running', { pid: 1 });
  assert.equal(readTestRun(board, run.id).status, 'running');
  writeFileSync(run.log, 'admitted on host\npullboard test: red on host-1 in 47s\nnext: pullboard next\n');
  const found = readTestRun(board, run.id);
  assert.equal(found.status, 'red');
  assert.equal(found.result.runner, 'host-1');
  assert.equal(found.result.seconds, 47);
  assert.match(testRunLines(found)[0], /red on host-1 in 47s/u);
});

test('drive.queue.a-run-with-a-recorded: a run with a recorded result reports green or red [C7]: the board record wins', async (t) => {
  const { board, run } = queued(t, Date.now());
  await workTestRun(work => work(board), run.id, async () => ({ green: true, runner: 'host-2', seconds: 3, files: ['test/a.test.js'], logPath: run.log }));
  const found = readTestRun(board, run.id);
  assert.equal(found.status, 'green');
  assert.equal(found.result.seconds, 3);
});

test('drive.queue.a-run-no-worker-took: a run no worker took within the start bound reports TEST_RUN_NOT_STARTED [C7]: typed, not queued forever', (t) => {
  const { board, run } = queued(t, Date.now() - START_BOUND_MS - 1000);
  const found = readTestRun(board, run.id);
  assert.equal(found.status, 'refused');
  assert.equal(found.refusal.code, 'TEST_RUN_NOT_STARTED');
  assert.match(testRunLines(found)[0], /refused: \[TEST_RUN_NOT_STARTED\]/u);
  const fresh = queued(t, Date.now());
  assert.equal(readTestRun(fresh.board, fresh.run.id).status, 'queued');
});

test('drive.queue.a-test-run-whose-lease: a test run whose lease lapsed and whose worker is gone is marked lost and frees its slot [C7]: within 2 minutes', (t) => {
  const now = Date.now();
  const { board, run } = queued(t, now - 3 * 3_600_000);
  takeJob(board.db, run.id, 'test-run:424242', { now: now - 3 * 3_600_000, leaseMs: 120_000 });
  writeStep(board.db, run.id, 'running', { pid: 424242 }, { now: now - 3 * 3_600_000 });
  assert.equal(readTestRun(board, run.id).status, 'lost', 'a lapsed lease reads lost before the sweep');
  assert.deepEqual(endLostTestRuns(board.db, { now, alive: () => true }), [], 'a live worker keeps its run');
  const ended = endLostTestRuns(board.db, { now, alive: () => false });
  assert.equal(ended.length, 1);
  assert.equal(ended[0].id, run.id);
  assert.equal(board.db.prepare('SELECT job_lease_owner AS owner FROM job WHERE job_id = ?').get(run.id).owner, null, 'the lease is freed');
  assert.equal(readTestRun(board, run.id).status, 'lost');
  assert.deepEqual(endLostTestRuns(board.db, { now, alive: () => false }), [], 'a run is ended once');
});

test('drive.queue.a-run-with-a-live: a run with a live lease or a recorded result is never marked lost [C7]', async (t) => {
  const { board, run } = queued(t, Date.now());
  takeJob(board.db, run.id, `test-run:${process.pid}`);
  assert.deepEqual(endLostTestRuns(board.db, { alive: () => false }), []);
  const done = queued(t, Date.now());
  await workTestRun(work => work(done.board), done.run.id, async () => ({ green: true, files: [] }));
  assert.deepEqual(endLostTestRuns(done.board.db, { now: Date.now() + 3_600_000, alive: () => false }), []);
});

test('drive.queue.the-queue-names-no-apps: clause 1: the queue names no apps/ path, so its package-to-app ceiling row is gone [C7]', () => {
  const source = readFileSync(new URL('../../src/io/queue.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /apps\//u);
  const ceilings = JSON.parse(readFileSync(new URL('../../../gate/data/ceilings/cells-edges.json', import.meta.url), 'utf8'));
  assert.equal(ceilings.packageApps['packages/drive/src/io/queue.js'], undefined);
});

test('drive.queue.the-worker-runs-the-cli: clause 1: the worker runs the CLI entry its caller names [C7]', (t) => {
  const board = fixtureBoard(t);
  const seen = [];
  queueTestRun({ info: { commonDir: root, root } }, work => work(board), { agent: 'seat', files: ['a.test.js'] },
    { launch: (_node, args) => { seen.push(args[0]); return { unref() {} }; }, bin: '/some/cli.js' });
  assert.deepEqual(seen, ['/some/cli.js']);
});

/** Finish a queued run with a recorded result, the state most undelivered runs on a real board are in. */
async function finished(board, agent, files = ['test/a.test.js']) {
  const run = queueTestRun({ info: { commonDir: root, root } }, work => work(board), { agent, files }, { launch: () => ({ unref() {} }) });
  await workTestRun(work => work(board), run.id, async () => ({ green: true, runner: 'host-1', seconds: 1, files }));
  return run;
}

/** A board whose job_step reads are counted per job id, through a spy on prepare. */
function countingSteps(board) {
  const read = new Map();
  const prepare = board.db.prepare.bind(board.db);
  const db = new Proxy(board.db, { get: (target, key) => key !== 'prepare' ? Reflect.get(target, key) : (sql) => {
    const statement = prepare(sql);
    if (!/^SELECT \* FROM job_step WHERE job_step_job = \?/u.test(sql)) return statement;
    return { all: (job, ...rest) => { read.set(job, (read.get(job) ?? 0) + 1); return statement.all(job, ...rest); } };
  } });
  return { board: { ...board, db }, read };
}

test('drive.queue.own-runs-read-only-own-steps: clause 1: a seat\'s own test runs are read without reading any other seat\'s run steps [C7]: next stays flat as finished runs pile up', async (t) => {
  const board = fixtureBoard(t);
  for (let index = 0; index < 40; index += 1) await finished(board, `other-${index}`);
  const mine = await finished(board, 'seat');
  const counted = countingSteps(board);
  const runs = ownTestRuns(counted.board, 'seat');
  assert.deepEqual(runs.map(run => run.id), [mine.id]);
  assert.equal(runs[0].status, 'green');
  assert.deepEqual([...counted.read.keys()], [mine.id], 'only the seat\'s own run has its steps read');
});

test('drive.queue.own-runs-stub-payload-returns: clause 2: a run whose queued payload went to the blob store still comes back to its own seat only [C7]', async (t) => {
  const board = fixtureBoard(t, { storage: 'file', purpose: 'persistence' });
  const many = Array.from({ length: 3_000 }, (_, index) => `test/a-long-test-file-name-${index}.test.js`);
  const mine = await finished(board, 'seat', many);
  await finished(board, 'other', many);
  const stored = board.db.prepare("SELECT job_step_payload AS payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'queued'").get(mine.id).payload;
  assert.ok(parseStub(stored), 'the queued payload is a blob stub, so SQL sees no agent');
  assert.deepEqual(ownTestRuns(board, 'seat').map(run => run.id), [mine.id]);
  assert.deepEqual(ownTestRuns(board, 'nobody'), []);
});
