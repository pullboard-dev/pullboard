/** The board API serves its runner job queue on loopback, only under gate.runnerDispatch pull [P7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';
import { fetchFresh } from '../../../sync/tests/fixtures/http.js';
import { runnerDispatchMode } from '../../../config/index.js';
import { gateAgedMs } from '../../../config/index.js';
import { jobView } from '../../../jobs/index.js';
import { LEASE_MS } from '../../../jobs/index.js';
import { settledGate } from '../../../jobs/index.js';
import { createApiHandler } from '../../index.js';
import { jobQueueCall } from '../../index.js';
import { offerJob } from '../../index.js';
import { claimJob } from '../../index.js';
import { endJobs } from '../../index.js';
import { renewJob } from '../../index.js';
import { postReceipt } from '../../index.js';
import { gateClaimHop } from '../../index.js';
import { provideGateHopTable } from '../../index.js';
import { readGateHop } from '../../../store/index.js';
import { runnerCommitPort } from '../../index.js';
import { MACHINE_DEFAULTS } from '../../../config/index.js';
import { runnerCommitReportEnabled } from '../../../config/index.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';

/** The renderer the API takes as a port: a refusal becomes its public error body. */
function refusalDocument(error) {
  return { error: { code: error.code ?? 'INTERNAL', message: String(error.message) } };
}

