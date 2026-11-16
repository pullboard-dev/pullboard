/** A fresh board with three landings and one ready item reads the same on every page: landed, ready and runner counts agree (#7763) [C7]. */
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { projectState } from '../../../src/io/serve.js';
import { dashboardModel } from '../../../src/io/dashboard/model.js';
import { dashboardHtml } from '../../../src/logic/render/dashboard.js';
import { roadmapSummary } from '../../../src/logic/summary/roadmap.js';
import { readLiveRunners } from '../../../src/io/live/read.js';
import { publicLiveRunners } from '../../../src/io/live/read.js';
import { firstLandings } from '../../../src/logic/counts.js';
import { readyAndBlocked } from '../../../src/logic/counts.js';
import { splitReady } from '../../../src/logic/counts.js';
import { withReadySplit } from '../../../src/logic/counts.js';
import { claimJob } from '../../../../../packages/api/index.js';
import { offerJob } from '../../../../../packages/api/index.js';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellItem } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../packages/store/tests/fixtures/cell.js';

/** One item with a valid brief, filed through the real store. */
function make(board, title, extra = {}) {
  return cellItem(board, { lane: 'web', title, specIds: ['G1'], criterion: 'The fixture item is valid.', check: 'true',
    brief: 'Files:\n- web/fixture.js\nChange:\n- Keep the fixture valid.\nTest:\n- ' + title + ' passes.', ...extra }).item_id;
}

/** A real board: `landings` items landed by hand at their own commits, one ready item and one blocked on it, in one release. */
function freshBoard(t, landings = 3) {
  const project = cellProject(t);
  const board = cellBoard(t, project.boardFile);
  const landed = ['First', 'Second', 'Third'].slice(0, landings).map(title => make(board, title));
  landed.forEach((id, index) => store.merged(board, id, { agentId: 'coordinator', commit: String(index + 1).repeat(40), forced: 'fixture landing', waiveProof: 'fixture' }));
  const ready = make(board, 'Ready one');
  const blocked = make(board, 'Blocked one', { after: [ready] });
  return { project, board, landed, ready, blocked };
}

test('clause 1: a fresh board with 3 merged items shows 3 landed on the Dashboard flow, its four-hour list, its totals and Pace [C7]', t => {
  const { project, board } = freshBoard(t);
  const state = projectState(project.repo, { board }), now = Date.now();
  assert.deepEqual(state.counts.landed, { total: 3, last4h: 3, last24h: 3 });
  assert.equal(state.dashboardPace.last24h, 3, 'Pace counts the same three');
  assert.equal(state.dashboardRecent.landed, 3, 'the four-hour read counts the same three');
  // The browser's history may hold none of the merges yet: the server's landings carry their time.
  for (const events of [state.events.toReversed(), []]) {
    const dash = dashboardModel(state, events, { now, complete: true, working: [] });
    assert.equal(dash.flow.landed, 3, 'FLOW Land');
    assert.equal(dash.lists.landed.length, 3, 'LANDED 4H');
    assert.equal(dash.totals.recent, 3);
    assert.equal(dash.totals.allTime, 3);
    assert.match(dashboardHtml(dash), /<b>3<\/b> landed/u, 'the Land stage reads 3 landed');
  }
});

test('clause 1: the first recording of each current merge counts once, whatever later events say [C7]', () => {
  const at = minutes => new Date(Date.UTC(2026, 10, 14, 0, minutes)).toISOString();
  const merged = (id, minutes, commit) => ({ item_id: id, event_at: at(minutes), event_detail: JSON.stringify({ commit }) });
  const list = firstLandings(new Map([[1, 'a'], [2, 'b'], [3, 'c']]), [merged(1, 1, 'a'), merged(1, 90, 'a'), merged(2, 2, 'old'), merged(2, 3, 'b'), { item_id: 3, event_at: at(4), event_detail: '{' }]);
  assert.deepEqual(list.map(entry => [entry.id, entry.at]), [[1, Date.parse(at(1))], [2, Date.parse(at(3))]]);
});

