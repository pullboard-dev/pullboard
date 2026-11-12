/** A runner claim ends in a receipt or a recorded release with backoff, never a spin or a lease lost to a slow board (#6546, #6545) [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveRunner } from '../../../index.js';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';
import { claimJob } from '../../../../api/index.js';
import { jobQueueCall } from '../../../../api/index.js';
import { offerJob } from '../../../../api/index.js';
import { releaseJob } from '../../../../api/index.js';
import { LEASE_MS } from '../../../../jobs/index.js';
import { jobView } from '../../../../jobs/index.js';
import { releaseBackoffMs } from '../../../../jobs/index.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';

/** A real board in memory behind a fetch stand-in, on a clock the test moves; `down(call)` makes a call unreachable, `answered` sees each answer. */
function boardBehindFetch(t, { trunk = 'unused', down = () => false, answered = () => {} } = {}) {
  const db = cellBoard(t, ':memory:').db;
  const board = { db, offset: 0, calls: [] };
  board.now = () => Date.now() + board.offset;
  board.fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    board.calls.push(call.action);
    if (down(call)) throw new TypeError('fetch failed');
    try { const answer = jobQueueCall(db, call, { mode: 'pull', now: board.now(), trunk: () => trunk }); answered(call, answer); return { status: 200, json: async () => answer }; }
    catch (error) { return { status: 409, json: async () => ({ error: { code: error.code, message: error.message } }) }; }
  };
  return board;
}

/** A private runner cache folder, removed after the test. */
function runnerCache(t) {
  const { root } = privateFixtureFiles('pullboard-claims-cache-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('#6546 clause 1: a job whose handler throws is released with its reason, not re-claimed within 30 s, and backs off longer on each repeat [C7]', async t => {
  const board = boardBehindFetch(t);
  offerJob(board.db, { id: 'land:5888', kind: 'land', needs: [], now: board.now() });
  const handlers = { land: async () => { throw new Error('git fetch failed: no such ref'); } };
  const served = await serveRunner({ board: BOARD, runner: 'r-throw', capabilities: [], cache: runnerCache(t), once: true, fetchImpl: board.fetchImpl, handlers, trunkPack: async () => {} });
  assert.deepEqual(served.jobs.map(entry => [entry.job, entry.outcome]), [['land:5888', 'released']]);
  const view = jobView(board.db, 'land:5888');
  const released = view.steps.find(step => step.name === 'released');
  assert.equal(released?.payload.reason, 'git fetch failed: no such ref', 'the release records the handler\'s reason');
  assert.equal(released.payload.runner, 'r-throw');
  assert.equal(view.leaseOwner, null, 'no runner holds the released job');
  assert.equal(view.step, 'claimed', 'views still read the job as claimed, not done');
  const at = released.at;
  assert.equal(claimJob(board.db, { runner: 'r-next', capabilities: [], now: at + 29_999 }), null, 'not re-claimed within 30 s');
  const second = claimJob(board.db, { runner: 'r-next', capabilities: [], now: at + 30_000 });
  assert.deepEqual([second?.job, second?.attempt], ['land:5888', 2], 'claimable once the backoff passed');
  releaseJob(board.db, { job: 'land:5888', runner: 'r-next', token: second.token, reason: 'git merge failed', now: at + 31_000 });
  assert.equal(claimJob(board.db, { runner: 'r-third', capabilities: [], now: at + 31_000 + 59_999 }), null, 'the second release waits 60 s');
  assert.equal(claimJob(board.db, { runner: 'r-third', capabilities: [], now: at + 31_000 + 60_000 })?.attempt, 3);
  assert.deepEqual([1, 2, 3, 4, 5, 50].map(releaseBackoffMs), [30_000, 60_000, 120_000, 240_000, 300_000, 300_000], 'doubling per attempt, capped at 5 minutes');
});

test('#6546 clause 2: a runner running a long job renews its lease, keeps it through a board outage longer than the lease, and no other runner takes it [C7]', { timeout: 60_000 }, // budget: one 2 s job and a git checkout.
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
  const board = boardBehindFetch(t, { trunk, answered, down: call => call.action === 'renew' && outage !== null && outage.until > Date.now() });
  offerJob(board.db, { id: 'gate:long', kind: 'gate', needs: [], candidate: commit, base: commit, run: [process.execPath, '-e', "setTimeout(() => console.log('long done'), 2000)"], now: board.now() });
  const renewalsBefore = () => board.calls.filter(action => action === 'renew').length;
  const said = [];
  const running = serveRunner({ board: BOARD, runner: 'r-long', capabilities: [], cache: runnerCache(t), once: true, fetchImpl: board.fetchImpl, trunkPack: async () => {},
    say: line => { said.push(line); },
    timing: { renewMs: 100, renewRetryMs: 50, leaseMs: 300 } });
  assert.equal((await back).renewed, true, 'the board renewed the lapsed lease no runner had claimed');
  const leaseUntil = jobView(board.db, 'gate:long').leaseUntil;
  assert.ok(leaseUntil > board.now(), 'the runner renewed its lapsed lease when the board answered again');
  assert.equal(claimJob(board.db, { runner: 'r-rival', capabilities: [], now: board.now() }), null, 'another runner cannot take the renewed job');
  const served = await running;
  assert.deepEqual(served.jobs.map(entry => [entry.job, entry.outcome]), [['gate:long', 'posted']], said.join('\n'));
  const view = jobView(board.db, 'gate:long');
  assert.deepEqual([view.attempt, view.steps.find(step => step.name === 'receipt')?.payload.runner], [1, 'r-long'], 'one claim, one receipt, by the runner that ran it');
  assert.ok(renewalsBefore() >= 3, `the runner renewed its lease while the job ran: ${renewalsBefore()} renewals`);
});