test('api.jobs.clauses-over-loopback-api-runner: clauses 1-3: over the loopback API a runner claims by capability, a rival gets nothing, and its receipt lands under the job [P7]', async (t) => {
  const { root } = privateFixtureFiles('pullboard-jobs-api-');
  const home = join(root, 'machine-home');
  mkdirSync(home, { recursive: true });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const db = cellBoard(t, join(root, 'board.sqlite')).db;
  offerJob(db, { id: 'gate:http', kind: 'gate', needs: ['node22'] });
  // The local adapter's jobs port, as packages/api/src/io/main.js wires it; the queue mode is a port, so the test names it: refused first, then pull [P7].
  let mode = 'controller';
  const handler = createApiHandler({ refusalDocument,
    authenticate: () => ({ local: true }),
    board: (id) => ({ id }),
    jobs: (board, body) => jobQueueCall(db, body, { mode }),
  });
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  const jobs = async (body) => {
    const response = await fetchFresh(`http://127.0.0.1:${server.address().port}/api/v1/boards/fixture/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, document: await response.json() };
  };

  const off = await jobs({ action: 'claim', runner: 'r-a', capabilities: ['node22'] });
  assert.deepEqual([off.status, off.document.error.code], [400, 'JOBS_NOT_PULL'], 'the controller path never serves the queue');
  assert.equal(jobView(db, 'gate:http').leaseOwner, null);

  mode = runnerDispatchMode();
  assert.equal((await jobs({ action: 'claim', runner: 'r-thin', capabilities: [] })).document.claim, null, 'a runner without node22 takes nothing');
  const won = await jobs({ action: 'claim', runner: 'r-a', capabilities: ['node22', 'browser'] });
  assert.equal(won.status, 200);
  assert.deepEqual([won.document.claim.job, won.document.claim.attempt], ['gate:http', 1]);
  assert.equal((await jobs({ action: 'claim', runner: 'r-b', capabilities: ['node22'] })).document.claim, null, 'a second claimant is refused while the lease lives');
  const { token } = won.document.claim;
  assert.equal((await jobs({ action: 'renew', job: 'gate:http', runner: 'r-a', token })).document.renewed, true);

  const forged = await jobs({ action: 'receipt', job: 'gate:http', runner: 'r-b', token, receipt: { status: 0 } });
  assert.equal(forged.document.error.code, 'JOB_LEASE_MOVED', 'a receipt from a runner without the claim is refused');
  const posted = await jobs({ action: 'receipt', job: 'gate:http', runner: 'r-a', token, receipt: { status: 0, digest: 'f00d' } });
  assert.deepEqual([posted.status, posted.document.recorded], [200, true]);
  const view = jobView(db, 'gate:http');
  assert.equal(view.step, 'done');
  assert.deepEqual(view.steps.find(step => step.name === 'receipt').payload, { runner: 'r-a', attempt: 1, receipt: { status: 0, digest: 'f00d' } });
});

test('api.jobs.large-change-gate-request-over: clause 1: a large-change gate request over 60 KiB is offered with its big parts named, and the runner holding it reads it back whole [P7]', (t) => {
  const { root } = privateFixtureFiles('pullboard-jobs-large-');
  const db = cellBoard(t, join(root, 'board.sqlite')).db;
  // Shaped as submit's gate request (#5417): inlined entry code, a config whose lanes block grew (#6150), and a change of 2,000 files.
  const owns = Array.from({ length: 1500 }, (_, n) => `apps/view/src/logic/render/part-${n}.js`);
  const files = Array.from({ length: 2000 }, (_, n) => `packages/big/src/file-${n}.js`);
  const request = { run: ['node', '--input-type=module', '-e', 'x'.repeat(2600)], commits: ['a'.repeat(40)],
    input: { main: 'a'.repeat(40), entry: 'e'.repeat(17_580), data: { check: 'node apps/cli/pullboard.js test packages/api/tests/io/jobs.test.js', shards: true,
      analysisEntry: 'n'.repeat(15_271), analysis: { criterion: '1. large [test]', config: { lanes: { view: { owns } } }, crossRunTests: files.slice(0, 300) } } },
    submit: { agentId: 'core-1', digest: 'd'.repeat(64), tree: 't'.repeat(40), files } };
  const size = Buffer.byteLength(JSON.stringify(request));
  assert.ok(size > 60 * 1024, `the request is a large change (${size} bytes)`);

  offerJob(db, { id: 'gate:large', kind: 'gate', needs: ['node22'], item: 5417, candidate: 'c'.repeat(40), base: 'a'.repeat(40), request });
  const row = db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = 'gate:large' AND job_step_name = 'offered'").get();
  assert.ok(Buffer.byteLength(row.job_step_payload) <= 60 * 1024, 'the offered row the claim scan reads stays under REQUEST_BYTES');
  const offered = JSON.parse(row.job_step_payload).request;
  assert.equal(offered.input.data.check, request.input.data.check, 'small fields stay inline for the board readers');
  assert.equal(offered.submit.files.$named, 'request', 'the change list is named by the job\'s request step, not inlined');
  assert.equal(jobView(db, 'gate:large').step, 'offered');

  const claim = jobQueueCall(db, { action: 'claim', runner: 'r-a', capabilities: ['node22'] }, { mode: 'pull' }).claim;
  assert.equal(claim?.job, 'gate:large', 'the large-change job is offered and claimable');
  const input = jobQueueCall(db, { action: 'request', job: 'gate:large', runner: 'r-a', token: claim.token }, { mode: 'pull' });
  assert.deepEqual(input.request, request, 'the runner holding the job reads the whole request back');
});

test('api.jobs.a-pulled-gate-receipt-holds-queuewaitseconds-claim: clause 1: a pulled gate job receipt holds queueWaitSeconds, its first claim minus its enqueue time, and shows on the settled gate [C7,#10524]', (t) => {
  const db = cellBoard(t, ':memory:').db;
  offerJob(db, { id: 'gate:wait', kind: 'gate', needs: [] });
  offerJob(db, { id: 'gate:none', kind: 'gate', needs: [] });
  db.prepare('UPDATE job SET job_created = 1000000 WHERE job_id IN (?, ?)').run('gate:wait', 'gate:none');
  const claim = jobQueueCall(db, { action: 'claim', runner: 'r-a', capabilities: [] }, { mode: 'pull', now: 1007500 }).claim;
  const other = jobQueueCall(db, { action: 'claim', runner: 'r-b', capabilities: [] }, { mode: 'pull', now: 1012000 }).claim;
  const gate = { green: true, phases: [{ role: 'check', status: 0 }] };
  jobQueueCall(db, { action: 'receipt', job: claim.job, runner: 'r-a', token: claim.token, receipt: { status: 0, gate } }, { mode: 'pull', now: 1020000 });
  jobQueueCall(db, { action: 'receipt', job: other.job, runner: 'r-b', token: other.token, receipt: { status: 0, digest: 'f00d' } }, { mode: 'pull', now: 1020000 });
  const waits = Object.fromEntries([claim, other].map(held => [held.job, jobView(db, held.job).steps.find(step => step.name === 'receipt').payload.receipt.queueWaitSeconds]));
  assert.equal(waits[claim.job], 7.5);
  assert.equal(waits[other.job], undefined, 'a receipt with no gate is stored as it was posted');
  const posted = jobView(db, claim.job).steps.find(step => step.name === 'receipt').payload;
  assert.equal(settledGate(claim.job, posted).queueWaitSeconds, 7.5);
});

test('api.jobs.claim-except-skips-kinds: #10794: a claim naming except skips open jobs of those kinds and takes any other kind; a claim without it takes them as before [C7]', (t) => {
  const db = cellBoard(t, ':memory:').db;
  offerJob(db, { id: 'baseline:1:a', kind: 'check-baseline', needs: [] });
  offerJob(db, { id: 'gate:except', kind: 'gate', needs: [] });
  db.prepare('UPDATE job SET job_created = 1000000 WHERE job_id = ?').run('baseline:1:a');
  const claim = body => jobQueueCall(db, { action: 'claim', capabilities: [], ...body }, { mode: 'pull' }).claim;
  assert.equal(claim({ runner: 'local-a', except: ['check-baseline'] })?.job, 'gate:except', 'the baseline is skipped and the gate taken');
  assert.equal(claim({ runner: 'local-a', except: ['check-baseline'] }), null, 'only the excepted kind is left, so nothing is claimed');
  assert.equal(claim({ runner: 'local-b' })?.job, 'baseline:1:a', 'a claim without except takes it');
  assert.throws(() => claim({ runner: 'local-c', except: 'check-baseline' }), { code: 'JOB_CAPABILITY' }, 'except is a list of names');
});

/** A held claim of one offered gate job, and a call that posts as its runner. */
function heldGate(t, id) {
  const db = cellBoard(t, ':memory:').db;
  offerJob(db, { id, kind: 'gate', needs: [] });
  const claim = jobQueueCall(db, { action: 'claim', runner: 'r-a', capabilities: [] }, { mode: 'pull' }).claim;
  const call = (body, options = {}) => jobQueueCall(db, { job: claim.job, runner: 'r-a', token: claim.token, ...body }, { mode: 'pull', ...options });
  return { db, claim, call };
}

/** The gateParts a receipt names for this gate JSON text. */
function partsOf(text, count) {
  return { count, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') };
}

test('api.jobs.receipt-parts-any-size: clause 1: a gate receipt over 100 KiB posts as receiptPart calls, each one queue call, and the board stores and applies it whole with every proofPlan file [C7,P7,#10771]', (t) => {
  const { db, claim, call } = heldGate(t, 'gate:big');
  const files = Array.from({ length: 2000 }, (_, n) => `packages/store/tests/io/queued/red/case-${n}.test.js`);
  const gate = { version: 1, green: false, proofPlan: { runner: 'node --test', files, cores: 12, account: true } };
  const text = JSON.stringify(gate);
  assert.ok(Buffer.byteLength(text) > 100 * 1024, 'the receipt is over 100 KiB');
  assert.throws(() => call({ action: 'receipt', receipt: { status: 0, gate } }), { code: 'JOB_RECEIPT' }, 'one call still carries at most 64 KiB');
  const size = 32 * 1024, count = Math.ceil(text.length / size);
  for (let index = 0; index < count; index += 1) assert.equal(call({ action: 'receiptPart', part: { index, count, text: text.slice(index * size, (index + 1) * size) } }).recorded, true);
  const applied = [];
  const posted = call({ action: 'receipt', receipt: { status: 1, gateParts: partsOf(text, count) } }, { onReceipt: row => { applied.push(row); return { applied: true }; } });
  assert.equal(posted.recorded, true);
  const steps = jobView(db, claim.job).steps;
  const stored = steps.find(step => step.name === 'receipt').payload.receipt;
  assert.deepEqual(stored.gate.proofPlan.files, files, 'the stored receipt holds every proof file');
  assert.equal(stored.gateParts, undefined);
  assert.deepEqual(applied[0].receipt.gate.proofPlan.files, files, 'the receipt the board applies is whole');
  assert.deepEqual(steps.filter(step => step.name.startsWith('artifact:receipt-part.')), [], 'the joined parts are dropped');
});

test('api.jobs.receipt-parts-refused: clause 2: a receipt part from a runner not holding the claim is refused, and a receipt whose parts are missing or do not match gateParts is refused JOB_RECEIPT and records nothing [C7,P7,#10771]', (t) => {
  const { db, claim, call } = heldGate(t, 'gate:parts');
  const text = JSON.stringify({ version: 1, green: true, phases: [{ role: 'check', status: 0 }] }), half = Math.ceil(text.length / 2);
  assert.throws(() => jobQueueCall(db, { action: 'receiptPart', job: claim.job, runner: 'r-b', token: 'r-b:1', part: { index: 0, count: 2, text } }, { mode: 'pull' }), { code: /^JOB_/u });
  call({ action: 'receiptPart', part: { index: 0, count: 2, text: text.slice(0, half) } });
  const receipt = { status: 0, gateParts: partsOf(text, 2) };
  assert.throws(() => call({ action: 'receipt', receipt }), { code: 'JOB_RECEIPT' }, 'a part never posted');
  call({ action: 'receiptPart', part: { index: 1, count: 2, text: `${text.slice(half)} ` } });
  assert.throws(() => call({ action: 'receipt', receipt }), { code: 'JOB_RECEIPT' }, 'a join that does not match its sha256');
  assert.equal(jobView(db, claim.job).steps.some(step => step.name === 'receipt'), false, 'a refused receipt records nothing');
  assert.equal(db.prepare('SELECT job_step AS step FROM job WHERE job_id = ?').get(claim.job).step, 'claimed', 'the job stays claimed');
  call({ action: 'receiptPart', part: { index: 1, count: 2, text: text.slice(half) } });
  assert.equal(call({ action: 'receipt', receipt }).recorded, true, 'the part posted again replaces the wrong one');
});

/** A private machine home for this test holding these settings, restored after it. */
function machineWith(t, settings) {
  const home = join(privateFixtureFiles('pullboard-jobs-home-').root, 'machine-home');
  mkdirSync(home, { recursive: true });
  if (settings) fixtureMachineSettings(home, settings);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
}

/** A loopback board API whose jobs port is wired as packages/api/src/io/main.js wires it: the runnerCommit port for this root, on when `enabled` is or, unnamed, when this machine's runners.reportCommit is. */
async function loopbackQueue(t, db, root, enabled) {
  const handler = createApiHandler({ refusalDocument,
    authenticate: () => ({ local: true }),
    board: (id) => ({ id }),
    jobs: (board, body) => jobQueueCall(db, body, { mode: 'pull', trunk: () => root, runnerCommit: body?.action === 'claim' ? runnerCommitPort(root, enabled ?? runnerCommitReportEnabled()) : null }),
  });
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  return async (body) => {
    const response = await fetchFresh(`http://127.0.0.1:${server.address().port}/api/v1/boards/fixture/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, text: await response.text() };
  };
}

test('api.jobs.claim-names-runner-commit: clause 1: with runners.reportCommit on, every claim answer over the loopback API, with a job or empty, names runnerCommit, the commit the board\'s trunk main ref points at [C7,#10819]', async (t) => {
  const repo = cellRepo(t, { real: true });
  machineWith(t, { 'runners.reportCommit': true });
  const db = cellBoard(t, ':memory:').db;
  offerJob(db, { id: 'gate:commit', kind: 'gate', needs: ['node22'] });
  const jobs = await loopbackQueue(t, db, repo.root, undefined);

  const empty = JSON.parse((await jobs({ action: 'claim', runner: 'r-thin', capabilities: [] })).text);
  assert.deepEqual(empty, { version: 1, claim: null, runnerCommit: repo.commit }, 'an empty claim answer names the trunk main commit');
  const won = JSON.parse((await jobs({ action: 'claim', runner: 'r-a', capabilities: ['node22'] })).text);
  assert.equal(won.claim.job, 'gate:commit');
  assert.equal(won.trunk, repo.root);
  assert.equal(won.runnerCommit, repo.commit, 'a claim that hands out a job names it too');

  repo.put('runner.js', 'export const moved = 1;\n');
  const moved = repo.commitAll();
  assert.notEqual(moved, repo.commit);
  const busy = JSON.parse((await jobs({ action: 'claim', runner: 'r-a', capabilities: ['node22'] })).text);
  assert.deepEqual(busy, { version: 1, claim: null, runnerCommit: moved }, 'a busy runner\'s next claim names the commit main moved to');
});

test('api.jobs.claim-runner-commit-null: clause 2: a board whose trunk ref cannot be read answers runnerCommit null, and the claim is otherwise unchanged [C7,#10819]', async (t) => {
  const { root } = privateFixtureFiles('pullboard-jobs-no-ref-');
  const db = cellBoard(t, ':memory:').db;
  offerJob(db, { id: 'gate:noref', kind: 'gate', needs: [] });
  const jobs = await loopbackQueue(t, db, root, true);
  const won = JSON.parse((await jobs({ action: 'claim', runner: 'r-a', capabilities: [] })).text);
  assert.deepEqual(Object.keys(won), ['version', 'claim', 'trunk', 'runnerCommit']);
  assert.equal(won.runnerCommit, null, 'a folder with no Git ref names no commit');
  assert.deepEqual([won.claim.job, won.claim.attempt, won.trunk], ['gate:noref', 1, root], 'the claim itself is today\'s');
  assert.equal(jobView(db, 'gate:noref').leaseOwner, 'r-a');
  for (const read of [() => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); }, () => 'ref: refs/heads/main', () => null]) {
    assert.deepEqual(jobQueueCall(db, { action: 'claim', runner: 'r-b', capabilities: [] }, { mode: 'pull', runnerCommit: read }), { claim: null, runnerCommit: null }, 'a ref read that throws or names no commit answers null');
  }
});

