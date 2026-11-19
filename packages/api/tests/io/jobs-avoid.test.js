/** A job offered with an avoid list is never given to a runner on it, behind jobs.avoidRunners; off, the list is ignored [C7,#9273]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { claimJob } from '../../index.js';
import { offerJob } from '../../index.js';
import { describeSetting } from '../../../config/index.js';

const boardWith = t => cellBoard(t, ':memory:').db;

test('api.jobs-avoid.jobs-avoidrunners-job-offered-avoid: clause 1: with jobs.avoidRunners on, a job offered with avoid:[runner-a] is never returned by claimJob to runner-a and is returned to runner-b [C7,#9273]', t => {
  const db = boardWith(t);
  offerJob(db, { id: 'gate:shard-1', kind: 'gate-shard', avoid: ['runner-a'], now: 1 });
  assert.equal(claimJob(db, { runner: 'runner-a', avoidRunners: true, now: 100 }), null, 'the avoided runner is offered nothing');
  assert.equal(claimJob(db, { runner: 'runner-a', avoidRunners: true, now: 10_000_000 }), null, 'a later claim by it still gets nothing');
  assert.equal(claimJob(db, { runner: 'runner-b', avoidRunners: true, now: 101 })?.job, 'gate:shard-1', 'another runner takes it');
});

test('api.jobs-avoid.jobs-avoidrunners-off-default-avoid: clause 2: with jobs.avoidRunners off (the default) an avoid list on an offer is ignored and claimJob behaves as before, and the setting is described [C7,#9273]', t => {
  const db = boardWith(t);
  offerJob(db, { id: 'gate:shard-2', kind: 'gate-shard', avoid: ['runner-a'], now: 1 });
  assert.equal(claimJob(db, { runner: 'runner-a', now: 100 })?.job, 'gate:shard-2', 'runner-a takes it with the setting off');
  const described = describeSetting('jobs.avoidRunners');
  assert.ok(described, 'jobs.avoidRunners has a description');
  assert.match(described.description, /ignored/u);
});
