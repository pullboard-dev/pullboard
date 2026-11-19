/** With state.milestoneDelta on, a state delta carries only the milestones its events touched, never one whose pace alone moved [C7,#9846,#9597]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addMilestone } from '../../../../packages/store/index.js';
import { atomic } from '../../../../packages/store/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { merged } from '../../../../packages/store/index.js';
import { shout } from '../../../../packages/store/index.js';
import { verify } from '../../../../packages/store/index.js';
import { cellBoard } from '../../../../packages/board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellItem } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellProject } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../packages/store/tests/fixtures/cell.js';
import { serveApi } from '../../../../packages/api/index.js';
import { nativeBoardPorts } from '../../../lib/index.js';
import { openBoard } from '../../../lib/index.js';
import { openBoardForRead } from '../../../lib/index.js';
import { viewApiPorts } from '../../../view/index.js';
import { refusalDocument } from '../../index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { fetchFresh } from '../../tests/fixtures/http.js';
import { fixtureMachineSettings } from '../../../../packages/gate/tests/fixtures/testkit.js';

const MILESTONES = 50;
const HOUR = 3_600_000;

/**
 * A served board of 2 items in each of 50 milestones, three of them landed an hour ago so the pace and its derived estimate move as the clock does.
 * The machine settings hold `state.milestoneDelta` as given.
 */
async function served(t, milestoneDelta) {
  const project = cellProject(t, { real: true });
  const home = join(project.dir, 'machine-home');
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, { state: { milestoneDelta } });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  let now = Date.now() + 8 * HOUR;
  let at = now - 8 * HOUR;
  const board = cellBoard(t, project.boardFile, { now: () => new Date(at) }, { real: true });
  const ids = [];
  const agents = [0, 1].map(index => cellSeat(board, { lane: 'web', path: join(project.dir, `seat-${index}`) }));
  atomic(board, () => {
    for (let index = 0; index < MILESTONES * 2; index += 1) {
      ids.push(cellItem(board, { lane: 'web', title: `Delta item ${index}`, criterion: 'The specified behavior is observable.',
        check: 'true', brief: 'Files: web/page.js\nTest: the specified behavior is observable.', specIds: ['G1'] }).item_id);
    }
    for (let group = 0; group < MILESTONES; group += 1) {
      addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: `Delta release ${group}`, note: 'Delta fixture only', items: ids.slice(group * 2, group * 2 + 2) });
    }
  });
  at = now;
  // Three landings inside the six-hour window, so every open milestone carries a pace-derived estimate [N26].
  for (const [order, index] of [0, 2, 4].entries()) {
    const head = String(order + 1).repeat(40);
    cellClaim(board, ids[index], agents[0], { root: project.repo, leaseMs: 3 * HOUR });
    submitFixture(board, ids[index], { agentId: agents[0].id, commit: head, tree: `tree:milestone-delta-${order}` });
    verify(board, ids[index], { agentId: agents[1].id, decision: 'ACCEPT', head, digest: getItem(board, ids[index]).item_frozen_digest, policy: 'any', note: 'Delta fixture only; no gate execution is claimed.' });
    merged(board, ids[index], { agentId: 'coordinator', commit: String(order + 4).repeat(40) });
  }
  at = now;
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: { openBoard, openBoardForRead, nativeBoardPorts, moveArgs: (body) => [body.verb] }, refusalDocument, runCommand: async () => 0,
    projects: () => [{ root: project.repo, name: 'Milestone delta fixture' }], now: () => now });
  t.after(() => api.close());
  const url = new URL(api.url);
  const headers = { 'x-pullboard-key': url.searchParams.get('k') };
  /** One authenticated read of the real HTTP surface. */
  async function request(path) {
    const response = await fetchFresh(url.origin + path, { headers });
    return { status: response.status, document: JSON.parse(await response.text()) };
  }
  const listing = await request('/api/v1/boards');
  const path = '/api/v1/boards/' + encodeURIComponent(listing.document.boards[0].id);
  return { request, path, board, project, ids, agents, tick: ms => { at += ms; }, advance: ms => { at += ms; now += ms; } };
}

/** The delta a read since `base` answers after `change` runs on the board. */
async function deltaAfter(box, change) {
  const before = await box.request(box.path + '/state');
  assert.equal(before.status, 200);
  assert.equal(before.document.state.milestones.length, MILESTONES);
  assert.equal(before.document.state.milestones[0].summary.pace.last2h, 3, 'the landings are inside the two-hour window');
  change();
  const delta = await box.request(box.path + '/state?since=' + before.document.state.sequence);
  assert.ok(delta.document.delta, 'a later build answers with a delta');
  return delta.document.delta;
}

/** One event on the second item of milestone 7. */
const touchOneItem = box => () => cellClaim(box.board, box.ids[15], box.agents[1], { root: box.project.repo, leaseMs: 3 * HOUR });

test('cli.journeys-status-state-milestone-delta.with-state-milestonedelta-on-a-delta: clause 1: with state.milestoneDelta on, a delta after one event on one item returns that item and only the milestone holding it, not all 50 [C7,#9846]', async (t) => {
  const box = await served(t, true);
  const delta = await deltaAfter(box, () => { box.tick(2 * 60_000); touchOneItem(box)(); });
  assert.deepEqual(delta.merge.items.set.map(item => item.id), [box.ids[15]]);
  assert.deepEqual(delta.merge.milestones.set.map(milestone => milestone.name), ['Delta release 7']);
});

test('cli.journeys-status-state-milestone-delta.with-state-milestonedelta-on-an-event: clause 2: with state.milestoneDelta on, an event that moves only a milestone pace-derived estimate, window or reason leaves that milestone out of the delta [C7,#9846]', async (t) => {
  const box = await served(t, true);
  const delta = await deltaAfter(box, () => { box.advance(3 * HOUR); shout(box.board, { from: box.agents[0].id, to: 'all', text: 'An event that touches no item', lanes: ['web'] }); });
  assert.equal(delta.merge.milestones, undefined, 'a moved pace, and the estimate derived from it, resend no milestone');
  assert.equal(delta.milestonePace.last2h, 0, 'the pace travels once beside the delta');
});

test('cli.journeys-status-state-milestone-delta.with-the-setting-off-that-same: clause 3: with the setting off, that same event puts the milestone row in the delta as today [C7,#9846]', async (t) => {
  const box = await served(t, false);
  const delta = await deltaAfter(box, () => { box.advance(3 * HOUR); shout(box.board, { from: box.agents[0].id, to: 'all', text: 'An event that touches no item', lanes: ['web'] }); });
  assert.equal(delta.merge.milestones.set.length, MILESTONES, 'every milestone is sent again once the pace moved');
});