test('api.jobs.claim-runner-commit-off: clause 3: with runners.reportCommit off (the default) the claim answer is byte-for-byte today\'s [C7,#10819]', async (t) => {
  const repo = cellRepo(t, { real: true });
  machineWith(t, null);
  assert.equal(MACHINE_DEFAULTS['runners.reportCommit'], false, 'the setting defaults off');
  assert.equal(runnerCommitReportEnabled(), false);
  assert.equal(runnerCommitPort(repo.root, runnerCommitReportEnabled()), null, 'off, the API passes no runnerCommit port');
  const db = cellBoard(t, ':memory:').db;
  offerJob(db, { id: 'gate:off', kind: 'gate', needs: [] });
  const jobs = await loopbackQueue(t, db, repo.root, undefined);
  const won = await jobs({ action: 'claim', runner: 'r-a', capabilities: [] });
  const claim = JSON.parse(won.text).claim;
  assert.equal(won.text, JSON.stringify({ version: 1, claim, trunk: repo.root }), 'a claim with a job carries only claim and trunk');
  assert.equal((await jobs({ action: 'claim', runner: 'r-b', capabilities: [] })).text, '{"version":1,"claim":null}', 'an empty claim answer is exactly today\'s');
  assert.equal(JSON.stringify(jobQueueCall(db, { action: 'claim', runner: 'r-c', capabilities: [] }, { mode: 'pull', runnerCommit: null })), '{"claim":null}', 'no port is the call as it was');
});

