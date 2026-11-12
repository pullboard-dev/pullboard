/** next parks a claim that was made to wait, and offers it first to the seat that built it once the wait lands [N2,B5,B10]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crossLaneFixture } from '../../tests/fixtures/e2e.js';
import { FIXTURE_MODEL } from '../../tests/fixtures/e2e.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';

test('clause 1: next parks a claimed item whose new wait is unmet and offers other work instead [N2,B5,B10]', async t => {
  const box = crossLaneFixture(t);
  joinFixtureSeat(box, box.web, 'web', { model: FIXTURE_MODEL, run: (root, ...args) => box.runAs(box.session, root, ...args) });
  const blocker = box.add('web', 'Prerequisite');
  const other = box.add('web', 'Other work');
  const work = box.add('web', 'Claimed then made to wait');
  box.json(box.runAs(box.session, box.web, 'claim', String(work), '--json'));
  box.json((await box.runLocal(box.repo, 'edit', String(work), '--after', String(blocker), '--reason', 'Wait for the prerequisite', '--json')));
  const parked = box.json(box.runAs(box.session, box.web, 'next', '--build', '--json'));
  assert.notEqual(parked.item?.item_id, work, 'the waiting claim is not returned');
  assert.ok([blocker, other].includes(parked.item?.item_id), 'other work is offered');
  const shown = box.json((await box.runLocal(box.repo, 'show', String(work), '--json')));
  assert.equal(shown.item_status, 'open', 'the claim was released as waiting');
  assert.equal(shown.item_after, String(blocker));
  const again = box.json(box.runAs(box.session, box.web, 'next', '--build', '--json'));
  assert.notEqual(again.item?.item_id, work, 'it stays parked while the wait is unmet');
});

/** A withdrawn prerequisite stands in for a landed one: both end the wait, and the fixture kit has no cheap way to verify an item. */
test('clause 2: once the wait is satisfied the parked item is offered first to the seat that built it [N2,B5,B10]', async t => {
  const box = crossLaneFixture(t);
  joinFixtureSeat(box, box.web, 'web', { model: FIXTURE_MODEL, run: (root, ...args) => box.runAs(box.session, root, ...args) });
  const blocker = box.add('web', 'Prerequisite');
  const work = box.add('web', 'Claimed then made to wait');
  box.json(box.runAs(box.session, box.web, 'claim', String(work), '--json'));
  box.json((await box.runLocal(box.repo, 'edit', String(work), '--after', String(blocker), '--reason', 'Wait for the prerequisite', '--json')));
  const parked = box.json(box.runAs(box.session, box.web, 'next', '--build', '--json'));
  assert.equal(parked.item?.item_id, blocker, 'only the prerequisite is free while the wait is unmet');
  box.json(box.runAs(box.session, box.web, 'release', String(blocker), '--reason', 'OTHER', '--note', 'Return fixture prerequisite', '--no-next', '--json'));
  const later = box.add('web', 'Later work');
  box.json((await box.runLocal(box.repo, 'withdraw', String(blocker), '--note', 'Prerequisite done elsewhere', '--json')));
  const offered = box.json(box.runAs(box.session, box.web, 'next', '--build', '--json'));
  assert.equal(offered.item?.item_id, work, `the parked item comes back to its builder before #${later}`);
});
