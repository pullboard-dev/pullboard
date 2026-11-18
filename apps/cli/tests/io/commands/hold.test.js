/** The show and list line of a held item names its holder and reason [N2,N22,M1]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemLine } from '../../../src/io/read.js';

test('cli.io-commands-hold.a-held-item-prints-who-holds-it: a held item prints who holds it and why on its show and list line [N2,N22,M1]', () => {
  for (const lane of ['web', 'api']) {
    const reason = `waiting for the person in ${lane}`;
    const item = { item_id: 1, item_status: 'open', item_lane: lane, item_title: `Held ${lane} item`, item_route: 'mid',
      item_hold_reason: reason, item_hold_by: 'coordinator', item_hold_at: '2026-10-09T12:00:00.000Z' };
    assert.match(itemLine(item, () => 'coordinator (unknown)'), new RegExp(`held by coordinator \\(unknown\\): ${reason}`));
  }
  assert.doesNotMatch(itemLine({ item_id: 2, item_status: 'open', item_lane: 'web', item_title: 'Free', item_route: 'mid', item_hold_reason: null }), /held by/u);
});
