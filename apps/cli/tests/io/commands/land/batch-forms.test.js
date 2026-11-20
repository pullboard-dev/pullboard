/** With a landing batch size above 1 the lander waits for the open land job and offers the waiting items as one batch [C7,S8]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchOffer } from '../../../fixtures/landing/batch-offer.js';

const LINE = { landingBatchSize: 4, collisionFreeBatch: true };

test('cli.land.batch-forms: clause 1: four disjoint items accepted one after another give two land jobs, the second carrying the three that waited [C7,S8]', async t => {
  const rig = batchOffer(t, { files: [['a.js'], ['b.js'], ['c.js'], ['d.js']], line: LINE });
  const first = await rig.accept(1);
  assert.equal(first.items.length, 1, 'the first accept starts a job');
  for (const number of [2, 3, 4]) assert.equal((await rig.accept(number)).waiting, true, `accept ${number} waits for the open job`);
  assert.deepEqual(rig.jobs(), [['1']], 'nothing else was offered while the job was open');
  rig.settle([1]);
  const next = await rig.offer();
  assert.equal(next.items.length, 3);
  assert.deepEqual(rig.jobs(), [['1'], ['2', '3', '4']]);
});

test('cli.land.batch-collision-free: clause 1: two items changing the same file never share a land job [C7,S8]', async t => {
  const rig = batchOffer(t, { files: [['a.js'], ['shared.js', 'b.js'], ['shared.js', 'c.js']], line: LINE });
  for (const number of [1, 2, 3]) await rig.accept(number);
  rig.settle([1]);
  await rig.offer();
  assert.deepEqual(rig.jobs(), [['1'], ['2']], 'the overlapping item waits');
  rig.settle([2]);
  await rig.offer();
  assert.deepEqual(rig.jobs(), [['1'], ['2'], ['3']]);
});

test('cli.land.batch-defaults-unchanged: clause 2: with the line settings unset each accept offers its own land job [C7,S8]', async t => {
  const rig = batchOffer(t, { files: [['a.js'], ['b.js'], ['c.js']] });
  for (const number of [1, 2, 3]) assert.equal((await rig.accept(number)).items.length, 1);
  assert.deepEqual(rig.jobs(), [['1'], ['2'], ['3']]);
});
