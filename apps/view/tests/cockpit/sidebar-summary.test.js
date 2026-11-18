/** The sidebar reads each listed project as a small summary and only the opened project's full state (U94) [N26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { applyStateDelta } from '../../../../packages/api/index.js';
import { expandItemSummaries } from '../../index.js';
import { pageScriptPart3 } from '../../index.js';
import { projectSummary } from '../../index.js';

const LIMIT = 2048;
const STATUSES = ['open', 'claimed', 'submitted', 'verified', 'open'];

/** A large board state: many items with long titles and criteria, and a long event log, newest first. */
function bigState(count = 1600, sequence = 9000) {
  const items = Array.from({ length: count }, (_, n) => ({
    id: n + 1, title: 'Item ' + (n + 1) + ' '.padEnd(120, 'x'), status: STATUSES[n % STATUSES.length], lane: 'view', specs: ['N26'],
    criterion: '1. A clause long enough to weigh something '.repeat(6),
    verdict: n % 10 === 4 ? { decision: 'REJECT', at: '2026-11-12T10:00:00.000Z' } : null,
  }));
  const events = Array.from({ length: 400 }, (_, n) => ({ event_id: sequence - n, event_kind: 'claim', item_id: n + 1, event_by: 'view-1',
    event_at: new Date(Date.parse('2026-11-12T12:00:00.000Z') - n * 60_000).toISOString(), event_detail: '{}' }));
  return { sequence, items, events, agents: [], milestones: [], holds: [] };
}

/** The bytes a summary costs on the wire. */
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

test('view.x-cockpit-sidebar-summary.a-project-summary-carries-counts-needs-you: a project summary carries counts, needs-you and last change in under 2 KB however big the board [N26,C7]', () => {
  const state = bigState();
  const needs = [{ kind: 'decision' }, { kind: 'decision' }, { kind: 'pending' }, { kind: 'draft', count: 184 }, { kind: 'rigor-draft', count: 2 }, { kind: 'hold' }];
  const summary = projectSummary(state, needs);
  assert.deepEqual(summary, {
    version: 1, sequence: 9000, building: 320, awaiting: 320, sentBack: 160, open: 640, verified: 320,
    decisions: 2, pending: 1, drafts: 186, holds: 1, lastChange: { at: '2026-11-12T12:00:00.000Z', eventId: 9000 },
  });
  assert.ok(bytes(state) > 500_000, 'the fixture is a whole board, not a toy');
  assert.ok(bytes(summary) < LIMIT, `summary is ${bytes(summary)} bytes`);
  assert.equal(bytes(projectSummary(bigState(16_000), needs)) <= bytes(summary) + 8, true, 'ten times the items cost no more summary bytes');
  assert.deepEqual(projectSummary({ items: [], events: [] }, []).lastChange, null, 'an empty board has no last change');
});

/** The production board reader as the page runs it, between two markers of the generated script. */
function slice(script, from, to) {
  const start = script.indexOf(from);
  const end = script.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'the generated script contains ' + from.trim());
  return script.slice(start, end);
}

/** Run the page's boardState against explicit API replies, recording every path it asks for. */
function sidebarReader(boards, { summaryServed = true } = {}) {
  const script = pageScriptPart3({ applyStateDelta, deriveMilestoneForecasts: function deriveMilestoneForecasts(state) { return state; }, expandItemSummaries });
  const source = slice(script, '/**\n * An opened board', '/** Format an API-measured')
    + slice(script, '/**\n * What the page last drew', '/** Whether a board state already carries');
  const paths = [];
  const states = new Map(boards.map((board) => [board.id, board.state]));
  const context = {
    snapshot: false, localBoardIds: new Set(boards.map((board) => board.id)), data: null,
    renderSide: () => {}, drawFrame: () => {}, store: { set: (value) => value }, $: () => ({}), listFields: (item) => ({ id: item.id, title: item.title, status: item.status }),
    personNeeds: (state) => state.needs ?? [],
    api: async (path) => {
      paths.push(path);
      if (path === '/api/v1/boards') return { boards: boards.map(({ state, ...board }) => summaryServed ? { ...board, summaryVersion: 1 } : board) };
      const [, id, rest] = /^\/api\/v1\/boards\/([^/]+)\/(.*)$/.exec(path);
      if (rest === 'summary') {
        assert.ok(summaryServed, 'the page asks for a summary only where the listing offers one');
        const state = states.get(id);
        return { version: 1, summary: projectSummary(state, state.needs ?? []) };
      }
      assert.match(rest, /^state(?:\?|$)/u);
      return { state: states.get(id), eventLogVersion: 1 };
    },
  };
  const boardState = runInNewContext(source + '; boardState', context);
  return { paths, read: async (root) => { const page = await boardState(root, null); context.data = { ...page, root }; return page; } };
}

