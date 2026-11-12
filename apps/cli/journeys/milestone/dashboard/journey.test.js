/** @pullboard-test-gui */
/** @pullboard-view-test journey
 * Real native summary/history boundary: these are wiring observations, never substitutes for pure render coverage [N26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import {
  accept,
  boardId,
  build,
  earlier,
  fetchLive,
  machine,
  project,
  startView,
} from '../../../tests/fixtures/cockpit/harness.js';

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

test('Dashboard API binds native summary leases, merge receipts and complete history [N26]', { timeout: 90_000 }, async () => {
  const box = machine();
  const alpha = project(box, 'dashboard-model', undefined, {
    lanes: { web: { owns: ['web/'], specs: ['G'] }, tests: { owns: [], specs: ['G'] } },
  });
  for (const title of ['Live builder', 'Merged work', 'Reserved review', 'Held open', 'First open', 'Second open']) {
    box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'The fixture item is represented by the actual API.',
      '--check', 'test -d web/', '--brief', 'Files: web/api.html\nTest: the fixture item shows in the API', '--wait');
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
  box.run(alpha.repo, 'milestone', 'add', '0.1.0', '--items', '1,2,3,4,5,6', '--reason', 'Arrange the dashboard fixture');
  box.run(alpha.repo, 'milestone', 'order', '0.1.0', '6,5,4,3,2,1', '--reason', 'Arrange the dashboard fixture');

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
    assert.ok(input.events.length > 80, 'the ordinary history endpoint supplies the complete event prefix');
    assert.ok(input.project.events.length <= 80, 'the state snapshot remains its bounded recent-event view');
    assert.equal(input.project.items.find(item => item.id === 1).owner, undefined, 'the browser receives summary items, not full item details');
    assert.equal(input.project.items.find(item => item.id === 1).claim.by, 'web-1', 'the summary carries the current lease holder');

    assert.equal(input.project.items.find(item => item.id === 3).claim.by, 'tests-1');
    assert.equal(input.project.items.find(item => item.id === 3).builtBy, 'web-1', 'summary items retain the submitting builder');
    assert.equal(input.project.items.find(item => item.id === 3).reviewer, undefined);
    assert.ok(input.project.itemHolds.some(hold => hold.item === 4));
    assert.equal(input.project.dashboardLanded.find(entry => entry.id === 2).commit, mergeCommit);
    assert.ok(input.events.some(event => event.event_kind === 'merged' && event.item_id === 2
      && JSON.parse(event.event_detail).commit === mergeCommit));
    assert.ok(input.project.milestones[0].summary.pace);
    earlier(alpha.repo, Date.now(), board => store.release(board, 3, 'tests-1', 'Finish the fixture review stay.', 'OTHER'));
    const released = await dashboardInput(view, alpha.repo);
    assert.equal(JSON.parse(released.events.findLast(event => event.event_kind === 'release' && event.item_id === 3).event_detail).review, true);
    assert.ok(!released.project.items.find(item => item.id === 3).claim);
    earlier(alpha.repo, Date.now(), board => store.holdLane(board, 'web', { agentId: 'coordinator', reason: 'Pause dashboard fixture lane.' }));
    const held = await dashboardInput(view, alpha.repo);
    assert.ok(held.project.holds.some(hold => hold.hold_lane === 'web'));
  } finally {
    await view.stop();
  }
});
