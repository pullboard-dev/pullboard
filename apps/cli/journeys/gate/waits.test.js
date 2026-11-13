/** A gate never gives up because a database is busy: lock waits back off, continue, and are recorded on the job [C7,#3087]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  fixture,
  cli,
} from '../../tests/fixtures/next/take.js';
import { submitUntilSettled } from '../../../lib/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import * as store from '../../../../packages/store/index.js';

/** A run that fails with each given stop in turn, then goes green; `waited` holds every pause it was given. */
function scripted(stops) {
  let calls = 0;
  const run = async () => {
    const stop = stops[calls++];
    if (!stop) return 'GREEN';
    if (stop === 'sqlite') throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
    throw new Refused(stop, `fixture ${stop}`);
  };
  return { run, calls: () => calls };
}

test('a gate that meets BOARD_BUSY, SLOT_DB_LOCKED and database locks waits with backoff and goes on to green [C7,#3087]', async () => {
  // Twelve lock stops: three times the retries an infrastructure failure gets, and still never GATE_INFRA_EXHAUSTED.
  const stops = ['BOARD_BUSY', 'SLOT_DB_LOCKED', 'sqlite', 'BOARD_BUSY', 'BOARD_BUSY', 'SLOT_DB_LOCKED', 'sqlite',
    'BOARD_BUSY', 'BOARD_BUSY', 'BOARD_BUSY', 'SLOT_DB_LOCKED', 'sqlite'];
  const { run, calls } = scripted(stops);
  const waited = [];
  const settled = await submitUntilSettled(run, { healthy: async () => true, wait: async ms => { waited.push(ms); } });
  assert.equal(settled.result, 'GREEN');
  assert.equal(calls(), stops.length + 1, 'the same candidate continued after every lock stop');
  assert.deepEqual(settled.attempts, [], 'a lock stop spends no infrastructure retry');
  assert.deepEqual(waited.slice(0, 6), [1000, 2000, 4000, 8000, 16000, 30000], 'the waits back off and cap at 30 s');
  assert.equal(settled.lockWaits.count, stops.length);
  assert.equal(settled.lockWaits.totalMs, waited.reduce((sum, ms) => sum + ms, 0));
  assert.deepEqual(settled.lockWaits.codes, { BOARD_BUSY: 6, SLOT_DB_LOCKED: 3, DATABASE_LOCKED: 3 });
});

test('lock stops between real infrastructure failures do not bring GATE_INFRA_EXHAUSTED closer [C7,#3087]', async () => {
  const stops = ['RUNNER_JOB_LOST', 'BOARD_BUSY', 'BOARD_BUSY', 'RUNNER_JOB_LOST', 'SLOT_DB_LOCKED', 'sqlite', 'RUNNER_JOB_LOST', 'BOARD_BUSY'];
  const { run } = scripted(stops);
  const settled = await submitUntilSettled(run, { healthy: async () => true, wait: async () => {} });
  assert.equal(settled.result, 'GREEN');
  assert.equal(settled.attempts.length, 3, 'only the runner failures count as attempts');
  // A real exhaustion still names the lock waits it sat through.
  const { run: failing } = scripted(['BOARD_BUSY', 'RUNNER_JOB_LOST', 'RUNNER_JOB_LOST', 'RUNNER_JOB_LOST', 'RUNNER_JOB_LOST']);
  await assert.rejects(submitUntilSettled(failing, { healthy: async () => true, wait: async () => {} }),
    error => error.code === 'GATE_INFRA_EXHAUSTED' && error.attempts.length === 4 && error.lockWaits?.count === 1 && error.lockWaits.totalMs === 1000);
});

test('the queued job records its lock waits with their total wait time [C7,#3087]', async t => {
  const box = await fixture(t);
  box.board.gitRoot = box.root;
  const seat = box.seats.actor;
  const id = box.add('Gate waits on a busy board', { brief: 'Files: web/lock.js\nTest: lock waits are recorded.' });
  const claimed = await cli(box, seat.path, ['claim', String(id), '--no-next']);
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const head = box.git(seat.path, 'rev-parse', 'HEAD');
  const tree = box.git(box.root, 'rev-parse', `${head}^{tree}`);
  const item = store.getItem(box.board, id);
  const job = store.writeBoardCommand(box.board, 'queueSubmitHandoff', [id, { agentId: seat.id, job: randomUUID(), main: head, commit: head, tree,
    executionCommit: head, executionTree: tree, digest: item.item_frozen_digest, companionDigest: null, leaseMs: 7_200_000 }], seat.id).job;
  store.startSubmitHandoff(box.board, id, { agentId: seat.id, job: job.id });
  // The worker's real loop: two lock waits, then a red test result that carries them.
  const { run } = scripted(['BOARD_BUSY', 'SLOT_DB_LOCKED', 'GATE_RED']);
  const error = await submitUntilSettled(run, { healthy: async () => true, wait: async () => {} }).catch(caught => caught);
  assert.equal(error.code, 'GATE_RED');
  store.completeSubmitHandoff(box.board, id, { agentId: seat.id, job: job.id,
    result: { code: 1, error: { code: 'GATE_RED', message: 'The fixture gate went red.', next: 'Fix the named source.' }, lockWaits: error.lockWaits } });
  const recorded = store.submitHandoff(box.board, id);
  assert.equal(recorded.state, 'red');
  assert.deepEqual(recorded.lockWaits, { count: 2, totalMs: 3000, codes: { BOARD_BUSY: 1, SLOT_DB_LOCKED: 1 } });
});
