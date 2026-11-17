/** A BLOCKED, ROUTED_ELSEWHERE or INELIGIBLE release stops next offering the item to that lane and route and shows it as needing re-scope [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { healthReport } from '../../../../../health/index.js';
import * as store from '../../../../../store/index.js';
import { fixture } from '../../../fixtures/next.js';
import { next } from '../../../fixtures/next.js';
import { take } from '../../../fixtures/next.js';

/** The upper-layer dispatch observation health asks for; this cell's test needs no dispatch findings, only the rescope ones. */
const dispatchHealth = () => ({ findings: [] });

/** Claim an item for a seat and release it with a reason, as a seat that gives work back does. */
function giveBack(box, id, seat, reason) {
  box.claim(id, seat);
  store.release(box.board, id, seat.id, 'The fixture seat cannot build this item as scoped', reason);
}

for (const reason of ['BLOCKED', 'ROUTED_ELSEWHERE', 'INELIGIBLE']) {
  test(`clause 1 and clause 2: ${reason} stops next offering the item to the same lane and route; health names it [C7]`, async t => {
    const box = fixture(t);
    const id = box.add('Item that needs re-scope');
    giveBack(box, id, box.seats.actor, reason);
    box.advance(31 * 60_000);
    box.as('builder');
    const sibling = await take(box);
    assert.notEqual(sibling.item?.item_id, id, `a second seat of the same lane and route is not offered the ${reason} item`);
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
    store.editItem(box.board, id, { agentId: 'coordinator', criterion: 'The fixture succeeds after the coordinator re-scoped the item.', reason: 'The first bar named work this lane could not build.' });
    assert.deepEqual(store.allItemsNeedingRescope(box.board), [], 'an edit returns the item to the lane and route');
    const again = await take(box);
    assert.equal(again.item.item_id, id, 'after the edit next offers the item again');
  });
}

for (const reason of ['OTHER', 'BUDGET', 'TAKEN_OVER']) {
  test(`clause 3: ${reason} keeps today's behaviour and never marks the item for re-scope [C7]`, async t => {
    const box = fixture(t);
    const id = box.add('Item given back for another reason');
    box.claim(id, box.seats.actor);
    store.release(box.board, id, box.seats.actor.id, 'Give the fixture item back to the board', reason);
    assert.deepEqual(store.allItemsNeedingRescope(box.board), []);
    box.advance(31 * 60_000);
    box.as('builder');
    const sibling = await take(box);
    assert.equal(sibling.item.item_id, id, `${reason} leaves the item offered to the same lane and route`);
  });
}

for (const reset of ['refreeze', 'reroute']) {
  test(`clause 1: ${reset} restores a scoped-out item through next [C7]`, async t => {
    const box = fixture(t);
    const id = box.add('Scope reset fixture');
    giveBack(box, id, box.seats.actor, 'ROUTED_ELSEWHERE');
    assert.equal(store.itemsNeedingRescope(box.board, 'web', 'strong').length, 1);
    if (reset === 'refreeze') store.refreeze(box.board, id, { agentId: 'coordinator',
      freeze: item => ({ text: JSON.stringify({ title: item.item_title, criterion: item.item_criterion, check: item.item_check, rows: [] }), digest: 'new-scope' }) });
    else store.editItem(box.board, id, { agentId: 'coordinator', route: 'mid' });
    assert.deepEqual(store.allItemsNeedingRescope(box.board), []);
    box.advance(31 * 60_000);
    box.as('builder');
    const selected = await next(box, { build: true });
    assert.equal(selected.item.item_id, id);
  });
}

test('moves.release-rescope.a-named-blocker-must-land-before-its: clause 1: a named blocker must land before its blocked scope is offered again [C7]', async t => {
  const box = fixture(t, { reviewers: true });
  const blocker = box.add('Named blocker');
  const id = box.add('Waits for the blocker');
  box.claim(id, box.seats.actor);
  store.release(box.board, id, box.seats.actor.id, 'Needs the named blocker', { blockedOn: [blocker] }, 'BLOCKED');
  // Synthetic board-state lifecycle; submitFixture explicitly claims no gate execution.
  box.submit(blocker);
  const submitted = store.getItem(box.board, blocker);
  store.verify(box.board, blocker, { agentId: box.seats.outside.id, decision: 'ACCEPT',
    reason: 'CRITERION_MET', note: 'Synthetic board-state lifecycle; no gate proof claimed.',
    head: submitted.item_commit, digest: submitted.item_frozen_digest, policy: 'any', familyPolicy: 'off' });
  assert.equal(store.itemsNeedingRescope(box.board, 'web', 'strong').some(row => row.id === id), true,
    'acceptance alone does not mean the blocker landed');
  store.merged(box.board, blocker, { agentId: 'coordinator', commit: box.git('rev-parse', 'HEAD') });
  assert.deepEqual(store.itemsNeedingRescope(box.board, 'web', 'strong'), []);
  box.advance(31 * 60_000);
  box.as('builder');
  const selected = await next(box, { build: true });
  assert.equal(selected.item.item_id, id);
});

test('moves.release-rescope.scope-health-bounds-long-release-text-while: clause 2: scope health bounds long release text while retaining its complete detail [C7]', t => {
  const box = fixture(t);
  const id = box.add('Long scope explanation');
  box.claim(id, box.seats.actor);
  const note = 'Specific blocker context '.repeat(600).trim();
  store.release(box.board, id, box.seats.actor.id, note, 'BLOCKED');
  const report = healthReport({ db: box.board.db, root: box.root, config: box.config,
    now: box.clock.now(), dispatchHealth });
  const finding = report.stuck.find(row => row.cause === 'NEEDS_RESCOPE' && row.item === id);
  assert.equal(finding.why.length, 8192, 'the new finding fits the native health receipt field limit');
  assert.ok(finding.detail.reasons[0].includes(note), 'the full explanation remains available for re-scoping');
});
