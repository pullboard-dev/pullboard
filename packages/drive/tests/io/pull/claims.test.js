/** A runner claim ends in a receipt or a recorded release with backoff, never a spin or a lease lost to a slow board (#6546, #6545) [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveRunner } from '../../../index.js';
import { testGit as pullGit } from '../../fixtures/git.js';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { LEASE_MS } from '../../../../jobs/index.js';
import { backOffLease } from '../../../../jobs/index.js';
import { createJob } from '../../../../jobs/index.js';
import { finishJob } from '../../../../jobs/index.js';
import { jobView } from '../../../../jobs/index.js';
import { releaseBackoffMs } from '../../../../jobs/index.js';
import { renewLease } from '../../../../jobs/index.js';
import { takeJob } from '../../../../jobs/index.js';
import { writeStep } from '../../../../jobs/index.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';

/**
 * One job on a real board's lease rows, behind a fetch stand-in that answers the queue as the board does: a claim takes a
 * lapsed lease, a renewal extends the current claim's lease even lapsed, a release backs off, a receipt finishes the job.
 * The clock is the test's to move; `down(call)` makes a call unreachable and `answered` sees each answer.
 */
function boardBehindFetch(t, job, { trunk = 'unused', down = () => false, answered = () => {} } = {}) {
  const db = cellBoard(t, ':memory:').db;
  const board = { db, offset: 0, calls: [], attempt: 0 };
  board.now = () => Date.now() + board.offset;
  createJob(db, { id: job.id, kind: job.kind, candidate: job.candidate ?? null, base: job.candidate ?? null, now: board.now() });
  /** Take the job for a runner as a claim does: only once its lease, or its release backoff, has passed. */
  board.claim = (runner, now = board.now()) => {
    if (!takeJob(db, job.id, runner, { now }).taken) return null;
    board.attempt += 1;
    writeStep(db, job.id, 'claimed', { runner }, { seq: board.attempt, now });
    return { job: job.id, kind: job.kind, needs: [], run: job.run ?? [], candidate: job.candidate ?? null, base: job.candidate ?? null, attempt: board.attempt, token: `${runner}:${board.attempt}` };
  };
  const answer = call => {
    if (call.action === 'claim') { const claim = board.claim(call.runner); return { claim, ...(claim ? { trunk } : {}) }; }
    // The runner's one renew for every job it holds names each job with its own token and gets one lease answer per job [C7,#12150].
    if (call.action === 'renew' && Array.isArray(call.held)) {
      return { leases: call.held.map(({ job: id, token }) => token === `${call.runner}:${board.attempt}`
        ? { job: id, renewed: renewLease(db, id, call.runner, { now: board.now(), lapsed: true }) }
        : { job: id, renewed: false, refused: 'JOB_LEASE_MOVED' }) };
    }
    if (call.token !== `${call.runner}:${board.attempt}`) return null;
    if (call.action === 'renew') return { renewed: renewLease(db, job.id, call.runner, { now: board.now(), lapsed: true }) };
    if (call.action === 'release') return backOffLease(db, job.id, call.runner, { attempt: board.attempt, reason: call.reason, now: board.now() });
    if (call.action === 'receipt') { writeStep(db, job.id, 'receipt', { runner: call.runner, receipt: call.receipt }, { seq: board.attempt }); finishJob(db, job.id, call.runner); return { recorded: true }; }
    return { recorded: true };
  };
  board.fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    board.calls.push(call.action);
    if (down(call)) throw new TypeError('fetch failed');
    const reply = answer(call);
    if (reply === null) return { status: 409, json: async () => ({ error: { code: 'JOB_LEASE_MOVED', message: 'another runner holds the job' } }) };
    answered(call, reply);
    return { status: 200, json: async () => reply };
  };
  return board;
}

/** A private runner cache folder, removed after the test. */
function runnerCache(t) {
  const { root } = privateFixtureFiles('pullboard-claims-cache-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('drive.claims.c-6546-clause-1-a-job: #6546 clause 1: a job whose handler throws is released with its reason, not re-claimed within 30 s, and backs off longer on each repeat [C7]', async t => {
  const board = boardBehindFetch(t, { id: 'land:5888', kind: 'land' });
  const handlers = { land: async () => { throw new Error('git fetch failed: no such ref'); } };
  const served = await serveRunner({ git: pullGit, board: BOARD, runner: 'r-throw', capabilities: [], cache: runnerCache(t), once: true, fetchImpl: board.fetchImpl, handlers, trunkPack: async () => {} });
  assert.deepEqual(served.jobs.map(entry => [entry.job, entry.outcome]), [['land:5888', 'released']]);
  const view = jobView(board.db, 'land:5888');
  const released = view.steps.find(step => step.name === 'released');
  assert.equal(released?.payload.reason, 'git fetch failed: no such ref', 'the release records the handler\'s reason');
  assert.equal(released.payload.runner, 'r-throw');
  assert.equal(view.leaseOwner, null, 'no runner holds the released job');
  const at = released.at;
  assert.equal(board.claim('r-next', at + 30_000), null, 'not re-claimed within 30 s');
  const second = board.claim('r-next', at + 30_001);
  assert.deepEqual([second?.job, second?.attempt], ['land:5888', 2], 'claimable once the backoff passed');
  backOffLease(board.db, 'land:5888', 'r-next', { attempt: 2, reason: 'git merge failed', now: at + 31_000 });
  assert.equal(board.claim('r-third', at + 31_000 + 60_000), null, 'the second release waits 60 s');
  assert.equal(board.claim('r-third', at + 31_000 + 60_001)?.attempt, 3);
  assert.deepEqual([1, 2, 3, 4, 5, 50].map(releaseBackoffMs), [30_000, 60_000, 120_000, 240_000, 300_000, 300_000], 'doubling per attempt, capped at 5 minutes');
});