/** Three listed boards: two repos of one project and one on its own. */
function listedBoards() {
  return [
    { id: 'a'.repeat(32), root: '/repo/web', name: 'web', project: 'shop', state: { ...bigState(600, 500), needs: [{ kind: 'decision' }] } },
    { id: 'b'.repeat(32), root: '/repo/api', name: 'api', project: 'shop', state: { ...bigState(400, 300), needs: [] } },
    { id: 'c'.repeat(32), root: '/repo/notes', name: 'notes', state: { ...bigState(1600, 9000), needs: [{ kind: 'draft', count: 184 }] } },
  ];
}

/** The state paths the reader asked for, by board root. */
const stateReads = (paths, boards) => boards.filter((board) => paths.some((path) => path.startsWith('/api/v1/boards/' + board.id + '/state'))).map((board) => board.root);

test('view.x-cockpit-sidebar-summary.the-sidebar-reads-every-unopened-project-from: the sidebar reads every unopened project from its summary and only the opened one in full [N26,C7]', async () => {
  const boards = listedBoards();
  const { paths, read } = sidebarReader(boards);
  const page = await read('/repo/notes');
  assert.deepEqual(stateReads(paths, boards), ['/repo/notes'], 'only the opened project loads its board state');
  assert.deepEqual(paths.filter((path) => path.endsWith('/summary')).sort(), ['/api/v1/boards/' + 'a'.repeat(32) + '/summary', '/api/v1/boards/' + 'b'.repeat(32) + '/summary']);
  assert.equal(page.project.items.length, 1600, 'the opened project has its whole state');
  for (const row of page.projects.filter((entry) => entry.root !== '/repo/notes')) {
    assert.equal(row.ok, true);
    assert.equal(Object.hasOwn(row, 'items') || Object.hasOwn(row, 'events'), false, row.name + ' row holds no items or events');
    assert.ok(bytes(row) < LIMIT, row.name + ' row is ' + bytes(row) + ' bytes');
  }
  const web = page.projects.find((entry) => entry.name === 'web');
  assert.deepEqual([web.decisions, web.building, web.open, web.sentBack, web.lastChange.eventId], [1, 120, 240, 60, 500], 'the summary counts feed the sidebar row');
  const notes = page.projects.find((entry) => entry.name === 'notes');
  assert.deepEqual([notes.drafts, notes.building, notes.lastChange.eventId], [184, 320, 9000], 'the opened row counts alike');

  // Opening another project loads that one in full and reads the one left as a summary.
  paths.length = 0;
  const switched = await read('/repo/web');
  assert.deepEqual(stateReads(paths, boards), ['/repo/web']);
  assert.equal(switched.project.items.length, 600, 'the newly opened project has its whole state');
  assert.equal(Object.hasOwn(switched.projects.find((entry) => entry.name === 'notes'), 'items'), false, 'a project left keeps only its summary');

  // Opening a group loads each of its repos in full, and only those.
  paths.length = 0;
  const group = await read('group:shop');
  assert.deepEqual(stateReads(paths, boards).sort(), ['/repo/api', '/repo/web']);
  assert.deepEqual(Array.from(group.group.repos, (repo) => repo.board.items.length), [600, 400]);
});

test('view.x-cockpit-sidebar-summary.a-board-the-opened-project-s-milestones: a board the opened project\'s milestones name reads its state for the Roadmap; the rest stay summaries [N26,C7]', async () => {
  const boards = listedBoards();
  boards[2].state.milestones = [{ name: 'Launch', items: [{ id: 7 }, { id: 'api#3' }] }];
  const { paths, read } = sidebarReader(boards);
  const page = await read('/repo/notes');
  assert.deepEqual(stateReads(paths, boards).sort(), ['/repo/api', '/repo/notes']);
  assert.equal(page.projects.find((entry) => entry.name === 'api').items.length, 400, 'the named board carries its items');
  assert.equal(Object.hasOwn(page.projects.find((entry) => entry.name === 'web'), 'items'), false);
});

test('view.x-cockpit-sidebar-summary.an-api-that-offers-no-summary-gives: an API that offers no summary gives the state, reduced to the same summary, and is never asked for one [N26,C7]', async () => {
  const boards = listedBoards();
  const { paths, read } = sidebarReader(boards, { summaryServed: false });
  const page = await read('/repo/notes');
  assert.equal(paths.filter((path) => path.endsWith('/summary')).length, 0, 'no summary request an older API would answer with a 404');
  const web = page.projects.find((entry) => entry.name === 'web');
  assert.equal(Object.hasOwn(web, 'items'), false, 'the fallback row keeps only the summary');
  assert.deepEqual([web.decisions, web.building, web.lastChange.eventId], [1, 120, 500]);
  assert.ok(bytes(web) < LIMIT);
});
