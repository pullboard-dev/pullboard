/** A move table's clean window starts at its later of first compare and last disagreement and is ready after 24 hours [C7]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowReport } from '../../src/logic/moves-window.js';
import { movesReport } from '../../src/io/commands/moves.js';

const NOW = '2026-11-16T12:00:00.000Z';
const ago = hours => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

test('clause 1: windowReport starts at the later of first compare and last disagreement and is ready only at 24 hours [C7]', () => {
  const clean = windowReport({ compared: 5, firstCompareAt: ago(30), lastDisagreedAt: null }, NOW, 24);
  assert.deepEqual([clean.windowStart, clean.windowHours, clean.ready], [ago(30), 30, true]);
  const fixed = windowReport({ compared: 9, firstCompareAt: ago(100), lastDisagreedAt: ago(26) }, NOW, 24);
  assert.equal(fixed.windowStart, ago(26));
  assert.equal(fixed.ready, true);
  assert.equal(windowReport({ compared: 5, firstCompareAt: ago(23.9) }, NOW, 24).ready, false);
  assert.equal(windowReport({ compared: 5, firstCompareAt: ago(24) }, NOW, 24).ready, true);
});

test('clause 2: a table that disagreed 2 hours ago is not ready though first compared 3 days ago, and one with no compares is not ready [C7]', () => {
  const recent = windowReport({ compared: 50, firstCompareAt: ago(72), lastDisagreedAt: ago(2) }, NOW, 24);
  assert.deepEqual([recent.windowStart, recent.windowHours, recent.ready], [ago(2), 2, false]);
  assert.deepEqual(windowReport({ compared: 0, firstCompareAt: null, lastDisagreedAt: null }, NOW, 24), { windowStart: null, windowHours: 0, ready: false });
});

test('clause 3: each moves row carries windowStart, windowHours and ready beside the old keys [C7]', () => {
  const shadows = { claim: { compared: 4, disagreed: 1, since: ago(72), lastDisagreedAt: ago(30), last: [] } };
  const row = movesReport(shadows, ['claim', 'release'], {}, new Date(NOW)).find(entry => entry.table === 'claim');
  for (const key of ['table', 'state', 'liveSwitch', 'compared', 'disagreed', 'firstCompareAt', 'lastDisagreedAt', 'lastDisagreements']) assert.ok(key in row, `old key ${key} stays`);
  assert.deepEqual([row.windowStart, row.windowHours, row.ready], [ago(30), 30, true]);
  const none = movesReport({}, ['release'], {}, new Date(NOW))[0];
  assert.deepEqual([none.windowStart, none.windowHours, none.ready], [null, 0, false]);
});
