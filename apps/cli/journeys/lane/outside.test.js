/** @pullboard-test-input source-tree */
/** Release and automatic next respect the seat's own lane and route [B3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crossLaneFixture } from '../../tests/fixtures/e2e.js';

test('release ends without automatically claiming another item [B3]', t => {
  const box = crossLaneFixture(t);
  const seat = box.seat('release-seat', 'web', box.session, 'mid');
  const first = box.add('web', 'First release item', 'mid');
  const second = box.add('web', 'Second available item', 'mid');
  box.json(box.runAs(box.session, seat.root, 'claim', String(first), '--json'));
  const released = box.runAs(box.session, seat.root, 'release', String(first), '--reason', 'ROUTED_ELSEWHERE', '--json');
  box.json(released);
  const firstAfter = box.json(box.run(box.repo, 'show', String(first), '--json'));
  const secondAfter = box.json(box.run(box.repo, 'show', String(second), '--json'));
  assert.equal(firstAfter.item_status, 'open');
  assert.equal(secondAfter.item_status, 'open');
  assert.notEqual(secondAfter.item_owner, seat.agent);
});

test('next does not claim strong work from another lane for a mid-route seat [B3]', t => {
  const box = crossLaneFixture(t);
  const seat = box.seat('sonnet-seat', 'web', box.session, 'mid');
  const foreign = box.add('api', 'Strong work in another lane', 'strong');
  for (const args of [['next', '--build'], ['next', '--take']]) {
    box.runAs(box.session, seat.root, ...args);
    const after = box.json(box.run(box.repo, 'show', String(foreign), '--json'));
    assert.equal(after.item_status, 'open');
    assert.notEqual(after.item_owner, seat.agent);
  }
});
