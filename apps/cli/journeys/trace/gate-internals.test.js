/** pullboard trace <item> merges the gate job's steps, with ms times and gaps, into the item's timeline [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readJobSteps } from '../../src/io/trace.js';
import { traceLine } from '../../src/io/trace.js';
import { traceTimeline } from '../../src/io/trace.js';
import { cellBoard } from '../../../../packages/store/tests/fixtures/cell.js';
import { createJob } from '../../../../packages/jobs/index.js';
import { writeStep } from '../../../../packages/jobs/index.js';

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0, 0);

test('clause 1: trace <item> lists the board events and a gate job\'s steps in one time-ordered list with ms timestamps and gaps [C7]', t => {
  const board = cellBoard(t, ':memory:');
  const [id, other] = [41, 42];
  // One gate job: a dispatch, a retry of it, one shard that starts and ends, then the worker's exit.
  createJob(board.db, { id: 'job-aaaaaaaa-1', kind: 'gate', item: id, candidate: 'c'.repeat(40), now: T0 });
  writeStep(board.db, 'job-aaaaaaaa-1', 'dispatch', { runner: 'mini-1', attempt: 1 }, { now: T0 + 100 });
  writeStep(board.db, 'job-aaaaaaaa-1', 'dispatch', { runner: 'mini-2', attempt: 2 }, { seq: 1, now: T0 + 1_350 });
  writeStep(board.db, 'job-aaaaaaaa-1', 'shard.started', { files: 3 }, { now: T0 + 1_400 });
  writeStep(board.db, 'job-aaaaaaaa-1', 'shard.done', { exit: 0 }, { now: T0 + 4_900 });
  writeStep(board.db, 'job-aaaaaaaa-1', 'worker.exit', { reason: 'done' }, { now: T0 + 5_000 });
  createJob(board.db, { id: 'job-bbbbbbbb-2', kind: 'gate', item: other, now: T0 });
  writeStep(board.db, 'job-bbbbbbbb-2', 'dispatch', { runner: 'mini-9' }, { now: T0 + 50 });

  const jobs = readJobSteps(board.db);
  const events = [{ event_id: 1, event_at: new Date(T0 + 10).toISOString(), event_by: 'core-1', event_kind: 'claim', item_id: id, event_detail: '{}' }];
  const entries = traceTimeline({ lines: [], events, subject: String(id), jobs });
  const steps = entries.filter(entry => entry.source === 'job');
  assert.deepEqual(steps.map(entry => entry.command), ['gate:dispatch', 'gate:dispatch', 'gate:shard.started', 'gate:shard.done', 'gate:worker.exit']);
  assert.deepEqual(steps.map(entry => entry.time), [100, 1_350, 1_400, 4_900, 5_000].map(ms => new Date(T0 + ms).toISOString()), 'times carry milliseconds');
  assert.deepEqual(steps.map(entry => entry.ms), [null, 1_250, 50, 3_500, 100], 'each step shows the gap since the job\'s previous step');
  assert.ok(steps.every(entry => entry.item === id), 'another item\'s job is not in this timeline');
  assert.equal(entries[0].command, 'claim', 'the board event sits before the first gate step');
  const times = entries.map(entry => Date.parse(entry.time));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'one time-ordered list');
  assert.match(traceLine(steps[1]), /gate:dispatch  #\d+  ok  1250ms  job job-aaaa attempt 0 \{"runner":"mini-2","attempt":2\}$/u);
  assert.match(steps[4].why, /"reason":"done"/u);
});

test('clause 1: a board with no job tables traces without gate steps [C7]', t => {
  const board = cellBoard(t, ':memory:');
  board.db.exec('DROP TABLE job_step; DROP TABLE job;');
  assert.deepEqual(readJobSteps(board.db), []);
});
