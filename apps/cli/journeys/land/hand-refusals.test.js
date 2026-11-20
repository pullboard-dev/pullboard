/** pullboard land --item refuses unless landing.byHand is on, the coordinator asks, and the item is accepted [C7,#3775]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureSettledMachine } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

/** Turn landing.byHand on in the box's private machine settings. */
function byHandOn(box) {
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { landing: { byHand: true } });
}

/** The refusal a land --item run printed. */
function refusal(run) {
  assert.equal(run.code, 1, run.out + run.err);
  return JSON.parse(run.out).error;
}

test('cli.journeys-land-hand-refusals.with-landing-byhand-off-pullboard-land: clause 1: with landing.byHand off, pullboard land --item N refuses BY_HAND_OFF naming the setting [C7,#3775]', async t => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Land by hand' });
  const error = refusal(await box.runLocal(box.repo, 'land', '--item', String(item.item_id), '--json'));
  assert.equal(error.code, 'BY_HAND_OFF');
  assert.match(error.message + (error.next ?? ''), /landing\.byHand/u);
});

test('cli.journeys-land-hand-refusals.with-it-on-a-non-coordinator: clause 2: with it on, a non-coordinator seat is refused COORDINATOR_ONLY and an unaccepted item NOT_ACCEPTED, each with a next step [C7,#3775]', async t => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  byHandOn(box);
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Land by hand' });
  const seat = refusal(await box.runLocal(box.web, 'land', '--item', String(item.item_id), '--json'));
  assert.equal(seat.code, 'COORDINATOR_ONLY');
  assert.ok(seat.next, 'COORDINATOR_ONLY names a next step');
  const open = refusal(await box.runLocal(box.repo, 'land', '--item', String(item.item_id), '--json'));
  assert.equal(open.code, 'NOT_ACCEPTED');
  assert.ok(open.next, 'NOT_ACCEPTED names a next step');
});