test('drive.claims.c-6546-clause-2-a-runner: #6546 clause 2: a runner running a long job renews its lease, keeps it through a board outage longer than the lease, and no other runner takes it [C7]', { timeout: 60_000 }, // budget: one 2 s job and a git checkout.
async t => {
  const { root: trunk } = privateFixtureFiles('pullboard-claims-trunk-');
  t.after(() => rmSync(trunk, { recursive: true, force: true }));
  const sh = (...args) => runFixtureGit(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], { cwd: trunk });
  sh('init', '-q', '-b', 'main');
  writeFileSync(join(trunk, 'file.txt'), 'one\n');
  sh('add', '.');
  sh('commit', '-q', '-m', 'one');
  const commit = sh('rev-parse', 'HEAD');
  // After the first renewal the board stops answering renewals for longer than the runner's lease, and its clock jumps
  // past the board lease, as when a busy board answers nothing for minutes; the first renewal after it is awaited.
  let outage = null, recovered;
  const back = new Promise(resolve => { recovered = resolve; });
  const answered = (call, answer) => {
    if (call.action !== 'renew') return;
    if (outage === null) { outage = { until: Date.now() + 900 }; board.offset += LEASE_MS + 1_000; } else recovered(answer);
  };
  const run = [process.execPath, '-e', "setTimeout(() => console.log('long done'), 2000)"];
  const board = boardBehindFetch(t, { id: 'gate:long', kind: 'gate', candidate: commit, run }, { trunk, answered, down: call => call.action === 'renew' && outage !== null && outage.until > Date.now() });
  const renewalsBefore = () => board.calls.filter(action => action === 'renew').length;
  const said = [];
  const running = serveRunner({ git: pullGit, board: BOARD, runner: 'r-long', capabilities: [], cache: runnerCache(t), once: true, fetchImpl: board.fetchImpl, trunkPack: async () => {},
    say: line => { said.push(line); },
    timing: { renewMs: 100, renewRetryMs: 50, leaseMs: 300 } });
  assert.equal((await back).leases[0].renewed, true, 'the board renewed the lapsed lease no runner had claimed');
  const leaseUntil = jobView(board.db, 'gate:long').leaseUntil;
  assert.ok(leaseUntil > board.now(), 'the runner renewed its lapsed lease when the board answered again');
  assert.equal(board.claim('r-rival'), null, 'another runner cannot take the renewed job');
  const served = await running;
  assert.deepEqual(served.jobs.map(entry => [entry.job, entry.outcome]), [['gate:long', 'posted']], said.join('\n'));
  const view = jobView(board.db, 'gate:long');
  assert.deepEqual([board.attempt, view.steps.find(step => step.name === 'receipt')?.payload.runner], [1, 'r-long'], 'one claim, one receipt, by the runner that ran it');
  assert.ok(renewalsBefore() >= 3, `the runner renewed its lease while the job ran: ${renewalsBefore()} renewals`);
});

test('drive.claims.c-7815-clause-1-a-land: #7815 clause 1: a land job keeps its lease through a board outage under a minute, renews when the board answers, and no second runner claims it [C7]', { timeout: 30_000 }, // budget: one handler held through a 0.4 s outage, no git.
async t => {
  // The first renewal starts an outage of renewals 50 s long on the board's clock; the handler never renews on its own
  // until its proof is done, as a land job's proof does not, and the proof runs on past the lease its claim was given.
  let outage = null, recovered = false, back;
  const answeredAgain = new Promise(resolve => { back = resolve; });
  const answered = call => {
    if (call.action !== 'renew') return;
    if (outage === null) { outage = { until: Date.now() + 400 }; board.offset += 50_000; } else { recovered = true; back(); }
  };
  const board = boardBehindFetch(t, { id: 'land:7815', kind: 'land' }, { answered, down: call => call.action === 'renew' && outage !== null && outage.until > Date.now() });
  const rivals = [];
  const handlers = { land: async (_claim, { renew }) => {
    await answeredAgain;
    board.offset += LEASE_MS - 30_000;
    rivals.push(board.claim('r-rival'));
    return { outcome: (await renew()) ? 'green' : 'lease-lost' };
  } };
  const said = [];
  const served = await serveRunner({ git: pullGit, board: BOARD, runner: 'r-land', capabilities: [], cache: runnerCache(t), once: true, fetchImpl: board.fetchImpl, handlers, trunkPack: async () => {},
    say: line => { said.push(line); }, timing: { renewMs: 100, renewRetryMs: 50, leaseMs: 300 } });
  assert.ok(said.some(line => line.startsWith('renewal skipped')), `the runner saw the outage: ${said.join('\n')}`);
  assert.equal(recovered, true, 'the runner renewed again once the board answered');
  assert.deepEqual(rivals, [null], 'no second runner claimed the job while its holder kept renewing');
  assert.deepEqual(served.jobs.map(entry => [entry.job, entry.outcome, entry.receipt?.outcome]), [['land:7815', 'posted', 'green']], said.join('\n'));
  assert.equal(board.attempt, 1, 'one claim');
});

