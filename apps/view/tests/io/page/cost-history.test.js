/** @pullboard-test-input source-tree */
/** @pullboard-world-pin reads the page script text readCostHistory is served in, and runs it against stand-in page globals. */
/** The Cost tab reads cost-analytics once per window and again only on cost-bearing events, keeping its numbers meanwhile [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageScriptPart3 } from '../../../index.js';

/** Build the served readCostHistory against a stand-in page whose cost-analytics replies the test releases. */
function page() {
  const script = pageScriptPart3({ applyStateDelta() {}, costPrices: {}, costTabScript: () => '', expandItemSummaries() {}, privateCost: true });
  const start = script.indexOf('function readCostHistory'), end = script.indexOf('function costPaneHtml');
  const source = script.slice(start, end);
  const calls = [], waiting = [], drawn = [];
  const view = { root: '/r', tab: 'cost', costWindow: '7d' };
  const api = (path) => { calls.push(path); return new Promise((resolve) => waiting.push(() => resolve({ costAnalytics: { path } }))); };
  const costHistory = new Map();
  const read = new Function('privateCost', 'snapshot', 'hosted', 'readOnly', 'data', 'localCostPrices', 'view', 'costHistory', 'api', 'boardPath', 'render',
    source + '; return readCostHistory;')(true, false, {}, false, {}, {}, view, costHistory, api, (root) => '/b' + root, () => drawn.push(1));
  const settle = async () => { while (waiting.length) waiting.shift()(); for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); };
  return { read, calls, view, settle, drawn };
}
const board = (sequence, ...kinds) => ({ sequence, events: kinds.map((event_kind, index) => ({ event_id: sequence - index, event_kind })) });

test('clause 1: a board event that is not cost-bearing does not start another read [N26]', async () => {
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

test('clause 1: each window is read once and a window already read is not read again [N26]', async () => {
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

test('clause 2: while a new read is on its way the pane keeps the numbers it drew [N26]', async () => {
  const { read, settle } = page();
  read(board(10, 'claim'));
  await settle();
  const second = read(board(11, 'usage', 'claim'));
  assert.equal(second.loading, true);
  assert.ok(second.model, 'the earlier numbers stay while the read is on its way');
  await settle();
  assert.equal(second.loading, false);
});
