/** The board's runner job queue: claim by capability, one lease at a time, lapse back to the queue, authenticated receipts [P7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { closeCellBoard } from '../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { LEASE_MS } from '../../../jobs/index.js';
import { claimJob } from '../../index.js';
import { jobQueueCall } from '../../index.js';
import { jobView } from '../../../jobs/index.js';
import { offerJob } from '../../index.js';
import { postReceipt } from '../../index.js';
import { releaseJob } from '../../index.js';
import { renewJob } from '../../index.js';

const boardWith = t => cellBoard(t, ':memory:').db;

test('clause 1: a runner claims only a job whose needs it has, and a second claimant gets nothing while the lease lives [P7]', t => {
  const db = boardWith(t);
  offerJob(db, { id: 'gate:1', kind: 'gate', needs: ['node22', 'browser'], now: 1 });
  assert.equal(claimJob(db, { runner: 'r-plain', capabilities: ['node22'], now: 10 }), null, 'a runner without browser takes nothing');
  assert.equal(claimJob(db, { runner: 'r-full', capabilities: ['browser', 'node22', 'os:linux'], kinds: ['land'], now: 10 }), null, 'a kind filter skips other kinds');
  const won = claimJob(db, { runner: 'r-full', capabilities: ['browser', 'node22', 'os:linux'], now: 10 });
  assert.deepEqual({ ...won, token: typeof won.token }, { job: 'gate:1', kind: 'gate', needs: ['browser', 'node22'], run: [], item: null, candidate: null, base: null, attempt: 1, leaseUntil: 10 + LEASE_MS, token: 'string' });
  assert.equal(claimJob(db, { runner: 'r-rival', capabilities: ['browser', 'node22'], now: 10 + LEASE_MS }), null, 'a lease ending now is still live');
  const view = jobView(db, 'gate:1');
  assert.deepEqual([view.leaseOwner, view.attempt, view.step], ['r-full', 1, 'claimed']);
  assert.equal(JSON.stringify(view).includes(won.token), false, 'the board keeps only a hash of the lease token');
  assert.deepEqual(renewJob(db, { job: 'gate:1', runner: 'r-full', token: won.token, now: 20 }), { renewed: true, leaseUntil: 20 + LEASE_MS });
  assert.equal(claimJob(db, { runner: 'r-rival', capabilities: ['browser', 'node22'], now: 21 + LEASE_MS - 1 }), null, 'a renewal pushes the lease on');
  assert.throws(() => renewJob(db, { job: 'gate:1', runner: 'r-rival', token: won.token, now: 30 }), error => error.code === 'JOB_LEASE_MOVED', 'a token works only for the runner it was given to');
});

test('clause 2: a lapsed lease returns the job and the next claim takes it, with no process holding it on the board host [P7]', t => {
  const { root } = privateFixtureFiles('pullboard-job-queue-');
  const file = join(root, 'board.sqlite');
  // Each step opens and closes its own connection: the queue lives in rows only, never in a process that must stay up.
  const withFresh = work => { const board = openCellBoard(file); try { return work(board.db); } finally { closeCellBoard(board); } };
  withFresh(db => offerJob(db, { id: 'shard:9', kind: 'shard', needs: ['node22'], now: 1 }));
  const first = withFresh(db => claimJob(db, { runner: 'r-a', capabilities: ['node22'], now: 100 }));
  assert.equal(first.attempt, 1);
  const lapsed = 100 + LEASE_MS + 1;
  const second = withFresh(db => claimJob(db, { runner: 'r-b', capabilities: ['node22'], now: lapsed }));
  assert.deepEqual([second.job, second.attempt], ['shard:9', 2]);
  assert.throws(() => withFresh(db => renewJob(db, { job: 'shard:9', runner: 'r-a', token: first.token, now: lapsed })), error => error.code === 'JOB_LEASE_MOVED', 'a lapsed lease another runner claimed is not renewed');
  assert.throws(() => withFresh(db => postReceipt(db, { job: 'shard:9', runner: 'r-a', token: first.token, receipt: { status: 0 }, now: lapsed + 1 })),
    error => error.code === 'JOB_LEASE_MOVED', 'the first runner lost the job with its lease');
  assert.deepEqual(withFresh(db => releaseJob(db, { job: 'shard:9', runner: 'r-b', token: second.token, backoff: false, now: lapsed + 2 })), { released: true });
  const third = withFresh(db => claimJob(db, { runner: 'r-a', capabilities: ['node22'], now: lapsed + 3 }));
  assert.deepEqual([third.job, third.attempt], ['shard:9', 3], 'a job a stopping runner released is open again at once');
  assert.equal(withFresh(db => offerJob(db, { id: 'shard:9', kind: 'shard', needs: ['node22'], now: lapsed + 4 })).attempt, 3, 'a repeated offer leaves a held job as it is');
});

test('#6546: a release records its reason and backs off per attempt, and the current claim renews a lapsed lease no one took [C7]', t => {
  const db = boardWith(t);
  offerJob(db, { id: 'land:7', kind: 'land', now: 1 });
  const first = jobQueueCall(db, { action: 'claim', runner: 'r-a', capabilities: [] }, { mode: 'pull', now: 10 }).claim;
  const lapsed = 10 + LEASE_MS + 5;
  assert.deepEqual(jobQueueCall(db, { action: 'renew', job: 'land:7', runner: 'r-a', token: first.token }, { mode: 'pull', now: lapsed }), { renewed: true, leaseUntil: lapsed + LEASE_MS });
  assert.deepEqual(jobQueueCall(db, { action: 'release', job: 'land:7', runner: 'r-a', token: first.token, reason: 'fetch threw' }, { mode: 'pull', now: lapsed }), { released: true, until: lapsed + 30_000 });
  assert.equal(jobView(db, 'land:7').steps.find(step => step.name === 'released').payload.reason, 'fetch threw');
  assert.equal(claimJob(db, { runner: 'r-b', capabilities: [], now: lapsed + 29_999 }), null, 'not offered within the backoff');
  assert.equal(claimJob(db, { runner: 'r-b', capabilities: [], now: lapsed + 30_000 }).attempt, 2);
});

test('clause 3: a receipt is recorded under its job only with the current claim token, and a repeat returns the stored one [P7]', t => {
  const db = boardWith(t);
  offerJob(db, { id: 'gate:2', kind: 'gate', now: 1 });
  const held = claimJob(db, { runner: 'r-a', capabilities: [], now: 10 });
  assert.throws(() => postReceipt(db, { job: 'gate:2', runner: 'r-a', token: 'forged', receipt: { status: 0 }, now: 11 }), error => error.code === 'JOB_LEASE_MOVED');
  assert.throws(() => postReceipt(db, { job: 'gate:2', runner: 'r-a', token: held.token, receipt: 'ok', now: 11 }), error => error.code === 'JOB_RECEIPT');
  assert.equal(jobView(db, 'gate:2').steps.some(step => step.name === 'receipt'), false, 'a refused receipt records nothing');
  const posted = postReceipt(db, { job: 'gate:2', runner: 'r-a', token: held.token, receipt: { status: 0, digest: 'abc' }, now: 12 });
  assert.deepEqual(posted, { job: 'gate:2', attempt: 1, receipt: { status: 0, digest: 'abc' }, recorded: true });
  const view = jobView(db, 'gate:2');
  assert.equal(view.step, 'done');
  assert.equal(view.leaseOwner, null);
  assert.deepEqual(view.steps.find(step => step.name === 'receipt'), { name: 'receipt', seq: 1, payload: { runner: 'r-a', attempt: 1, receipt: { status: 0, digest: 'abc' } }, at: 12 });
  assert.deepEqual(postReceipt(db, { job: 'gate:2', runner: 'r-a', token: held.token, receipt: { status: 1 }, now: 13 }).receipt, { status: 0, digest: 'abc' }, 'the first receipt stands');
  assert.equal(claimJob(db, { runner: 'r-b', capabilities: [], now: 10 + LEASE_MS + 1 }), null, 'a done job is never claimed again');
});

test('the queue answers only under gate.runnerDispatch pull, and refuses an unknown action or a bad capability list [P7]', t => {
  const db = boardWith(t);
  offerJob(db, { id: 'gate:3', kind: 'gate', now: 1 });
  assert.throws(() => jobQueueCall(db, { action: 'claim', runner: 'r-a' }, { mode: 'controller', now: 2 }), error => error.code === 'JOBS_NOT_PULL');
  assert.equal(jobView(db, 'gate:3').leaseOwner, null, 'the controller path leaves the queue untouched');
  assert.throws(() => jobQueueCall(db, { action: 'steal', runner: 'r-a' }, { mode: 'pull', now: 2 }), error => error.code === 'JOB_ACTION');
  assert.throws(() => jobQueueCall(db, { action: 'claim', runner: 'r-a', capabilities: 'node22' }, { mode: 'pull', now: 2 }), error => error.code === 'JOB_CAPABILITY');
  assert.throws(() => jobQueueCall(db, { action: 'claim', runner: 'r a' }, { mode: 'pull', now: 2 }), error => error.code === 'JOB_RUNNER');
  assert.equal(jobQueueCall(db, { action: 'claim', runner: 'r-a' }, { mode: 'pull', now: 2 }).claim.job, 'gate:3');
});

test('clause 1: a drained runner is offered no job and takes one again once undrained, while a held job stays with its lease [C7,P7]', t => {
  const db = boardWith(t);
  offerJob(db, { id: 'gate:held', kind: 'gate', needs: [], now: 1 });
  offerJob(db, { id: 'gate:next', kind: 'gate', needs: [], now: 2 });
  const held = claimJob(db, { runner: 'r-rest', capabilities: [], now: 10 });
  assert.equal(held.job, 'gate:held');
  assert.equal(claimJob(db, { runner: 'r-rest', capabilities: [], now: 11, drained: ['r-rest'] }), null, 'a drained runner takes no new job');
  assert.equal(jobQueueCall(db, { action: 'claim', runner: 'r-rest', capabilities: [] }, { mode: 'pull', now: 12, drained: () => ['r-rest'] }).claim, null, 'the board route honours the drain');
  assert.deepEqual(renewJob(db, { job: 'gate:held', runner: 'r-rest', token: held.token, now: 13 }), { renewed: true, leaseUntil: 13 + LEASE_MS }, 'its running job keeps its lease');
  assert.equal(claimJob(db, { runner: 'r-other', capabilities: [], now: 14, drained: ['r-rest'] }).job, 'gate:next', 'other runners are unaffected');
  offerJob(db, { id: 'gate:after', kind: 'gate', needs: [], now: 15 });
  assert.equal(claimJob(db, { runner: 'r-rest', capabilities: [], now: 16, drained: [] }).job, 'gate:after', 'undrained, it takes jobs again');
});
