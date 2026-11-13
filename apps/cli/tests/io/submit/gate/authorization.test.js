/** A queued submit's authorization source check runs in the same one runner job as doctrine and test selection [C7,#5674]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteGateWanted } from '../../../../src/io/submit/gate.js';
import { PARTS } from '../../../fixtures/submit/authorization.js';
import { countingRunner } from '../../../fixtures/submit/authorization.js';
import { fixture } from '../../../fixtures/submit/authorization.js';
import { ran } from '../../../fixtures/submit/authorization.js';
import { submitStages } from '../../../fixtures/submit/authorization.js';

test('clause 1: authorization, doctrine and selection run inside one runner job and the controller receives each artifact [C7,#5674]', async t => {
  const box = fixture(t), runner = countingRunner(box);
  const settled = await submitStages(box, runner);
  assert.deepEqual(settled.map(row => row.status), ['fulfilled', 'fulfilled', 'fulfilled']);
  assert.equal(runner.counts.jobs, 1, 'one runner job carries every stage');
  const analysis = settled[0].value;
  assert.deepEqual(analysis.authorization, { paths: ['src/thing.js'], mechanical: ['packages/moved.js'], ownership: null });
  assert.deepEqual(analysis.doctrine, [{ rule: 'fixture', commit: box.source }]);
  assert.deepEqual(analysis.plan.proofFiles, ['test/a.test.js']);
  for (const stage of PARTS) assert.ok(Number.isInteger(analysis.steps[stage]), `${stage} carries its runner milliseconds`);
  const authorized = JSON.parse(ran(box, 'authorization'));
  assert.deepEqual([authorized.item, authorized.lane, authorized.commit], [5674, 'core', box.source], 'the runner checked the pinned candidate for the frozen item');
  assert.notEqual(Number(authorized.pid), process.pid, 'the lane check ran in the runner job, not in this controller');
  assert.ok(ran(box, 'doctrine') && ran(box, 'selection'), 'doctrine and selection ran in the runner job too');
});

test('clause 1: a lane refusal comes back as data for the controller to route after proof, never as a runner red [C7,#5674]', async t => {
  const box = fixture(t, { sandbox: 'foreign' }), runner = countingRunner(box);
  const settled = await submitStages(box, runner);
  assert.deepEqual(settled.map(row => row.status), ['fulfilled', 'fulfilled', 'fulfilled']);
  assert.deepEqual(settled[0].value.authorization, { mechanical: [], ownership: { message: 'outside the web lane: docs/x.md', paths: ['docs/x.md'], policy: 'p' } });
});

test('clause 1: an accepted main without the sandbox check reports it skipped, so the controller checks it at home [C7,#5674]', async t => {
  const box = fixture(t, { sandbox: 'absent' }), runner = countingRunner(box);
  const settled = await submitStages(box, runner);
  assert.equal(settled[0].status, 'fulfilled');
  assert.match(settled[0].value.authorization.skipped, /lacks submissionPaths/u);
  assert.equal(ran(box, 'authorization'), null);
});

test('clause 2: with no runner registered and runners-only off, the queued submit analyses on this machine as today [C7,#5674]', () => {
  assert.equal(remoteGateWanted({}, { runners: [] }), false, 'no runner: every stage stays local');
  assert.equal(remoteGateWanted({}, { runners: [{ host: 'r', slots: 2, browser: 1 }] }), true, 'a registered runner takes the one analysis job');
});
