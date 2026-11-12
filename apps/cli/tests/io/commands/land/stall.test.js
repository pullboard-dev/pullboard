/** A landing with no progress for 2 minutes is ended, its items stay verified, and the next batch starts at once [C7,#5816]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  driveLanding,
  LANDING_STALL_MS,
} from '../../../../../../packages/drive/index.js';
import {
  jobView,
  takeJob,
} from '../../../../../../packages/jobs/index.js';
import {
  inProcessLandingBatch,
  landingProgress,
} from '../../../../../../packages/landing/index.js';
import {
  LANDING_NEXT_BATCH_MS,
  landingRetryAt,
} from '../../../../src/io/commands/land.js';
import { fixtureBoard } from '../../../fixtures/board.js';

/** Run one hung landing under a fake clock; `record` says whether the batch recorded itself before it hung. */
async function hungLanding(t, { record = true } = {}) {
  const board = fixtureBoard(t);
  let clock = 0;
  const now = () => clock;
  const progress = landingProgress({ now });
  const batch = { id: 'batch-hung', state: 'testing', revision: 1, candidates: [{ id: 7, commit: 'a'.repeat(40) }] };
  const writes = [];
  const lines = [];
  let hung;
  const runner = inProcessLandingBatch({ checkAtCommit: () => {}, candidateWorkerFile: 'unused', progress,
    runLandingBatch: async options => {
      if (record) await options.write('recordLandingBatch', [{ batch }]);
      return new Promise(resolve => { hung = resolve; });
    } });
  const hooks = { board, landingPorts: {}, checkLease: async () => {}, checkLeaseNow: () => {}, say: line => lines.push(line),
    write: async (operation, args) => { writes.push(operation); return args[0].batch; },
    // As land()'s own onStall: the batch is recorded blocked and nothing reopens its items.
    onStall: async ({ description }) => ({ batch: { ...batch, state: 'blocked', refusal: { code: 'LAND_STALLED', message: description } },
      landed: [], conflicts: [], culprits: [], stalled: true, stallDescription: description }) };
  const id = `land:run:${record ? 'recorded' : 'unrecorded'}`;
  let beats = 0;
  const lastProgressAt = () => { beats += 1; return progress.lastProgressAt(); };
  const beatsPass = async more => { const until = beats + more; while (beats < until) await new Promise(resolve => setImmediate(resolve)); };
  // The default limit applies: no stallAfterMs, as when the repository sets no landing.stall.
  const landing = driveLanding(board.db, { owner: 'lander', id, now, renewMs: 1,
    watch: { lastProgressAt, stall: progress.stall }, run: () => runner({ fence: {}, root: '/unused' }, hooks) });
  await beatsPass(1);
  clock = LANDING_STALL_MS - 1_000;
  await beatsPass(2);
  const earlyFailed = jobView(board.db, id).steps.some(step => step.name === 'failed');
  clock = LANDING_STALL_MS;
  let settled = false;
  landing.finally(() => { settled = true; }).catch(() => {});
  while (!settled) await new Promise(resolve => setImmediate(resolve));
  const result = await landing;
  hung?.();
  return { board, id, clock, result, writes, lines, earlyFailed };
}

test('clause 1: a batch with no progress for 2 minutes is ended and its items stay verified [C7,#5816]', async t => {
  assert.equal(LANDING_STALL_MS, 2 * 60_000, 'the default no-progress limit is 2 minutes');
  const { board, id, clock, result, writes, earlyFailed } = await hungLanding(t);
  assert.equal(earlyFailed, false, '1:59 quiet does not end the batch');
  assert.equal(result.stalled, true);
  assert.match(result.stallDescription, /made no progress for 2 minutes in state testing/u);
  assert.equal(result.batch.state, 'blocked', 'the batch is recorded blocked, so no later landing adopts it');
  assert.deepEqual(result.landed, []);
  assert.ok(!writes.includes('reopen'), 'nothing reopens an item: each stays verified for the next batch');
  const view = jobView(board.db, id);
  assert.equal(view.steps.find(step => step.name === 'failed')?.payload.code, 'LAND_STALLED');
  assert.equal(view.leaseOwner, null, 'the landing-run lease is freed');
  assert.equal(takeJob(board.db, id, 'next-lander', { now: clock }).taken, true);
});

test('clause 1: a stall before any batch record still ends as a stalled result, not a refusal [C7,#5816]', async t => {
  const { result, lines, writes } = await hungLanding(t, { record: false });
  assert.equal(result.stalled, true, 'the lander gets a result its wake can act on');
  assert.equal(result.batch, null);
  assert.ok(!writes.includes('reopen'));
  assert.ok(lines.some(line => /items remain verified and the next batch can start/u.test(line)), JSON.stringify(lines));
});

test('clause 2: the next batch is scheduled within 10 s of a stall while verified items wait [C7,#5816]', async t => {
  const { result } = await hungLanding(t);
  const now = Date.parse('2026-11-11T20:00:00.000Z');
  const next = Date.parse(landingRetryAt({ ...result, waiting: true }, now));
  assert.ok(next - now <= 10_000, `next batch at +${next - now} ms`);
  assert.equal(next - now, LANDING_NEXT_BATCH_MS);
  const unrecorded = await hungLanding(t, { record: false });
  assert.equal(Date.parse(landingRetryAt({ ...unrecorded.result, waiting: true }, now)) - now, LANDING_NEXT_BATCH_MS, 'a batch-less stall starts the next batch too');
});
