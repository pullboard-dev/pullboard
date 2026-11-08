/** Durable gate 13/20: the dispatcher row, ensureDispatcher and a wedged loop's replacement [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { privateFixtureFiles } from './fixture-child.js';
import { openBoard, closeBoard } from '../apps/lib/index.js';
import { LEASE_MS, jobView } from '../packages/jobs/index.js';
import { ensureDispatcher, renewDispatcher, DISPATCHER_JOB } from '../packages/drive/index.js';

const files = privateFixtureFiles('pullboard-durable-drive-');
after(() => rmSync(files.root, { recursive: true, force: true }));

/** Open a fresh real board file and hand its SQLite handle to the body. */
function withBoard(name, body) {
  const board = openBoard(join(files.root, `${name}.sqlite`));
  try { return body(board.db); } finally { closeBoard(board); }
}

/** A spawn stub that records every loop it was asked to start. */
function recorder() {
  const spawned = [];
  return { spawned, spawn: (lease) => { spawned.push(lease.owner); } };
}

test('clause 1: ensureDispatcher takes the row when its lease lapsed and spawns the loop; a wedged loop is replaced within 2 min [C7]', () => {
  withBoard('dispatcher', (db) => {
    const loops = recorder();
    const first = ensureDispatcher(db, { owner: 'loop-a', spawn: loops.spawn, now: 1000 });
    assert.deepEqual(first, { spawned: true, owner: 'loop-a', replaced: null }, 'an absent row is created, taken and its loop spawned');
    assert.equal(jobView(db, DISPATCHER_JOB).kind, 'dispatcher');

    const live = ensureDispatcher(db, { owner: 'loop-b', spawn: loops.spawn, now: 2000 });
    assert.deepEqual(live, { spawned: false, owner: 'loop-a', replaced: null }, 'a live lease means a loop runs: two never run');

    assert.equal(renewDispatcher(db, 'loop-a', { now: 10_000 }), true, 'the running loop renews its lease');
    assert.equal(ensureDispatcher(db, { owner: 'loop-b', spawn: loops.spawn, now: 10_000 + LEASE_MS }).spawned, false, 'at exactly 2 min of silence it is still held');

    const replaced = ensureDispatcher(db, { owner: 'loop-b', spawn: loops.spawn, now: 10_000 + LEASE_MS + 1 });
    assert.deepEqual(replaced, { spawned: true, owner: 'loop-b', replaced: 'loop-a' }, 'a loop silent for 2 min is replaced on the next ensure');
    assert.ok(LEASE_MS <= 120_000, 'the replacement window is at most 2 minutes');
    assert.equal(renewDispatcher(db, 'loop-a', { now: 10_000 + LEASE_MS + 2 }), false, 'the wedged loop learns it lost the row');

    assert.deepEqual(loops.spawned, ['loop-a', 'loop-b'], 'exactly one spawn per take');
    assert.deepEqual(jobView(db, DISPATCHER_JOB).steps.map(step => [step.name, step.seq, step.payload.owner]),
      [['dispatcher.spawned', 0, 'loop-a'], ['dispatcher.spawned', 1, 'loop-b']], 'each spawn is a step on the row');
    assert.throws(() => ensureDispatcher(db, { owner: 'loop-c' }), { code: 'DISPATCHER_SPAWN' });
  });
});
