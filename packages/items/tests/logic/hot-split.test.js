import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitRecent } from '../../src/logic/hot-split.js';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const HOUR = 3600_000;
const ITEMS = [
  { id: 1, status: 'open', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 2, status: 'claimed', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 3, status: 'withdrawn', updatedAt: '2026-11-16T11:30:00Z' },
  { id: 4, status: 'withdrawn', updatedAt: '2026-11-10T00:00:00Z' },
  { id: 5, status: 'withdrawn', updatedAt: '2026-10-10T00:00:00Z' },
];

test('items.hot-split.keeps-recent: clause 1: splitRecent keeps open and recent items whole and counts older finished ones by status [C7]', () => {
  const { kept, counts } = splitRecent(ITEMS, NOW, 24 * HOUR);
  assert.deepEqual(kept.map(item => item.id), [1, 2, 3]);
  assert.deepEqual(counts, { withdrawn: 2 });
});

test('items.hot-split.counts-add-up: clause 2: the counts plus the kept items equal the full item list size [C7]', () => {
  for (const recentMs of [0, HOUR, 24 * HOUR, 1e12]) {
    const { kept, counts } = splitRecent(ITEMS, NOW, recentMs);
    const counted = Object.values(counts).reduce((sum, n) => sum + n, 0);
    assert.equal(kept.length + counted, ITEMS.length, `recentMs ${recentMs}`);
  }
  assert.deepEqual(splitRecent([], NOW, HOUR), { kept: [], counts: {} });
});
