/** Runner slot wait and queue depth per job kind and hour, with exact seeded figures [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import {
  createJob,
  writeStep,
} from '../../../../../packages/jobs/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fixtureOpenBoard } from '../../../tests/fixtures/testkit.js';

/** Epoch ms of a time on the seeded day. */
const at = (time) => Date.parse(`2026-10-12T${time}Z`);

/** Seed the known jobs, steps and events. */
function seed(db) {
  /** A test-run job: queued, then running. */
  const testRun = (id, queued, running) => {
    createJob(db, { id, kind: 'test-run', now: at(queued) });
    writeStep(db, id, 'queued', {}, { now: at(queued) });
    if (running) writeStep(db, id, 'running', {}, { now: at(running) });
  };
  testRun('out', '08:00:00.000', '08:00:05.000');
  testRun('a', '09:59:59.000', '10:00:01.000');
  testRun('b', '10:00:00.500', '10:00:02.500');
  testRun('c', '10:10:00.000', '10:10:03.000');
  testRun('d', '10:10:01.000', '10:10:05.000');
  testRun('e', '10:50:00.000', '10:50:10.000');
  /** A pull job: offered, then claimed on one or more attempts. */
  const gate = (id, offered, claims) => {
    createJob(db, { id, kind: 'gate', now: at(offered) });
    writeStep(db, id, 'offered', {}, { now: at(offered) });
    claims.forEach((claimed, index) => writeStep(db, id, 'claimed', {}, { seq: index + 1, now: at(claimed) }));
  };
  gate('g1', '11:00:10.000', ['11:00:40.000']);
  gate('g2', '11:20:00.000', ['11:21:00.000', '11:40:00.000']);
  gate('g3', '11:30:00.000', []);
  gate('g4', '11:05:00.000', []);
  writeStep(db, 'g4', 'verdict', {}, { now: at('11:06:00.000') });
}


/** A project whose board holds the seeded rows; the board is closed again before the CLI reads it. */
function fixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const board = fixtureOpenBoard({ boardFile: join(box.repo, '.git', 'pullboard', 'board.sqlite'), web: box.repo });
  try { seed(board.db); } finally { store.closeBoard(board); }
  return box;
}

/** Run one real CLI invocation in the project and return its code and output. */
function command(box, args) {
  return box.runLocal(box.web, ...args);
}

test('runners wait and depth: seeded steps give exact p50, p90, max and depth per kind and hour [C7]', async t => {
  const box = fixture(t);
  const result = await command(box, ['stats', 'runners', '--window', '3h', '--until', '2026-10-12T12:00:00Z', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const { waits } = JSON.parse(result.stdout).runners;
  assert.equal(waits.from, '2026-10-12T09:00:00.000Z');
  assert.equal(waits.until, '2026-10-12T12:00:00.000Z');
  assert.deepEqual(waits.hours, [
    { hour: '2026-10-12T09:00:00.000Z', kind: 'test-run', count: 0, p50Ms: null, p90Ms: null, maxMs: null, depthStart: 0, depthPeak: 1, depthEnd: 1 },
    { hour: '2026-10-12T10:00:00.000Z', kind: 'test-run', count: 5, p50Ms: 3000, p90Ms: 10000, maxMs: 10000, depthStart: 1, depthPeak: 2, depthEnd: 0 },
    { hour: '2026-10-12T11:00:00.000Z', kind: 'gate', count: 2, p50Ms: 30000, p90Ms: 60000, maxMs: 60000, depthStart: 0, depthPeak: 1, depthEnd: 1 },
  ]);
  assert.deepEqual(waits.kinds, [
    { kind: 'gate', count: 2, p50Ms: 30000, p90Ms: 60000, maxMs: 60000 },
    { kind: 'test-run', count: 5, p50Ms: 3000, p90Ms: 10000, maxMs: 10000 },
  ]);
});

test('runners wait text lists each kind and hour, and a bad time is refused [C7]', async t => {
  const box = fixture(t);
  const text = await command(box, ['stats', 'runners', '--window', '3h', '--until', '2026-10-12T12:00:00Z']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /test-run: 5 started, wait p50 3\.0s p90 10\.0s max 10\.0s/u);
  assert.match(text.stdout, /gate: 2 started, wait p50 30\.0s p90 60\.0s max 60\.0s/u);
  const bad = await command(box, ['stats', 'runners', '--until', 'yesterday', '--json']);
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.stdout).error.code, 'USAGE');
});
