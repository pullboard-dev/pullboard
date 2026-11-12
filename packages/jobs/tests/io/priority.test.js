/** Runner jobs carry a priority class set at offer; a claim takes the highest class first, keeps each class's reserve, and with no reserve claims as before [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { claimJob } from '../../../api/index.js';
import { offerJob } from '../../../api/index.js';

const RESERVE = { interactive: 0.3, gate: 0.3, landing: 0.2, background: 0.1 };

/** A board whose queue holds, oldest first, a background sweep, a landing, a gate and an agent's test run. */
function mixedQueue(t) {
  const { db } = cellBoard(t, ':memory:');
  offerJob(db, { id: 'main-test:1', kind: 'main-test', priority: 'background', now: 1 });
  offerJob(db, { id: 'land:1', kind: 'land', priority: 'landing', now: 2 });
  offerJob(db, { id: 'gate:1', kind: 'gate', priority: 'gate', now: 3 });
  offerJob(db, { id: 'test:1', kind: 'test', priority: 'interactive', now: 4 });
  return db;
}

const claimed = (db, fields = {}) => claimJob(db, { runner: 'r1', now: 10, ...fields })?.job ?? null;

test('a runner claims the highest priority class first: interactive, gate, landing, then background [C7]', t => {
  const db = mixedQueue(t);
  const order = [1, 2, 3, 4].map(() => claimed(db, { reserve: {}, jobs: 8 }));
  assert.deepEqual(order, ['test:1', 'gate:1', 'land:1', 'main-test:1']);
  assert.equal(claimed(db, { reserve: {}, jobs: 8 }), null, 'the queue is empty once every class is taken');
});

test('a class with a reserve still gets its reserved slot under full load [C7]', t => {
  const { db } = cellBoard(t, ':memory:');
  for (let n = 1; n <= 6; n += 1) offerJob(db, { id: `test:${n}`, kind: 'test', priority: 'interactive', now: n });
  offerJob(db, { id: 'main-test:1', kind: 'main-test', priority: 'background', now: 9 });
  // A 4-slot runner: interactive outranks background for the first three slots, then the last free slot is background's reserve.
  const order = [1, 2, 3, 4].map(() => claimed(db, { reserve: RESERVE, jobs: 4 }));
  assert.deepEqual(order, ['test:1', 'test:2', 'test:3', 'main-test:1']);
  // Without a background reserve, the same full runner gives every slot to interactive runs.
  const plain = cellBoard(t, ':memory:').db;
  for (let n = 1; n <= 6; n += 1) offerJob(plain, { id: `test:${n}`, kind: 'test', priority: 'interactive', now: n });
  offerJob(plain, { id: 'main-test:1', kind: 'main-test', priority: 'background', now: 9 });
  assert.deepEqual([1, 2, 3, 4].map(() => claimed(plain, { reserve: { interactive: 0.5 }, jobs: 4 })), ['test:1', 'test:2', 'test:3', 'test:4']);
});

test('with no priority setting the claim order is unchanged: landings, then test runs, then the rest by age [C7]', t => {
  const db = mixedQueue(t);
  const order = [1, 2, 3, 4].map(() => claimed(db, { jobs: 4 }));
  assert.deepEqual(order, ['land:1', 'test:1', 'main-test:1', 'gate:1']);
});

test('the class is the enqueuing command\'s: an unknown class is refused at offer [C7]', t => {
  const { db } = cellBoard(t, ':memory:');
  assert.throws(() => offerJob(db, { id: 'x:1', kind: 'test', priority: 'urgent', now: 1 }), { code: 'JOB_PRIORITY' });
});
