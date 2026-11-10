/** Landing pace counts the first matching receipt for every landed item [N26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  landingPace,
  qualifyingLandingTimes,
} from '../../index.js';

test('withdrawn items with recorded merges count once alongside verified landings [N26,C7]', () => {
  const now = Date.parse('2026-11-10T18:00:00Z');
  const items = new Map([
    [1, { item_status: 'verified', item_merged_commit: 'verified-merge' }],
    [2, { item_status: 'withdrawn', item_merged_commit: 'withdrawn-merge' }],
    [3, { item_status: 'withdrawn', item_merged_commit: null }],
    [4, { item_status: 'withdrawn', item_merged_commit: 'current-merge' }],
    [5, { item_status: 'open', item_merged_commit: 'open-merge' }],
  ]);
  const event = (item_id, commit, event_at, event_kind = 'merged') =>
    ({ item_id, event_kind, event_at, event_detail: JSON.stringify({ commit }) });
  const history = [
    event(1, 'verified-merge', '2026-11-10T17:00:00Z'),
    event(2, 'withdrawn-merge', '2026-11-10T15:00:00Z'),
    event(2, 'withdrawn-merge', '2026-11-10T17:30:00Z'),
    event(3, 'missing', '2026-11-10T17:00:00Z'),
    event(4, 'old-merge', '2026-11-10T17:00:00Z'),
    event(5, 'open-merge', '2026-11-10T17:00:00Z'),
    event(4, 'current-merge', '2026-11-10T17:00:00Z', 'submit'),
  ];
  assert.deepEqual(qualifyingLandingTimes(history, items), [Date.parse(history[0].event_at), Date.parse(history[1].event_at)]);
  const ports = { eventsOfKinds: (_board, kinds) => { assert.deepEqual(kinds, ['merged']); return history; } };
  assert.deepEqual(landingPace({}, items, now, ports), { last2h: 1, last6h: 2, last24h: 2 });
});
