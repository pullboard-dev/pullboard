/** @pullboard-test-gui */
/** Dashboard model checks use real local API state and board events, not hand-built receipt rows [N26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../src/board.js';
import { dashboardModel } from '../../src/view/dashboard-model.js';
import { accept, boardId, build, earlier, fetchLive, machine, project, startView } from './fixture.js';

/** Read the exact summary shape used by the browser and its ordered event history from the same project API. */
async function dashboardInput(view, root) {
  const id = await boardId(view, root), headers = { 'x-pullboard-key': view.key };
  const base = `${view.base}/api/v1/boards/${id}`;
  const [stateResponse, eventsResponse] = await Promise.all([
    fetchLive(`${base}/state`, { headers }),
    fetchLive(`${base}/events?after=0`, { headers }),
  ]);
  assert.equal(stateResponse.status, 200);
  assert.equal(eventsResponse.status, 200);
  const [{ state }, { events }] = await Promise.all([stateResponse.json(), eventsResponse.json()]);
  return { project: { ...state, root }, events };
}

test('Dashboard uses summary leases, native history and the board queue [N26]', { timeout: 90_000 }, async () => {
  const box = machine();
  const alpha = project(box, 'dashboard-model', undefined, {
    lanes: { web: { owns: ['web/'], specs: ['G'] }, tests: { owns: [], specs: ['G'] } },
  });
  for (const title of ['Live builder', 'Merged work', 'Reserved review', 'Held open', 'First open', 'Second open']) {
    box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'The fixture item is represented by the actual API.',
      '--check', 'test -f pullboard.json', '--wait');
  }
  build(box, alpha, 2, 'dashboard-merged.txt');
  build(box, alpha, 3, 'dashboard-review.txt');
  accept(box, alpha, 2);
  const mergeBranch = alpha.itemBranches.get(`${alpha.baseBranch}:2`);
  box.git(alpha.repo, 'merge', '--no-ff', '-m', 'chore: merge dashboard fixture', mergeBranch);
  const mergeCommit = box.git(alpha.repo, 'rev-parse', 'HEAD');
  box.run(alpha.repo, 'merged', '2', mergeCommit);
  box.run(alpha.web, 'claim', '1');
  box.run(alpha.web, 'claim', '1'); // A native renewal extends the same builder stay.

  const reviewerPath = join(box.dir, 'dashboard-reviewer');
  box.git(alpha.repo, 'worktree', 'add', '-q', '-b', 'tests/dashboard-model', reviewerPath, 'main');
  box.run(reviewerPath, 'join', 'tests', '--model', 'Dashboard model reviewer');
  earlier(alpha.repo, Date.now(), board => store.reserveReview(board, 3, {
    agentId: 'tests-1', leaseMs: 60 * 60_000, policy: 'any',
  }));
  earlier(alpha.repo, Date.now(), board => store.holdItem(board, 4, { agentId: 'coordinator', reason: 'Keep this item paused.' }));
  box.run(alpha.repo, 'milestone', 'add', '0.1.0', '--items', '1,2,3,4,5,6');
  box.run(alpha.repo, 'milestone', 'order', '0.1.0', '6,5,4,3,2,1');

  // More than the API's recent-event window, plus actual out-of-window and future-dated fixture events.
  earlier(alpha.repo, Date.now() - 5 * 60 * 60_000, board => store.shout(board, {
    from: 'coordinator', to: 'person', text: 'Old dashboard fixture shout.', lanes: ['web'],
  }));
  earlier(alpha.repo, Date.now(), board => {
    for (let index = 0; index < 85; index += 1) store.shout(board, {
      from: 'coordinator', to: 'person', text: `Dashboard fixture shout ${index}.`, lanes: ['web'],
    });
  });
  earlier(alpha.repo, Date.now() + 5 * 60 * 60_000, board => store.shout(board, {
    from: 'coordinator', to: 'person', text: 'Future dashboard fixture shout.', lanes: ['web'],
  }));

  const view = await startView(box);
  try {
    const input = await dashboardInput(view, alpha.repo);
    const now = Date.now() + 1_000;
    assert.ok(input.events.length > 80, 'the ordinary history endpoint supplies the complete event prefix');
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
    assert.ok(mergeEvent, 'the board records the actual merge event');
    assert.equal(model.landed.filter(entry => entry.item.id === 2).length, 1, 'one matching current merge is counted once');
    const duplicateDelivery = dashboardModel(input.project, [...input.events, mergeEvent], { now, complete: true });
    assert.equal(duplicateDelivery.landed.filter(entry => entry.item.id === 2).length, 1, 'redelivery of the same native event cannot double count a landing');
    assert.deepEqual(model.pace, input.project.milestones[0].summary.pace, 'the shared Roadmap pace passes through unchanged');
    assert.equal(model.totals.shouts, 85, 'counts include the complete prefix and exclude the real old and future events');

    const partial = dashboardModel(input.project, input.events.slice(-4), { now, complete: false });
    assert.equal(partial.totals.recent, null);
    assert.equal(partial.totals.passed, null);
    assert.equal(partial.totals.sentBack, null);
    assert.equal(partial.totals.shouts, null);
    assert.deepEqual(partial.pace, model.pace, 'an incomplete history does not overwrite known API pace');

    earlier(alpha.repo, Date.now(), board => store.release(board, 3, 'tests-1', 'Finish the fixture review stay.'));
    const afterRelease = await dashboardInput(view, alpha.repo);
    const release = afterRelease.events.findLast(event => event.event_kind === 'release' && event.item_id === 3);
    assert.equal(JSON.parse(release.event_detail).review, true, 'the real release event marks this as a review release');
    const closed = dashboardModel(afterRelease.project, afterRelease.events, { now: Date.now() + 1_000, complete: true });
    const reviewer = closed.agents.find(agent => agent.id === 'tests-1');
    assert.ok(reviewer.review > 0, 'the review stay is retained in the agent timeline');
    assert.ok(!reviewer.current.some(entry => entry.item.id === 3), 'the released reviewer is no longer shown as holding work');

    earlier(alpha.repo, Date.now(), board => store.holdLane(board, 'web', { agentId: 'coordinator', reason: 'Pause dashboard fixture lane.' }));
    const heldLane = await dashboardInput(view, alpha.repo);
    assert.deepEqual(dashboardModel(heldLane.project, heldLane.events, { now: Date.now() + 1_000 }).next, [], 'a lane hold removes its open items from ready work');
  } finally {
    await view.stop();
  }
});
