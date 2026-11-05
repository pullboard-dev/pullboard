/** A BLOCKED, ROUTED_ELSEWHERE or INELIGIBLE release stops next offering the item to that lane and route and shows it as needing re-scope [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { healthReport } from '../packages/health/index.js';
import { dispatchHealth } from '../packages/sentinels/index.js';
import * as store from '../packages/store/index.js';
import { cli, fixture } from './next-take-fixture.js';

/** Claim an item for a seat and release it with a reason, as a seat that gives work back does. */
function giveBack(box, id, seat, reason) {
  box.claim(id, seat);
  store.release(box.board, id, seat.id, 'The fixture seat cannot build this item as scoped', reason);
}

for (const reason of ['BLOCKED', 'ROUTED_ELSEWHERE', 'INELIGIBLE']) {
  test(`${reason} stops next offering the item to the same lane and route; health and status name it (clause 1, clause 2) [C7]`, async t => {
    const box = await fixture(t);
    const id = box.add('Item that needs re-scope');
    giveBack(box, id, box.seats.actor, reason);
    box.advance(31 * 60_000);
    const sibling = await cli(box, box.seats.builder.path, ['next', '--take']);
    assert.equal(sibling.code, 1, sibling.out + sibling.err);
    assert.equal(typeof sibling.document?.error?.code, 'string', 'native no-work refusal is retained');
    assert.notEqual(sibling.document?.item?.item_id, id, `a second seat of the same lane and route is not offered the ${reason} item`);
    assert.equal(store.getItem(box.board, id).item_status, 'open');
    const rescope = store.allItemsNeedingRescope(box.board);
    assert.equal(rescope.length, 1);
    assert.equal(rescope[0].id, id);
    assert.match(rescope[0].reasons[0], new RegExp(reason));
    const health = healthReport({ db: box.board.db, root: box.root, config: box.config,
      now: box.clock.now(), dispatchHealth });
    const finding = health.stuck.find(row => row.cause === 'NEEDS_RESCOPE' && row.item === id);
    assert.ok(finding, 'health names the blocked scope immediately');
    assert.equal(finding.owner.who, 'coordinator');
    assert.match(finding.why, new RegExp(reason));
    assert.deepEqual(finding.detail.reasons, rescope[0].reasons);
    const status = await cli(box, box.root, ['status']);
    assert.equal(status.document.needsRescope[0].id, id, 'status shows the item as needing re-scope with its release reasons');
    store.editItem(box.board, id, { agentId: 'coordinator', criterion: 'The fixture succeeds after the coordinator re-scoped the item.', reason: 'The first bar named work this lane could not build.' });
    assert.deepEqual(store.allItemsNeedingRescope(box.board), [], 'an edit returns the item to the lane and route');
    const again = await cli(box, box.seats.builder.path, ['next', '--take']);
    assert.equal(again.document.item.item_id, id, 'after the edit next offers the item again');
  });
}

for (const reason of ['OTHER', 'BUDGET', 'TAKEN_OVER']) {
  test(`${reason} keeps today's behaviour and never marks the item for re-scope (clause 3) [C7]`, async t => {
    const box = await fixture(t);
    const id = box.add('Item given back for another reason');
    box.claim(id, box.seats.actor);
    store.release(box.board, id, box.seats.actor.id, 'Give the fixture item back to the board', reason);
    assert.deepEqual(store.allItemsNeedingRescope(box.board), []);
    box.advance(31 * 60_000);
    const sibling = await cli(box, box.seats.builder.path, ['next', '--take']);
    assert.equal(sibling.document.item.item_id, id, `${reason} leaves the item offered to the same lane and route`);
  });
}

for (const reset of ['refreeze', 'reroute']) {
  test(`${reset} restores a scoped-out item through native next (clause 1) [C7]`, async t => {
    const box = await fixture(t);
    const id = box.add('Scope reset fixture');
    giveBack(box, id, box.seats.actor, 'ROUTED_ELSEWHERE');
    assert.equal(store.itemsNeedingRescope(box.board, 'web', 'strong').length, 1);
    if (reset === 'refreeze') store.refreeze(box.board, id, { agentId: 'coordinator',
      freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: 'new-scope' }) });
    else store.editItem(box.board, id, { agentId: 'coordinator', route: 'mid' });
    assert.deepEqual(store.allItemsNeedingRescope(box.board), []);
    box.advance(31 * 60_000);
    const selected = await cli(box, box.seats.builder.path, ['next', '--build']);
    assert.equal(selected.code, 0, selected.out + selected.err);
    assert.equal(selected.document.item.item_id, id);
  });
}

test('a named blocker must land before its blocked scope is offered again (clause 1) [C7]', async t => {
  const box = await fixture(t);
  const blocker = box.add('Named blocker', { lane: 'docs' });
  const id = box.add('Waits for the blocker');
  box.claim(id, box.seats.actor);
  store.release(box.board, id, box.seats.actor.id, 'Needs the named blocker', { blockedOn: [blocker] }, 'BLOCKED');
  // Controlled fixture state represents accepted work; it is not a test or production proof receipt.
  store.setItem(box.board, blocker, { item_status: 'verified' });
  assert.equal(store.itemsNeedingRescope(box.board, 'web', 'strong').some(row => row.id === id), true,
    'acceptance alone does not mean the blocker landed');
  store.merged(box.board, blocker, { agentId: 'coordinator', commit: box.git(box.root, 'rev-parse', 'HEAD') });
  assert.deepEqual(store.itemsNeedingRescope(box.board, 'web', 'strong'), []);
  box.advance(31 * 60_000);
  const selected = await cli(box, box.seats.builder.path, ['next', '--build']);
  assert.equal(selected.code, 0, selected.out + selected.err);
  assert.equal(selected.document.item.item_id, id);
});

test('scope health bounds long release text while retaining its complete detail (clause 2) [C7]', async t => {
  const box = await fixture(t);
  const id = box.add('Long scope explanation');
  box.claim(id, box.seats.actor);
  const note = 'Specific blocker context '.repeat(600);
  store.release(box.board, id, box.seats.actor.id, note, 'BLOCKED');
  const report = healthReport({ db: box.board.db, root: box.root, config: box.config,
    now: box.clock.now(), dispatchHealth });
  const finding = report.stuck.find(row => row.cause === 'NEEDS_RESCOPE' && row.item === id);
  assert.equal(finding.why.length, 8192, 'the new finding fits the native health receipt field limit');
  assert.ok(finding.detail.reasons[0].includes(note), 'the full explanation remains available for re-scoping');
});