/** A board with one claimed gate job and a shadow whose decide takes `spinMs` inside the write transaction. */
function claimedWithShadow(t, spinMs, boundMs, real = false) {
  const { root } = privateFixtureFiles('pullboard-jobs-bound-');
  const file = join(root, 'board.sqlite');
  const { db } = cellBoard(t, file, undefined, { real });
  offerJob(db, { id: 'gate:bound', kind: 'gate', now: 1000 });
  const claim = claimJob(db, { runner: 'mill', now: 10_000, leaseMs: 120_000 });
  db.jobWriteBoundMs = boundMs;
  db.jobQueueShadow = {
    decide: () => { const end = Date.now() + spinMs; while (Date.now() < end); return { patch: {} }; },
    seen: () => {},
  };
  return { db, claim, file };
}

test('api.io-jobs.write-time-bound: clause 1: a renewJob whose write runs past the bound rolls back and refuses, and a peer BEGIN IMMEDIATE succeeds right after [C7,#11029]', (t) => {
  const { db, claim } = claimedWithShadow(t, 40, 10);
  assert.throws(() => renewJob(db, { job: 'gate:bound', runner: 'mill', token: claim.token, now: 20_000, leaseMs: 120_000 }), { code: 'JOB_WRITE_TIMEOUT' });
  assert.equal(db.prepare("SELECT job_lease_until AS until FROM job WHERE job_id = 'gate:bound'").get().until, 130_000, 'the lease is the claim\'s, the renewal rolled back');
  db.exec('BEGIN IMMEDIATE');
  db.exec('ROLLBACK');
});

test('api.io-jobs.fast-write-unchanged: clause 2: a renewJob and a postReceipt inside the bound commit as before [C7,#11029]', (t) => {
  const { db, claim } = claimedWithShadow(t, 0, 60_000);
  const renewed = renewJob(db, { job: 'gate:bound', runner: 'mill', token: claim.token, now: 20_000, leaseMs: 120_000 });
  assert.deepEqual(renewed, { renewed: true, leaseUntil: 140_000 });
  postReceipt(db, { job: 'gate:bound', runner: 'mill', token: claim.token, receipt: { ok: true }, now: 30_000 });
  assert.equal(db.prepare("SELECT job_step AS step FROM job WHERE job_id = 'gate:bound'").get().step, 'done');
});