test('clause 2: an item NOW calls ready is not called blocked by Release or the Roadmap header [C7]', t => {
  const { project, board, ready, blocked } = freshBoard(t, 0);
  const read = projectState(project.repo, { board }), now = Date.now();
  assert.deepEqual([read.counts.ready, read.counts.blocked], [1, 1]);
  assert.deepEqual(readyAndBlocked(read), { ready: [ready], blocked: [blocked] });
  // The board's state names the release (as the roadmap reads it) after the server's counts; the page splits it on every read.
  const entry = (id, state) => ({ id, title: 'Item ' + id, state });
  const named = { ...read, milestones: [{ name: '0.1: First release', items: [entry(ready, 'waiting'), entry(blocked, 'waiting')],
    summary: { total: 2, landed: 0, landing: 0, review: 0, building: 0, waiting: 2, held: 0, left: 2 } }] };
  const state = withReadySplit(named);
  assert.equal(named.milestones[0].summary.ready, undefined, 'the state the board sent is left as it was');
  // The page and the state read both split a release the API sent as one waiting group, with the same ready definition.
  const sent = { name: '0.1: First release', items: [{ id: ready, state: 'open' }, { id: blocked, state: 'open' }],
    summary: { total: 2, left: 2, landed: 0, landing: 0, review: 0, building: 0, held: 0, waiting: 2 } };
  const release = withReadySplit({ ...state, milestones: [sent] }).milestones[0];
  assert.equal(release.summary.ready, 1, 'the release names the ready item ready');
  assert.equal(release.summary.waiting, 1, 'and only the blocked one blocked');
  const header = roadmapSummary(release, {}).header;
  assert.match(header, /<b>1<\/b> <span>ready<\/span>/u);
  assert.match(header, /<b>1<\/b> <span>blocked<\/span>/u);
  const dash = dashboardModel({ ...state, milestones: [release] }, state.events.toReversed(), { now, complete: true, working: [] });
  assert.deepEqual([dash.stages.ready, dash.stages.waiting], [1, 1], 'NOW agrees');
  const html = dashboardHtml(dash);
  assert.match(html, /<b>1<\/b> ready/u);
  assert.match(html, /<b>1<\/b> blocked/u);
  // A summary the board did not split reads as before.
  assert.equal(roadmapSummary({ ...release, summary: { ...release.summary, ready: undefined } }, {}).header.includes('<span>ready</span>'), false);
  assert.deepEqual(splitReady([{ summary: { waiting: 0 }, items: [] }], [1])[0].summary, { waiting: 0, ready: 0 });
});

test('clause 3: the Runners card lists the local runner that ran the gates, though it holds no lease and no job is live [C7]', t => {
  const { project, board } = freshBoard(t, 0);
  const common = dirname(dirname(project.boardFile));
  const now = Date.now(), offeredAt = now - 10 * 60_000;
  offerJob(board.db, { id: 'gate:1:a', kind: 'gate', needs: [], item: 1, candidate: 'd'.repeat(40), base: 'a'.repeat(40), request: { run: ['node', 'run.js'] }, now: offeredAt });
  const claim = claimJob(board.db, { runner: 'local-7f3a9c', capabilities: [], now: offeredAt + 1000, leaseMs: 60_000 });
  assert.ok(claim, 'the runner claimed the gate job');
  board.db.prepare("UPDATE job SET job_step = 'done', job_lease_until = ? WHERE job_id = 'gate:1:a'").run(offeredAt + 6000);
  const card = publicLiveRunners(common, { resources: join(common, 'none.sqlite'), openBoardReadOnly: store.openBoardReadOnly, now });
  assert.equal(card.runners.length, 1, 'the local runner is listed');
  assert.equal(card.runners[0].busy, false);
  const read = readLiveRunners({ roots: [{ commonDir: common }], now, resources: join(common, 'none.sqlite'), openBoardReadOnly: store.openBoardReadOnly });
  assert.equal(read.runners.length, 1, 'the raw read names it too');
});