test('drive.claims.c-11286-clause-1-a-receipt: #11286 clause 1: a land job that finishes green while the board refuses every receipt call keeps its job, retries the receipt with backoff and posts one green receipt when the board answers [C7]', { timeout: 30_000 }, // budget: one instant handler, three refused receipt calls, the sleep injected.
async t => {
  // Every receipt call is unreachable until three have failed; the handler is done at once, so only the receipt post waits.
  let refused = 0;
  const down = call => call.action === 'receipt' && ++refused <= 3;
  const board = boardBehindFetch(t, { id: 'land:11286', kind: 'land' }, { down });
  const handlers = { land: async () => ({ outcome: 'green' }) };
  const said = [], naps = [];
  const served = await serveRunner({ git: pullGit, board: BOARD, runner: 'r-offline', capabilities: [], cache: runnerCache(t), once: true, fetchImpl: board.fetchImpl, handlers, trunkPack: async () => {},
    say: line => { said.push(line); }, sleep: async ms => { naps.push(ms); await new Promise(resolve => setImmediate(resolve)); }, timing: { firstMs: 10, maxMs: 40 } });
  assert.deepEqual(served.jobs.map(entry => [entry.job, entry.outcome, entry.receipt?.outcome]), [['land:11286', 'posted', 'green']], said.join('\n'));
  assert.equal(board.attempt, 1, 'one claim, no second runner took the job');
  assert.ok(board.calls.filter(action => action === 'receipt').length >= 4, 'at least two receipt calls were refused before one landed');
  assert.ok(refused >= 3, `receipt calls refused: ${refused}`);
  assert.deepEqual(naps.slice(0, 3), [10, 20, 40], 'the receipt retries back off, doubling to the ceiling');
  const receipts = jobView(board.db, 'land:11286').steps.filter(step => step.name === 'receipt');
  assert.equal(receipts.length, 1, 'the board holds one receipt step');
  assert.equal(receipts[0].payload.runner, 'r-offline');
});

test('drive.claims.c-6680-clause-1-a-serve: #6680 clause 1: a serve with a free slot claims an offered job within one idle poll, and a second claim never waits for the first job to end [C7]', { timeout: 30_000 }, // budget: two handler jobs on a stand-in board, no git, the sleep injected.
async t => {
  // The board answers empty once, then offers two jobs; the first job cannot end until the second has started in its own slot.
  const naps = [], claimedAfterNaps = [], posted = [];
  let polls = 0, secondStarted;
  const bothRunning = new Promise(resolve => { secondStarted = resolve; });
  const stop = new AbortController();
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    let reply = { recorded: true };
    if (call.action === 'claim') {
      polls += 1;
      const job = polls === 2 ? 'j1' : polls === 3 ? 'j2' : null;
      if (job) claimedAfterNaps.push([job, naps.length]);
      reply = job ? { claim: { job, kind: 'land', needs: [], run: [], candidate: null, base: null, attempt: 1, token: `r-poll:${job}` }, trunk: 'unused' } : { claim: null };
    } else if (call.action === 'receipt') { posted.push(call.job); if (posted.length === 2) stop.abort(); }
    return { status: 200, json: async () => reply };
  };
  const handlers = { land: async claim => {
    if (claim.job === 'j1') await bothRunning; else secondStarted();
    return { outcome: 'green' };
  } };
  const served = await serveRunner({ git: pullGit, board: BOARD, runner: 'r-poll', capabilities: [], cache: runnerCache(t), jobs: 2, signal: stop.signal, fetchImpl, handlers, trunkPack: async () => {},
    sleep: async ms => { naps.push(ms); await new Promise(resolve => setImmediate(resolve)); } });
  assert.deepEqual(claimedAfterNaps, [['j1', 1], ['j2', 1]], 'the offered job is claimed after one idle poll, and the next claim follows at once, with no further wait');
  assert.equal(naps[0], 2_000, 'the idle poll before the first claim is the 2 s default');
  assert.deepEqual(served.jobs.map(entry => entry.job).sort(), ['j1', 'j2'], 'the first job ran beside the second, so the claim never waited behind it');
});
