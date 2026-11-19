/** @pullboard-world-pin reads the page script text readCostHistory is served in, and runs it against stand-in page globals. */
/** The Cost tab reads cost-analytics once per window and again only on cost-bearing events, keeping its numbers meanwhile [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageScriptPart3 } from '../../../index.js';

/** Build the served readCostHistory against a stand-in page whose cost-analytics replies the test releases. */
function page() {
  const script = pageScriptPart3({ applyStateDelta() {}, deriveMilestoneForecasts: function deriveMilestoneForecasts(state) { return state; }, costPrices: {}, costTabScript: () => '', expandItemSummaries() {}, privateCost: true });
  const start = script.indexOf('function readCostHistory'), end = script.indexOf('function costPaneHtml');
  const source = script.slice(start, end);
  const calls = [], waiting = [], drawn = [], logs = [];
  const view = { root: '/r', tab: 'cost', costWindow: '7d' };
  const gap = { events: [] };
  const api = (path) => {
    if (path.includes('/events?')) { logs.push(path); return Promise.resolve({ events: gap.events }); }
    calls.push(path); return new Promise((resolve) => waiting.push(() => resolve({ costAnalytics: { path } })));
  };
  const costHistory = new Map();
  const read = new Function('privateCost', 'snapshot', 'hosted', 'readOnly', 'data', 'localCostPrices', 'view', 'costHistory', 'api', 'boardPath', 'render',
    source + '; return readCostHistory;')(true, false, {}, false, {}, {}, view, costHistory, api, (root) => '/b' + root, () => drawn.push(1));
  const settle = async () => { while (waiting.length) waiting.shift()(); for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); };
  return { read, calls, view, settle, drawn, logs, gap };
}
const board = (sequence, ...kinds) => ({ sequence, events: kinds.map((event_kind, index) => ({ event_id: sequence - index, event_kind })) });

test('view.x-io-page-cost-history.clause-1-a-board-event-that-is: clause 1: a board event that is not cost-bearing does not start another read [N26]', async () => {
  const { read, calls, settle } = page();
  read(board(10, 'claim'));
  await settle();
  read(board(11, 'claim', 'claim'));
  read(board(12, 'submit', 'claim'));
  assert.equal(calls.length, 1);
  read(board(13, 'usage', 'submit'));
  assert.equal(calls.length, 2, 'a usage event reads again');
  await settle();
  read(board(14, 'claim', 'usage'));
  assert.equal(calls.length, 2, 'the usage event already read is not read again');
  read(board(15, 'merged', 'claim'));
  assert.equal(calls.length, 3, 'a merged event reads again');
  await settle();
  read(board(16, 'shared-usage', 'merged'));
  assert.equal(calls.length, 4, 'a shared-usage event reads again');
});

test('view.x-io-page-cost-history.clause-1-each-window-is-read-once: clause 1: each window is read once and a window already read is not read again [N26]', async () => {
  const { read, calls, view, settle } = page();
  read(board(10, 'claim'));
  await settle();
  view.costWindow = '30d';
  read(board(10, 'claim'));
  await settle();
  view.costWindow = '7d';
  read(board(11, 'claim'));
  assert.equal(calls.length, 2);
  assert.match(calls[1], /window=30d/u);
});

test('view.x-io-page-cost-history.clause-2-while-a-new-read-is: clause 2: while a new read is on its way the pane keeps the numbers it drew [N26]', async () => {
  const { read, settle } = page();
  read(board(10, 'claim'));
  await settle();
  const second = read(board(11, 'usage', 'claim'));
  assert.equal(second.loading, true);
  assert.ok(second.model, 'the earlier numbers stay while the read is on its way');
  await settle();
  assert.equal(second.loading, false);
});

const quiet = async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); };

test('view.x-io-page-cost-history.clause-1-a-gap-of-ids-with: clause 1: a gap of ids with no cost-bearing event visible or in the gap does not read cost-analytics again [N26]', async () => {
  const { read, calls, settle, logs, gap } = page();
  read(board(10, 'claim'));
  await settle();
  gap.events = Array.from({ length: 28 }, (_, index) => ({ event_id: 11 + index, event_kind: 'claim' }));
  read({ sequence: 40, events: [{ event_id: 40, event_kind: 'claim' }, { event_id: 39, event_kind: 'submit' }] });
  await quiet();
  assert.equal(calls.length, 1, 'only the event log was asked about the gap');
  assert.equal(logs.length, 1);
  read({ sequence: 41, events: [{ event_id: 41, event_kind: 'claim' }, { event_id: 40, event_kind: 'claim' }, { event_id: 39, event_kind: 'submit' }] });
  await quiet();
  assert.equal(calls.length, 1, 'once the gap is read, contiguous non-cost events do not read again');
  assert.equal(logs.length, 1);
});

test('view.x-io-page-cost-history.clause-1-a-gap-that-holds-a: clause 1: a gap that holds a usage event reads cost-analytics again [N26]', async () => {
  const { read, calls, settle, gap, drawn } = page();
  read(board(10, 'claim'));
  await settle();
  gap.events = [{ event_id: 20, event_kind: 'usage' }];
  read({ sequence: 40, events: [{ event_id: 40, event_kind: 'claim' }, { event_id: 39, event_kind: 'submit' }] });
  await quiet();
  assert.equal(calls.length, 1);
  assert.ok(drawn.length >= 1, 'the pane draws again to start the read');
  read({ sequence: 40, events: [{ event_id: 40, event_kind: 'claim' }, { event_id: 39, event_kind: 'submit' }] });
  assert.equal(calls.length, 2, 'the usage event in the gap reads again');
});
