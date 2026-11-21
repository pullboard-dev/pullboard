/** next's fallback gate reclaim never queues for the board writer: it skips while another process holds it [C7,#12583]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createJob } from '../../../../packages/jobs/index.js';
import { takeJob } from '../../../../packages/jobs/index.js';
import { writeStep } from '../../../../packages/jobs/index.js';
import { fallbackReclaim } from '../../src/io/reclaim.js';
import { withFixtureBoard } from '../fixtures/board.js';
import { createE2eHelpers } from '../fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A project whose board holds one gate job that lapsed long ago, after `finished` gate jobs that ended. */
function lapsedBox(finished = 0) {
  const box = e2e.project(undefined, undefined, { withWorktree: false });
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  withFixtureBoard(file, board => {
    for (let index = 0; index < finished; index += 1) {
      const id = `gate:done-${index}`;
      createJob(board.db, { id, kind: 'gate', item: 1000 + index, now: 500 });
      writeStep(board.db, id, 'done', {}, { now: 500 });
    }
    createJob(board.db, { id: 'gate:lapsed', kind: 'gate', item: 7, now: 1000 });
    writeStep(board.db, 'gate:lapsed', 'queued', {}, { now: 1000 });
    takeJob(board.db, 'gate:lapsed', 'old', { now: 1000 });
  });
  return { box, file };
}

/** The lapsed job's step and lease owner now. */
function lapsedJob(file) {
  return withFixtureBoard(file, board => board.db.prepare("SELECT job_step AS step, job_lease_owner AS owner FROM job WHERE job_id = 'gate:lapsed'").get() ?? null);
}

/** Hold the board's writer from a second connection, as a long verify or submit does, until the returned release runs. */
function holdWriter(file) {
  const db = new DatabaseSync(file);
  db.exec('BEGIN IMMEDIATE');
  return () => { try { db.exec('ROLLBACK'); } finally { db.close(); } };
}

/** The minimal command context the fallback reads: the board file, its clock and the checkout root. */
function contextFor({ box, file }) {
  return { file, clock: { now: () => new Date() }, info: { root: box.repo }, io: {}, allowSchemaUpgrade: false };
}

test('cli.io-reclaim.skips-busy-writer: clause 1: with the board writer held by another connection, the fallback reclaim returns null in under 200 ms and leaves the lapsed job as it was [C7]', async () => {
  const given = lapsedBox();
  const before = lapsedJob(given.file);
  const release = holdWriter(given.file);
  let outcome, ms;
  try {
    const started = performance.now();
    outcome = await fallbackReclaim(contextFor(given), 'next');
    ms = performance.now() - started;
  } finally { release(); }
  assert.equal(outcome, null);
  assert.ok(ms < 200, `the fallback took ${ms.toFixed(1)} ms with the writer held`);
  assert.deepEqual(lapsedJob(given.file), before, 'the lapsed job was not driven');
});

test('cli.io-reclaim.drives-when-writer-free: clause 2: with the writer free, a command\'s fallback reclaim drives the lapsed gate job one transition, as before [C7]', async () => {
  const given = lapsedBox();
  const status = await given.box.inProcess(given.box.repo, 'status');
  assert.equal(status.code, 0, `${status.out}${status.err}`);
  assert.notDeepEqual(lapsedJob(given.file), { step: 'queued', owner: 'old' }, 'the lapsed job moved');
});

test('cli.io-reclaim.cost-flat-with-lapsed-history: clause 3: with 400 finished gate jobs and one lapsed job, a fallback reclaim that meets a held writer stays under 200 ms [C7]: 1:10 of the live gate history', async () => {
  const given = lapsedBox(400);
  const release = holdWriter(given.file);
  const times = [];
  try {
    for (let index = 0; index < 5; index += 1) {
      const started = performance.now();
      assert.equal(await fallbackReclaim(contextFor(given), 'next'), null);
      times.push(performance.now() - started);
    }
  } finally { release(); }
  const median = times.sort((a, b) => a - b)[2];
  assert.ok(median < 200, `median fallback ${median.toFixed(1)} ms with 400 finished gate jobs and the writer held`);
});
