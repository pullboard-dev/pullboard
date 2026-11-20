/** Pure Dashboard model behavior on seeded summary/history input; no board, Git, HTTP or browser [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardModel } from '../../../src/io/dashboard/model.js';
import { dashboardData } from '../../fixtures/cockpit/data.js';
import { releasedDashboardData } from '../../fixtures/cockpit/data.js';

test('view.x-io-dashboard-model.dashboard-uses-summary-leases-history-and-queue: Dashboard uses summary leases, history and queue input without I/O [N26]', () => {
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


test('view.x-io-dashboard-model.dashboard-counts-matching-merged-records-regardless-of: Dashboard counts matching merged records regardless of status [N26]', () => {
  const input = dashboardData();
  const commit = 'a'.repeat(40);
  const events = [...input.events];
  const add = (id, value) => events.push({ event_id: events.length + 1, event_kind: 'merged', item_id: id,
    event_by: 'coordinator', event_at: new Date(input.now - 1000).toISOString(), event_detail: JSON.stringify(value) });
  input.project.items.find(item => item.id === 3).status = 'withdrawn'; // no merge record or event
  input.project.items.find(item => item.id === 4).status = 'withdrawn';
  input.project.items.find(item => item.id === 5).status = 'claimed';
  input.project.dashboardLanded.push({ id: 4, commit }, { id: 5, commit }, { id: 6, commit });
  add(4, { commit }); add(4, { commit }); add(5, { commit });
  add(6, { commit: 'b'.repeat(40) });
  add(1, { commit }); // event alone cannot establish a landing
  input.project.sequence = events.length;
  const model = dashboardModel(input.project, events, { now: input.now });
  assert.deepEqual(model.landed.map(entry => entry.item.id).sort(), [2, 4, 5]);
  assert.equal(model.totals.recent, 3);
  assert.equal(model.bins.reduce((sum, bin) => sum + bin.count, 0), 3);
});

test('view.x-io-dashboard-model.dashboard-after-a-run-of-live-updates: Dashboard after a run of live updates matches a full recompute over the same events [N26]', () => {
  const input = dashboardData();
  const events = input.events.filter(event => Date.parse(event.event_at) <= input.now).sort((a, b) => a.event_id - b.event_id);
  assert.ok(events.length > 80, 'the run folds many events');
  const shown = model => ({ ...model, last: undefined });
  const fold = {};
  let held = 0;
  // Each update adds a few events and moves the clock on; the totals kept from the last update must give what a fresh read of every event gives.
  for (let step = 1, now = input.now; held < events.length; step++, now += 90_000) {
    held = Math.min(events.length, held + 1 + (step * 7) % 23);
    const history = events.slice(0, held);
    const project = { ...input.project, sequence: history.at(-1).event_id };
    const live = dashboardModel(project, history, { now, complete: true, fold });
    assert.deepEqual(shown(live), shown(dashboardModel(project, history, { now, complete: true })), 'update ' + step + ' at ' + held + ' events matches a full recompute');
    assert.equal(fold.state.upto, history.at(-1).event_id, 'only the events up to the prefix were folded');
  }
  // A later clock with the same events, a board that is rewound, and an event dated after the clock all still match a full recompute.
  const project = { ...input.project, sequence: events.at(-1).event_id };
  const later = dashboardModel(project, events, { now: input.now + 600_000, complete: true, fold });
  assert.deepEqual(shown(later), shown(dashboardModel(project, events, { now: input.now + 600_000, complete: true })));
  const rewound = dashboardModel(project, events, { now: input.now, complete: true, fold });
  assert.deepEqual(shown(rewound), shown(dashboardModel(project, events, { now: input.now, complete: true })), 'a clock that moves back refolds from the start');
  const future = [...events, { ...events.at(-1), event_id: events.at(-1).event_id + 1, event_at: new Date(input.now + 3_600_000).toISOString() }];
  const ahead = { ...project, sequence: future.at(-1).event_id };
  assert.deepEqual(shown(dashboardModel(ahead, future, { now: input.now, complete: true, fold })), shown(dashboardModel(ahead, future, { now: input.now, complete: true })), 'an event dated after the clock is left out, as a full recompute leaves it out');
  assert.equal(fold.state, null, 'nothing is kept past an event the clock has not reached');
});

test('view.x-io-dashboard-model.dashboard-counts-every-landed-item-from-its: Dashboard counts every landed item from its own row and matches commits only for the last day\'s landings [N26]', () => {
  const input = dashboardData();
  const { now } = input;
  const items = input.project.items.map(item => item.id === 2 ? { ...item, stage: 'merged' } : item);
  const old = { id: 99, title: 'Landed long ago', status: 'verified', stage: 'merged', lane: 'web', specs: [], blockedBy: [] };
  const project = { ...input.project, items: [...items, old], dashboardLanded: input.project.dashboardLanded.filter(entry => entry.id === 2) };
  const model = dashboardModel(project, input.events, { now, complete: true });
  assert.equal(model.totals.allTime, 2, 'the landed count includes the old landing that dashboardLanded no longer lists');
  assert.ok(!model.landing.some(item => item.id === 99), 'the old landing is not waiting to land');
  assert.equal(model.landed.filter(entry => entry.item.id === 2).length, 1, 'the recent landing still matches its merge event');
});

test('view.x-io-dashboard-model.dashboard-counts-passed-review-and-reviewing-time: Dashboard counts passed review and reviewing time from the review events the board records, beside hand landings [N26]', () => {
  const now = Date.parse('2026-11-13T16:00:00Z'), minute = 60_000;
  let id = 0;
  const event = (ago, by, kind, item, detail = {}) => ({ event_id: ++id, event_at: new Date(now - ago * minute).toISOString(), event_by: by, event_kind: kind, item_id: item, event_detail: JSON.stringify(detail) });
  const commit = item => String(item).repeat(40).slice(0, 40);
  const landed = [11, 12, 13];
  const history = [
    event(200, 'rev-1', 'join', null, { lane: 'review' }),
    // Three hand landings: forced merges with no accept on the board, and one of them also has a reviewer's accept.
    ...landed.map(item => event(100 - item, 'coordinator', 'merged', item, { commit: commit(item), forced: true })),
    event(110, 'rev-1', 'accept', 11, { commit: commit(11) }),
    // A review that ends without a verdict still took the reviewer's time: 30 minutes.
    event(150, 'rev-1', 'reserve', 14, { until: new Date(now - 100 * minute).toISOString() }),
    event(120, 'rev-1', 'release', 14, { review: true }),
    // Both submitted items passed the gate and no reviewer holds either.
    ...[14, 15].flatMap(item => [event(170, 'view-1', 'submit', item, { commit: commit(item) }), event(165, 'board', 'gate-run', item, { run: { green: true } })]),
  ];
  const items = [...landed.map(item => ({ id: item, lane: 'view', status: 'verified', merged: true })),
    { id: 14, lane: 'view', status: 'submitted' }, { id: 15, lane: 'view', status: 'submitted' }];
  const project = { items, agents: [{ agent_id: 'rev-1' }], dashboardLanded: landed.map(item => ({ id: item, commit: commit(item) })) };
  const model = dashboardModel(project, history, { now, complete: true });
  assert.equal(model.totals.recent, 3, 'the three hand landings are counted');
  assert.equal(model.totals.passed, 3, 'an accepted-and-landed item counts once and the unreviewed landings count as passed, never 0 beside 3 landed');
  assert.equal(model.flow.accepted, 3, 'the flow strip reads the same passed count');
  const reviewer = model.agents.find(agent => agent.id === 'rev-1');
  assert.equal(reviewer.review, 30 * minute, 'the recorded reserve and its release count as reviewing time');
  assert.equal(model.flow.waitingReview, 2, 'submitted items nobody reserved wait for a reviewer');
  const partial = dashboardModel({ ...project, dashboardRecent: { landed: 3, passed: 3, sentBack: 0, shouts: 0 } }, [], { now, complete: false });
  assert.equal(partial.totals.passed, 3, 'the server-read count is passed through unchanged');
});