/** Hold the board lock from another thread for `holdMs`, returning once it is held: the caller's next write queues behind it. */
function holdLockFromThread(file, holdMs) {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const code = `const { workerData: w } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(w.file);
    db.exec('BEGIN IMMEDIATE');
    Atomics.store(w.flag, 0, 1); Atomics.notify(w.flag, 0);
    const end = Date.now() + w.holdMs; while (Date.now() < end);
    db.exec('COMMIT'); db.close();`;
  const worker = new Worker(code, { eval: true, workerData: { file, holdMs, flag } });
  Atomics.wait(flag, 0, 0, 10_000);
  return worker;
}

test('api.io-jobs.bound-counts-hold-not-wait: clause 1: a job write queued behind another connection holding the lock past the bound commits once that lock frees, when its own hold is short [C7,#11914]', async (t) => {
  const { db, claim, file } = claimedWithShadow(t, 0, 100, true);
  const holder = holdLockFromThread(file, 400);
  const renewed = renewJob(db, { job: 'gate:bound', runner: 'mill', token: claim.token, now: 20_000, leaseMs: 120_000 });
  await once(holder, 'exit');
  assert.deepEqual(renewed, { renewed: true, leaseUntil: 140_000 });
  assert.equal(db.prepare("SELECT job_lease_until AS until FROM job WHERE job_id = 'gate:bound'").get().until, 140_000, 'the renewal committed');
});

test('api.io-jobs.bound-still-rolls-back-long-hold: clause 2: a job write whose own hold passes the bound is still rolled back with JOB_WRITE_TIMEOUT [C7,#11914]', async (t) => {
  const { db, claim, file } = claimedWithShadow(t, 150, 100, true);
  const holder = holdLockFromThread(file, 200);
  assert.throws(() => renewJob(db, { job: 'gate:bound', runner: 'mill', token: claim.token, now: 20_000, leaseMs: 120_000 }), { code: 'JOB_WRITE_TIMEOUT' });
  await once(holder, 'exit');
  assert.equal(db.prepare("SELECT job_lease_until AS until FROM job WHERE job_id = 'gate:bound'").get().until, 130_000, 'the renewal rolled back');
});

test('api.jobs.claims-shards-before-tests-over-claim-action: clause 3: over the claim action a runner holding one test job and offered shards plus tests is handed a shard [C7,#11146]', (t) => {
  const { root } = privateFixtureFiles('pullboard-jobs-shard-first-');
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  offerJob(db, { id: 'test:one', kind: 'test', now: 1000 });
  offerJob(db, { id: 'gate:9:shard:1', kind: 'gate-shard', now: 1001 });
  offerJob(db, { id: 'test:two', kind: 'test', now: 1002 });
  const claim = (now) => jobQueueCall(db, { action: 'claim', runner: 'r-a', capabilities: [] }, { mode: 'pull', now }).claim?.job;
  assert.equal(claim(5000), 'test:one', 'a runner holding no test job takes the oldest test job');
  assert.equal(claim(5001), 'gate:9:shard:1', 'a runner holding a test job is handed the queued shard before the newer test job');
  assert.equal(claim(5002), 'test:two');
});

test('api.jobs.claims-aged-gate-job-over-claim-action: clause 3: over the claim action a runner holding a test job is handed a gate job offered 6 minutes earlier before the queued shards [C7,#11873]', (t) => {
  const { root } = privateFixtureFiles('pullboard-jobs-gate-aged-');
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  offerJob(db, { id: 'test:one', kind: 'test', now: 280_000 });
  offerJob(db, { id: 'gate:9:shard:1', kind: 'gate-shard', now: 1001 });
  offerJob(db, { id: 'gate:9', kind: 'gate', now: 1002 });
  const claim = (now) => jobQueueCall(db, { action: 'claim', runner: 'r-a', capabilities: [] }, { mode: 'pull', now }).claim?.job;
  assert.equal(claim(290_000), 'test:one', 'a runner holding no test job takes the test job; the gate job is 4.8 minutes old');
  assert.equal(claim(302_000), 'gate:9', 'the gate job is now 5 minutes old and is handed before the queued shard');
  assert.equal(claim(302_001), 'gate:9:shard:1');
});

/** A board where a runner holds a test job, then claims over the claim action with gateAgedMs read from the machine settings the case wrote, as packages/api/src/io/main.js passes it. */
function agedSettingBoard(t, settings) {
  const { root } = privateFixtureFiles('pullboard-jobs-gate-aged-setting-');
  const home = join(root, 'machine-home');
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, settings);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  offerJob(db, { id: 'test:one', kind: 'test', now: 150_000 });
  offerJob(db, { id: 'gate:9:shard:1', kind: 'gate-shard', now: 1001 });
  const claim = (now) => jobQueueCall(db, { action: 'claim', runner: 'r-a', capabilities: [] }, { mode: 'pull', now, gateAgedMs }).claim?.job;
  assert.equal(claim(160_000), 'test:one', 'a runner holding no test job takes the test job');
  offerJob(db, { id: 'gate:9', kind: 'gate', now: 10_000 });
  return claim;
}

