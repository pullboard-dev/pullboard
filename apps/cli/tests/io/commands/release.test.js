/** With gate.endStaleJobs on, release and refreeze end the item's offered gate job and open shard jobs; off, they stay open as before [C7,#12036]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { SHARD_JOB_KIND } from '../../../../../packages/api/index.js';
import { jobViews } from '../../../../../packages/api/index.js';
import { offerJob } from '../../../../../packages/api/index.js';
import { machineSettingsFile } from '../../../../../packages/config/index.js';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';

const SOURCE = 'c'.repeat(40), MAIN = 'd'.repeat(40);

/** Write this fixture machine's settings with gate.endStaleJobs set as asked, keeping the settings the fixture wrote. */
function settings(endStaleJobs) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false, endStaleJobs } }));
}

/** Offer one gate job and 12 gate-shard jobs for an item, and return their ids. */
function offered(box, item, now) {
  const ids = [`gate:${item}:x`, ...Array.from({ length: 12 }, (_, at) => `gate:${item}:x:shard:${at}`)];
  offerJob(box.board.db, { id: ids[0], kind: 'gate', needs: [], item, candidate: SOURCE, base: MAIN, now });
  for (const id of ids.slice(1)) offerJob(box.board.db, { id, kind: SHARD_JOB_KIND, needs: [], item, candidate: SOURCE, now });
  return ids;
}

/** The step of each named job. */
const steps = (box, ids) => jobViews(box.board.db, ids).map(view => view.step);

/** The ended jobs' steps that record why they ended. */
const reasons = (box, ids) => jobViews(box.board.db, ids).flatMap(view => view.steps.filter(step => step.name === 'withdrawn').map(step => JSON.stringify(step.payload ?? '')));

test('cli.io-commands-release.release-and-refreeze-end-gate-jobs: clause 1: with gate.endStaleJobs on, release and refreeze of an item with an offered gate job and 12 open shard jobs leave none open and name the reason, and with the setting off they stay as today [C7,#12036]', async t => {
  const box = await fixture(t);
  const released = box.add('Released with a gate offered');
  const refrozen = box.add('Refrozen with a gate offered');
  const keptByRelease = box.add('Released with the setting off');
  const keptByRefreeze = box.add('Refrozen with the setting off');
  const other = box.add('Another item keeps its jobs');
  box.claim(released);
  box.claim(keptByRelease, box.seats.actor);
  const jobs = {
    released: offered(box, released, 1), refrozen: offered(box, refrozen, 2),
    keptByRelease: offered(box, keptByRelease, 3), keptByRefreeze: offered(box, keptByRefreeze, 4), other: offered(box, other, 5),
  };
  const everyStep = (ids, step) => ids.map(() => step);

  settings(false);
  const offReleased = await cli(box, box.seats.actor.path, ['release', String(keptByRelease), '--reason', 'OTHER', '--note', 'setting off', '--no-next']);
  assert.equal(offReleased.code, 0, offReleased.out + offReleased.err);
  const offRefrozen = await cli(box, box.root, ['refreeze', String(keptByRefreeze)]);
  assert.equal(offRefrozen.code, 0, offRefrozen.out + offRefrozen.err);
  assert.deepEqual(steps(box, jobs.keptByRelease), everyStep(jobs.keptByRelease, 'offered'), 'with the setting off a release leaves the gate job and shards open');
  assert.deepEqual(steps(box, jobs.keptByRefreeze), everyStep(jobs.keptByRefreeze, 'offered'), 'with the setting off a refreeze leaves them open');

  settings(true);
  const onReleased = await cli(box, box.seats.builder.path, ['release', String(released), '--reason', 'OTHER', '--note', 'setting on', '--no-next']);
  assert.equal(onReleased.code, 0, onReleased.out + onReleased.err);
  assert.deepEqual(steps(box, jobs.released), everyStep(jobs.released, 'done'), 'a release ends the gate job and all 12 shards');
  assert.ok(reasons(box, jobs.released).every(reason => /released/u.test(reason)) && reasons(box, jobs.released).length === 13, 'each ended job names the release');
  const onRefrozen = await cli(box, box.root, ['refreeze', String(refrozen)]);
  assert.equal(onRefrozen.code, 0, onRefrozen.out + onRefrozen.err);
  assert.deepEqual(steps(box, jobs.refrozen), everyStep(jobs.refrozen, 'done'), 'a refreeze ends the gate job and all 12 shards');
  assert.ok(reasons(box, jobs.refrozen).every(reason => /refrozen/u.test(reason)) && reasons(box, jobs.refrozen).length === 13, 'each ended job names the refreeze');
  assert.deepEqual(steps(box, jobs.other), everyStep(jobs.other, 'offered'), 'another item keeps its jobs');
});
