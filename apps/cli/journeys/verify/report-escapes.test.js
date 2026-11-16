/** The daily review report lists escaped defects, overturned rejects and a recurring unowned cause [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeReport } from '../../../../packages/stats/index.js';
import { escapeLines } from '../../../../packages/stats/index.js';

const DAY = Date.parse('2026-11-10T00:00:00.000Z');
const MIN = 60_000;
/** Build board event rows at minute offsets into the seeded day. */
const seed = entries => entries.map(([minute, kind, item, detail = {}], index) => ({
  event_id: index + 1, event_at: new Date(DAY + minute * MIN).toISOString(), event_by: 'core-2', event_kind: kind, item_id: item, event_detail: JSON.stringify(detail),
}));
const WINDOW = { from: DAY, until: DAY + 24 * 60 * MIN };

test('clause 1: a seeded overturned reject and an escaped defect appear in the report [C7]', () => {
  const history = seed([
    [1, 'submit', 1, { commit: 'aaa' }], [2, 'reject', 1, { reason: 'TEST_FAILURE' }], [3, 'accept', 1],
    [4, 'submit', 2, { commit: 'bbb' }], [5, 'reject', 2, { reason: 'TEST_FAILURE' }], [6, 'submit', 2, { commit: 'ccc' }], [7, 'accept', 2],
    [8, 'submit', 3, { commit: 'ddd' }], [9, 'accept', 3], [30, 'reopen', 3, { cause: 'lost-edit' }],
    [8, 'submit', 4, { commit: 'eee' }], [9, 'accept', 4], [40, 'main-red', null, { item: 4, cause: 'main-red' }],
  ]);
  const report = escapeReport(history, WINDOW);
  assert.deepEqual(report.overturned.map(o => o.item), [1]);
  assert.deepEqual(report.escaped.map(e => [e.item, e.how]), [[3, 'reopened'], [4, 'main red']]);
  assert.deepEqual(escapeLines(report).slice(0, 3), ['escaped #3: reopened', 'escaped #4: main red', 'overturned reject #1: accepted same commit']);
});

test('clause 2: a cause recurring in the window is listed with its open owner or flagged unowned [C7]', () => {
  const history = seed([
    [1, 'reject', 1, { cause: 'flaky-port' }], [2, 'reject', 2, { cause: 'flaky-port' }],
    [3, 'reject', 3, { cause: 'stale-fixture' }], [4, 'reject', 4, { cause: 'stale-fixture' }], [5, 'reject', 5, { cause: 'stale-fixture' }],
    [6, 'reject', 6, { cause: 'one-off' }],
  ]);
  const { recurring } = escapeReport(history, WINDOW, { owners: { 'flaky-port': 8100 } });
  assert.deepEqual(recurring, [
    { cause: 'stale-fixture', count: 3, items: [3, 4, 5], unowned: true },
    { cause: 'flaky-port', count: 2, items: [1, 2], owner: 8100 },
  ]);
  assert.deepEqual(escapeLines({ escaped: [], overturned: [], recurring }), ['recurring stale-fixture x3: unowned', 'recurring flaky-port x2: owned by #8100']);
});