test('api.jobs.claims-gate-aged-minutes-setting: clause 1: with gate.gateAgedMinutes 2 set in machine settings, over the claim action a gate job offered 3 minutes before the claim is handed to a runner holding a test job ahead of fresh shards [C7,#11875]', (t) => {
  const claim = agedSettingBoard(t, { gate: { gateAgedMinutes: 2 } });
  assert.equal(claim(190_000), 'gate:9', 'the 3-minute-old gate job passes the 2-minute setting and goes before the shard');
  assert.equal(claim(190_001), 'gate:9:shard:1');
});

test('api.jobs.claims-gate-aged-minutes-unset: clause 2: with gate.gateAgedMinutes unset the same 3-minute-old gate job stays behind the shards over the claim action [C7,#11875]', (t) => {
  const claim = agedSettingBoard(t, {});
  assert.equal(claim(190_000), 'gate:9:shard:1', 'the default is 5 minutes, so the shard goes first');
  assert.equal(claim(190_001), 'gate:9');
});

/** A board with a runner already holding `shards` gate shards and `tests` test jobs, plus the further jobs the case offers; claims go through claimJob with the cores it names. */
function budgetBoard(t, { cores, shards, tests, offered }) {
  const { root } = privateFixtureFiles('pullboard-jobs-cores-budget-');
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  let at = 1000;
  for (let i = 0; i < shards; i += 1) offerJob(db, { id: `gate:11148:shard:${i}`, kind: 'gate-shard', now: at += 1 });
  for (let i = 0; i < tests; i += 1) offerJob(db, { id: `test:held:${i}`, kind: 'test', now: at += 1 });
  const take = (now) => claimJob(db, { runner: 'r-a', cores, jobs: 20, now })?.job ?? null;
  for (let i = 0; i < shards + tests; i += 1) take(5000 + i);
  for (const [id, kind] of offered) offerJob(db, { id, kind, now: at += 1 });
  return { db, take, now: 6000 };
}

test('api.jobs.cores-budget-shared-by-heavy-kinds: clause 1: a runner reporting 10 cores holding 3 gate shards and 1 test job is offered no further shard or test job, while a landing job is still offered [C7,#11148]', (t) => {
  const { db, take, now } = budgetBoard(t, { cores: 10, shards: 3, tests: 1, offered: [['gate:11148:shard:late', 'gate-shard'], ['test:late', 'test'], ['land:late', 'land']] });
  assert.equal(take(now), 'land:late', 'the shard and the test job wait; the landing job is not weighed');
  assert.equal(take(now + 1), null, 'nothing heavy is offered while the held weight fills the cores');
  assert.deepEqual(endJobs(db, ['test:held:0'], { now: now + 2 }), ['test:held:0'], 'the held test job ends');
  assert.equal(take(now + 3), 'test:late', 'once a held job ends, the waiting test job fits the freed core and is offered; the shard still waits for three');
  assert.equal(take(now + 4), null, 'the budget is full again');
});

test('api.jobs.test-floor-under-full-shard-budget: clause 2: a runner holding no test job is offered one even when its shards fill its budget, and no second one [C7,#11148]', (t) => {
  const { take, now } = budgetBoard(t, { cores: 9, shards: 3, tests: 0, offered: [['test:first', 'test'], ['test:second', 'test']] });
  assert.equal(take(now), 'test:first', 'the builder floor offers one test job over a full shard budget');
  assert.equal(take(now + 1), null, 'a second test job waits for the budget');
});

test('api.jobs.no-cores-and-shard-cap-unchanged: clause 3: a claim reporting no cores takes shards and tests as on main, and 10 cores still cap a runner at 3 shards [C7,#11148]', (t) => {
  const { root } = privateFixtureFiles('pullboard-jobs-cores-budget-off-');
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  for (let i = 0; i < 4; i += 1) offerJob(db, { id: `gate:11148:shard:${i}`, kind: 'gate-shard', now: 1000 + i });
  for (let i = 0; i < 4; i += 1) offerJob(db, { id: `test:${i}`, kind: 'test', now: 2000 + i });
  const none = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => claimJob(db, { runner: 'r-none', now: 5000 + i })?.job ?? null);
  assert.ok(none.every(Boolean), 'a claim with no cores weighs nothing, so eight jobs are handed out');
  const { take, now } = budgetBoard(t, { cores: 10, shards: 3, tests: 0, offered: [['gate:11148:shard:extra', 'gate-shard']] });
  assert.equal(take(now), null, 'the per-runner cap of floor(10 / 3) shards holds');
});

test('api.jobs.claims-aged-test-before-shards-over-claim-action: clause 3: over the claim action a runner holding one test job and offered a 3-minute-old test job and queued shards is handed the test job [C7,#11190]', (t) => {
  const { root } = privateFixtureFiles('pullboard-jobs-aged-test-');
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  offerJob(db, { id: 'test:one', kind: 'test', now: 1000 });
  offerJob(db, { id: 'test:old', kind: 'test', now: 2000 });
  offerJob(db, { id: 'gate:9:shard:1', kind: 'gate-shard', now: 3000 });
  const claim = (now) => jobQueueCall(db, { action: 'claim', runner: 'r-a', capabilities: [] }, { mode: 'pull', now }).claim?.job;
  assert.equal(claim(181_000), 'test:one', 'a runner holding no test job takes the oldest test job');
  assert.equal(claim(182_000), 'test:old', 'a runner holding a test job is handed the 3-minute-old test job before the queued shard');
  assert.equal(claim(182_001), 'gate:9:shard:1');
});

