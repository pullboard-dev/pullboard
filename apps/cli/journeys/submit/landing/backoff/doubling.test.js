/** @pullboard-test-input apps/cli/src/io/landing/automatic.js apps/cli/tests/fixtures/child.js apps/cli/tests/fixtures/landing/backoff.js packages/landing/index.js */
/** An idle lander backs off 60 s, doubling to 5 minutes while the outcome repeats [C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../../tests/fixtures/e2e.js';
import { onBoard } from '../../../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../../../tests/fixtures/land/project.js';
import {
  HELD,
  backingOff,
  command,
  heldTrunk,
  leaseRequests,
  record,
  resumeLander,
  stopLanders,
} from '../../../../tests/fixtures/landing/backoff.js';
import * as store from '../../../../../../packages/store/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const land = makeLandProjectFixtures({ sandbox, project, commitFile });

test('clause 1: a landing that moves nothing waits 60 s and doubles to 5 minutes while the outcome repeats [C7]', { timeout: 420_000 }, async t => { // budget: seven real idle landings in a private repo; hang ceiling, not speed.
  const { box } = heldTrunk(t, land);
  // The real lander, woken by a command, lands nothing once and backs off 60 s.
  const first = await backingOff(box);
  assert.equal(first.pending.backoff.backoffMs, 60_000);
  assert.deepEqual(Object.keys(first.pending.backoff.marks.held), [HELD], 'the back-off watches the held test file');
  assert.equal(first.pending.dueAt, first.pending.backoff.retryAt, 'the pending wake is due when the back-off ends');
  // A lander that dies while backing off is restarted by the next command at its backed-off time, not at once.
  stopLanders(box);
  command(box, 'list');
  assert.equal(Date.parse(record(box, 'timer.json').dueAt), Date.parse(first.pending.backoff.retryAt), 'recovery keeps the back-off');
  assert.equal(leaseRequests(box).length, first.requests, 'the command started no landing');
  // Each further idle attempt, resumed from its own record on an injected clock, doubles the wait up to 5 minutes.
  const waits = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const observed = resumeLander(box);
    assert.equal(observed.backoffs.length, 1, 'the idle landing records one back-off');
    const next = observed.backoffs[0];
    assert.equal(next.outcome, 'NOTHING_TO_LAND');
    assert.equal(observed.clock - observed.start, next.backoffMs, 'the lander waited out the whole back-off');
    assert.equal(Date.parse(observed.pending.dueAt), observed.start + next.backoffMs, 'the next wake is no sooner than the back-off');
    assert.equal(observed.pending.backoff.backoffMs, next.backoffMs, 'the next record carries the back-off');
    assert.equal(observed.timer.dueAt, observed.pending.dueAt, 'its timer waits for it');
    waits.push(next.backoffMs);
  }
  assert.deepEqual([first.pending.backoff.backoffMs, ...waits], [60_000, 120_000, 240_000, 300_000, 300_000]);
  // With nothing ready, no attempt took a landing lease: the back-off alone paced them [C7,#5862].
  assert.equal(leaseRequests(box).length, first.requests, 'an idle attempt requests no landing lease');
  // A landing replaced by one that moves nothing keeps the same outcome, so the wait stays at its 5-minute ceiling.
  const idle = resumeLander(box, { idle: true });
  assert.equal(idle.backoffs[0].outcome, 'NOTHING_TO_LAND');
  assert.equal(idle.backoffs[0].backoffMs, 300_000);
  assert.throws(() => onBoard(box, board => store.landingLeaseMove(board, { agentId: 'coordinator', action: 'request', token: randomUUID(),
    branch: 'refs/heads/main', pid: process.pid, backoffMs: 600_000 })), error => error.code === 'LAND_LEASE_REQUEST');
});
