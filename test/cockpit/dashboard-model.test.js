/** Pure Dashboard model behavior on seeded summary/history input; no board, Git, HTTP or browser [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardModel } from '../../src/view/dashboard-model.js';
import { dashboardData, releasedDashboardData } from './view-data.js';

test('Dashboard uses summary leases, history and queue input without I/O [N26]', () => {
  const input = dashboardData();
  const { now, mergeCommit } = input;
    assert.ok(input.events.length > 80, 'the seeded full prefix exceeds the recent state window');
    assert.ok(input.project.events.length <= 80, 'the state snapshot remains its bounded recent-event view');
    assert.equal(input.project.items.find(item => item.id === 1).owner, undefined, 'the browser receives summary items, not full item details');
    assert.equal(input.project.items.find(item => item.id === 1).claim.by, 'web-1', 'the summary carries the current lease holder');

    const model = dashboardModel(input.project, input.events, { now, complete: true });
    assert.deepEqual(model.claims.map(item => item.id), [1], 'the live builder is resolved from claim.by in the summary');
    assert.ok(model.agents.find(agent => agent.id === 'web-1').current.some(entry => entry.item.id === 1), 'the builder row uses that same live claim');
    const reviewItem = input.project.items.find(item => item.id === 3);
    assert.equal(reviewItem.reviewer, undefined, 'reviewer identity is also summary-only');
    assert.equal(reviewItem.claim.by, 'tests-1');
    assert.ok(model.agents.find(agent => agent.id === 'tests-1').current.some(entry => entry.item.id === 3), 'a live review lease identifies its reviewer through claim.by');

    const expiredReview = dashboardModel(input.project, input.events, {
      now: Date.parse(reviewItem.claim.until) + 1, complete: true,
    });
    assert.ok(!expiredReview.agents.find(agent => agent.id === 'tests-1').current.some(entry => entry.item.id === 3), 'an expired reserve stops counting as active review');
    assert.ok(expiredReview.claims.some(item => item.id === 1), 'the unrelated builder lease remains live at that clock');

    const candidates = new Set([4, 5, 6]);
    const orderedCandidates = input.project.dashboardNext
      .filter(id => candidates.has(id) && !input.project.itemHolds.some(hold => hold.item === id));
    assert.deepEqual(model.next.map(item => item.id), orderedCandidates, 'ready work follows the API roadmap order and skips item-held work');
    assert.ok(!model.next.some(item => item.id === 4), 'an item hold is not presented as ready');

    const mergedRecord = input.project.dashboardLanded.find(entry => entry.id === 2);
    assert.equal(mergedRecord.commit, mergeCommit, 'the dashboard merge record is bound to the current merged commit');
    const mergeEvent = input.events.find(event => event.event_kind === 'merged' && event.item_id === 2);
    assert.ok(mergeEvent, 'the input includes its matching merge event');
    assert.equal(model.landed.filter(entry => entry.item.id === 2).length, 1, 'one matching current merge is counted once');
    const duplicateDelivery = dashboardModel(input.project, [...input.events, mergeEvent], { now, complete: true });
    assert.equal(duplicateDelivery.landed.filter(entry => entry.item.id === 2).length, 1, 'redelivery of the same native event cannot double count a landing');
    assert.deepEqual(model.pace, input.project.milestones[0].summary.pace, 'the shared Roadmap pace passes through unchanged');
    assert.equal(model.totals.shouts, 85, 'counts include the complete prefix and exclude the old and future input events');

    const partial = dashboardModel(input.project, input.events.slice(-4), { now, complete: false });
    assert.equal(partial.totals.recent, null);
    assert.equal(partial.totals.passed, null);
    assert.equal(partial.totals.sentBack, null);
    assert.equal(partial.totals.shouts, null);
    assert.deepEqual(partial.pace, model.pace, 'an incomplete history does not overwrite known API pace');

    const afterRelease = releasedDashboardData(input);
    const release = afterRelease.events.findLast(event => event.event_kind === 'release' && event.item_id === 3);
    assert.equal(JSON.parse(release.event_detail).review, true, 'the release-shaped input is explicitly a review release');
    const closed = dashboardModel(afterRelease.project, afterRelease.events, { now: afterRelease.now, complete: true });
    const reviewer = closed.agents.find(agent => agent.id === 'tests-1');
    assert.ok(reviewer.review > 0, 'the review stay is retained in the agent timeline');
    assert.ok(!reviewer.current.some(entry => entry.item.id === 3), 'the released reviewer is no longer shown as holding work');

    const heldLane = structuredClone(input);
    heldLane.project.holds.push({ hold_lane: 'web' });
    assert.deepEqual(dashboardModel(heldLane.project, heldLane.events, { now: afterRelease.now }).next, [], 'a lane hold removes its open items from ready work');
});