test('api.io-claim-key.retry-after-abort-returns-same-lease: clause 1: the board commits a keyed claim whose first response is aborted; the retry with the same key gets the same job and token with no lapsed lease and no second job, and another key takes another job [C7]', async (t) => {
  const { root } = privateFixtureFiles('pullboard-jobs-claim-key-');
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  offerJob(db, { id: 'test:first', kind: 'test', now: 1000 });
  offerJob(db, { id: 'test:second', kind: 'test', now: 1001 });
  // The production route: the board commits the claim, then the runner's call is cut before the answer reaches it.
  let cut = null;
  let committed = null;
  const handler = createApiHandler({ refusalDocument,
    authenticate: () => ({ local: true }),
    board: (id) => ({ id }),
    jobs: (board, body) => {
      // The abort runs before the answer is written, so the runner never reads it.
      const answer = jobQueueCall(db, body, { mode: 'pull' });
      if (cut) { committed = answer; cut.abort(); cut = null; }
      return answer;
    },
  });
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  const claim = async (key, signal) => {
    const response = await fetchFresh(`http://127.0.0.1:${server.address().port}/api/v1/boards/fixture/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'claim', runner: 'r-a', key, capabilities: [] }), ...(signal ? { signal } : {}) });
    return { status: response.status, document: await response.json() };
  };

  cut = new AbortController();
  await assert.rejects(claim('key-first-0001', cut.signal), { name: 'AbortError' }, 'the runner never sees the first answer');
  assert.equal(committed.claim.job, 'test:first', 'the board committed the first claim');
  const retry = await claim('key-first-0001');
  assert.equal(retry.status, 200);
  assert.deepEqual([retry.document.claim.job, retry.document.claim.attempt, retry.document.claim.token, retry.document.claim.leaseUntil], ['test:first', 1, committed.claim.token, committed.claim.leaseUntil], 'the retry answers the committed lease: same job, attempt, token and lease end');
  const first = jobView(db, 'test:first');
  assert.deepEqual([first.leaseOwner, first.attempt, first.step], ['r-a', 1, 'claimed']);
  assert.equal(first.steps.some((step) => step.name === 'lapsed'), false, 'no lease lapsed');
  assert.equal(jobView(db, 'test:second').leaseOwner, null, 'the retry took no second job');
  assert.equal((await claim('key-first-0001')).document.claim.token, committed.claim.token, 'a further retry answers the same lease again');
  assert.equal(renewJob(db, { job: 'test:first', runner: 'r-a', token: committed.claim.token }).renewed, true, 'the token the retry answered holds the job');
  const other = await claim('key-second-002');
  assert.deepEqual([other.document.claim.job, other.document.claim.attempt], ['test:second', 1], 'a different key takes another job');
  assert.notEqual(other.document.claim.token, committed.claim.token);
  assert.equal((await claim('bad key')).document.error.code, 'JOB_CLAIM_KEY', 'a key that is not a plain name is refused');
});

/** A hop table as pullboard serve provides the moves cell's (a cell test may not import it): create, acquire a queued or lapsed hop, refuse HOP_HELD while another runner's lease lives. */
function hopTable(t) {
  provideGateHopTable((leaseMs) => ({ item, hop, now }, { name, actor }) => {
    if (name === 'create') return { patch: { hop: { state: 'queued', owner: null, epoch: 0, leaseUntil: 0, attempts: 0, commit: item.commit, digest: item.digest } } };
    if (hop.state === 'driven' && hop.owner !== actor && hop.leaseUntil >= now) return { refused: { code: 'HOP_HELD', message: `the hop is driven by ${hop.owner} and its lease has not lapsed` } };
    return { patch: { hop: { ...hop, state: 'driven', owner: actor, epoch: hop.epoch + 1, leaseUntil: now + leaseMs } } };
  });
  t.after(() => provideGateHopTable(null));
}

/** A board with two gate jobs for item 7 at one candidate and a gate job for item 9 behind them. */
function hopBoard(t, name) {
  const { root } = privateFixtureFiles(name);
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  hopTable(t);
  const candidate = 'c0ffee'.padEnd(40, '0');
  offerJob(db, { id: 'gate:7:a', kind: 'gate', item: 7, candidate, now: 1000 });
  offerJob(db, { id: 'gate:7:b', kind: 'gate', item: 7, candidate, now: 1001 });
  offerJob(db, { id: 'gate:9:x', kind: 'gate', item: 9, candidate: 'beef'.padEnd(40, '0'), now: 1002 });
  return db;
}

const leaseRow = (db, job) => db.prepare('SELECT job_step, job_attempt, job_lease_owner, job_lease_until, job_updated FROM job WHERE job_id = ?').get(job);

test('api.io-refusal.hop-held-leaves-lease: clause 1: a claim reaching a gate job whose hop another live runner holds skips that job, leaves its lease row unchanged, and takes the next job [C7]', (t) => {
  const db = hopBoard(t, 'pullboard-jobs-hop-held-');
  const claim = (runner, now) => jobQueueCall(db, { action: 'claim', runner, capabilities: [] }, { mode: 'pull', now, hop: gateClaimHop(true) }).claim;
  assert.equal(claim('r1', 5000).job, 'gate:7:a', 'r1 takes the first gate job and the item hop');
  const before = leaseRow(db, 'gate:7:b');
  const next = claim('r2', 5001);
  assert.equal(next.job, 'gate:9:x', 'r2 skips the held gate job and takes the job behind it; no refusal ends its serve');
  assert.deepEqual(leaseRow(db, 'gate:7:b'), before, 'the skipped job\'s lease row is unchanged');
  assert.equal(jobView(db, 'gate:7:b').steps.some((step) => step.name === 'claimed'), false, 'no claim step was written for it');
  assert.deepEqual([readGateHop(db, 7).owner, readGateHop(db, 7).epoch], ['r1', 1], 'r1 keeps the hop');
  assert.equal(claim('r2', 5002), null, 'with nothing else open, the claim answers no job rather than a refusal');
});

test('api.io-refusal.success-path-same-reads: clause 3: a succeeding gate job claim with the hop on makes the 33 board statements it made before the hop check moved, plus the one expedite read [C7]', (t) => {
  const db = hopBoard(t, 'pullboard-jobs-hop-reads-');
  let statements = 0;
  const counted = new Proxy(db, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key === 'prepare') return (...args) => { statements += 1; return value.apply(target, args); };
    if (key === 'exec') return (...args) => { statements += 1; return value.apply(target, args); };
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const taken = claimJob(counted, { runner: 'r1', now: 5000, hop: gateClaimHop(true) });
  assert.equal(taken.job, 'gate:7:a');
  assert.equal(statements, 34, 'the success path prepares and runs the 33 statements of before the hop check moved, plus the one expedited-set read a gate claim makes (#12295)');
});

test('api.io-renew-batch.one-call-extends-all-held: clause 1: one renew call over the job route extends every job the runner holds and answers each job\'s new lease; a job it no longer holds is named refused without failing the rest [C7]', async (t) => {
  const { root } = privateFixtureFiles('pullboard-jobs-renew-batch-');
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  for (let i = 0; i < 3; i += 1) offerJob(db, { id: `test:held:${i}`, kind: 'test', now: 1000 + i });
  offerJob(db, { id: 'test:rival', kind: 'test', now: 1003 });
  let clock = 5000;
  let calls = 0;
  const handler = createApiHandler({ refusalDocument,
    authenticate: () => ({ local: true }),
    board: (id) => ({ id }),
    jobs: (board, body) => { calls += 1; return jobQueueCall(db, body, { mode: 'pull', now: clock }); },
  });
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  const jobs = async (body) => (await (await fetchFresh(`http://127.0.0.1:${server.address().port}/api/v1/boards/fixture/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json());
  const held = [];
  for (let i = 0; i < 3; i += 1) held.push((await jobs({ action: 'claim', runner: 'r-a', capabilities: [] })).claim);
  const rival = (await jobs({ action: 'claim', runner: 'r-b', capabilities: [] })).claim;
  assert.deepEqual(held.map((claim) => claim.job), ['test:held:0', 'test:held:1', 'test:held:2']);
  clock = 65_000;
  calls = 0;
  const answer = await jobs({ action: 'renew', runner: 'r-a', held: [...held.map(({ job, token }) => ({ job, token })), { job: rival.job, token: rival.token }] });
  assert.equal(calls, 1, 'one call renews them all');
  assert.deepEqual(answer.leases, [
    ...held.map(({ job }) => ({ job, renewed: true, leaseUntil: 65_000 + LEASE_MS })),
    { job: 'test:rival', renewed: false, refused: 'JOB_LEASE_MOVED' },
  ], 'each held job answers its new lease; the job r-a does not hold is refused alone');
  for (const { job } of held) assert.equal(jobView(db, job).leaseUntil, 65_000 + LEASE_MS, `${job} lease extended on the board`);
  assert.equal(jobView(db, 'test:rival').leaseOwner, 'r-b', 'the rival\'s lease is untouched');
  assert.equal((await jobs({ action: 'renew', runner: 'r-a', held: [] })).error.code, 'JOB_RENEW_BATCH', 'an empty batch is refused');
  assert.equal((await jobs({ action: 'renew', runner: 'r-a', job: held[0].job, token: held[0].token })).renewed, true, 'a single renew answers as before');
});

test('api.io-renew-batch.capped-claim-carries-wait: clause 1: a claim answer for a runner whose cap holds back an open job carries a wait time; an empty queue or a claim that takes a job carries none [C7]', (t) => {
  const { root } = privateFixtureFiles('pullboard-jobs-capped-wait-');
  const { db } = cellBoard(t, join(root, 'board.sqlite'));
  const claim = (body, now) => jobQueueCall(db, { action: 'claim', runner: 'r-a', capabilities: [], ...body }, { mode: 'pull', now });
  assert.deepEqual(claim({ cores: 3 }, 5000), { claim: null }, 'an empty queue answers no job and no wait');
  offerJob(db, { id: 'gate:12150:shard:0', kind: 'gate-shard', now: 6000 });
  offerJob(db, { id: 'gate:12150:shard:1', kind: 'gate-shard', now: 6001 });
  const taken = claim({ cores: 3 }, 7000);
  assert.equal(taken.claim.job, 'gate:12150:shard:0');
  assert.equal(taken.waitMs, undefined, 'a claim that takes a job carries no wait');
  const full = claim({ cores: 3 }, 7001);
  assert.equal(full.claim, null, 'three cores hold one shard, so the second waits');
  assert.ok(Number.isSafeInteger(full.waitMs) && full.waitMs > 0, 'the capped answer tells the runner how long to wait');
  assert.equal(claim({}, 7002).claim.job, 'gate:12150:shard:1', 'a claim reporting no cores is not capped and takes the shard');
});
