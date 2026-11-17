/** @pullboard-test-input source-cell api apps/view store roadmap config */
/** With state.milestoneDelta on, a state delta carries only the milestones its events touched, never one whose pace alone moved [C7,#9846,#9597]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addMilestone } from '../../../store/index.js';
import { atomic } from '../../../store/index.js';
import { getItem } from '../../../store/index.js';
import { merged } from '../../../store/index.js';
import { shout } from '../../../store/index.js';
import { verify } from '../../../store/index.js';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { serveApi } from '../../index.js';
import { nativeBoardPorts } from '../../../../apps/lib/index.js';
import { openBoard } from '../../../../apps/lib/index.js';
import { openBoardForRead } from '../../../../apps/lib/index.js';
import { viewApiPorts } from '../../../../apps/view/index.js';
import { refusalDocument } from '../../../../apps/cli/index.js';
import { submitFixture } from '../../../../apps/cli/tests/fixtures/board/submit.js';
import { fetchFresh } from '../../../../apps/cli/tests/fixtures/http.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

const MILESTONES = 50;
const HOUR = 3_600_000;

/**
 * A served board of 2 items in each of 50 milestones, one of them landed an hour ago so the pace moves as the clock does.
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
  const board = cellBoard(t, project.boardFile, () => new Date(at), { real: true });
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
  const head = 'a'.repeat(40);
  at = now - HOUR;
  cellClaim(board, ids[0], agents[0], { root: project.repo, leaseMs: 3 * HOUR });
  submitFixture(board, ids[0], { agentId: agents[0].id, commit: head, tree: 'tree:milestone-delta' });
  verify(board, ids[0], { agentId: agents[1].id, decision: 'ACCEPT', head, digest: getItem(board, ids[0]).item_frozen_digest, policy: 'any', note: 'Delta fixture only; no gate execution is claimed.' });
  merged(board, ids[0], { agentId: 'coordinator', commit: 'b'.repeat(40) });
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
  return { request, path, board, project, ids, agents, tick: ms => { at += ms; now += ms; } };
}

/** The delta a read since `base` answers after `change` runs on the board. */
async function deltaAfter(box, change) {
  const before = await box.request(box.path + '/state');
  assert.equal(before.status, 200);
  assert.equal(before.document.state.milestones.length, MILESTONES);
  change();
  const delta = await box.request(box.path + '/state?since=' + before.document.state.sequence);
  assert.ok(delta.document.delta, 'a later build answers with a delta');
  return delta.document.delta;
}

/** One event on the second item of milestone 7. */
const touchOneItem = box => () => cellClaim(box.board, box.ids[15], box.agents[1], { root: box.project.repo, leaseMs: 3 * HOUR });

test('clause 1: with state.milestoneDelta on, a delta after one event on one item returns that item and only the milestone holding it, not all 50 [C7,#9846]', async (t) => {
  const box = await served(t, true);
  const delta = await deltaAfter(box, () => { box.tick(2 * 60_000); touchOneItem(box)(); });
  assert.deepEqual(delta.merge.items.set.map(item => item.id), [box.ids[15]]);
  assert.deepEqual(delta.merge.milestones.set.map(milestone => milestone.name), ['Delta release 7']);
});

test('clause 2: a pace count change alone does not make a milestone part of the delta [C7,#9846]', async (t) => {
  const box = await served(t, true);
  const delta = await deltaAfter(box, () => { box.tick(3 * HOUR); shout(box.board, { from: box.agents[0].id, to: 'coordinator', text: 'An event that touches no item', lanes: ['web'] }); });
  assert.equal(delta.merge.milestones, undefined, 'a moved pace, and the estimate derived from it, resend no milestone');
  assert.equal(delta.milestonePace.last2h, 0, 'the pace travels once beside the delta');
});

test('clause 3: with the setting off the whole milestone list is sent as today [C7,#9846]', async (t) => {
  const box = await served(t, false);
  const delta = await deltaAfter(box, () => { box.tick(3 * HOUR); shout(box.board, { from: box.agents[0].id, to: 'coordinator', text: 'An event that touches no item', lanes: ['web'] }); });
  assert.equal(delta.merge.milestones.set.length, MILESTONES, 'every milestone is sent again once the pace moved');
});
