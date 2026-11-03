/** A new item is never placed in an unshipped milestone whose items have all landed [C7,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placementFor } from '../packages/roadmap/index.js';

/** An earlier release never recorded shipped whose one C7 item landed (verified), and a later release with open work. */
function catalog({ pending = false } = {}) {
  const items = new Map([
    [1, { item_id: 1, item_lane: 'core', item_status: 'verified', item_spec_ids: 'C7' }],
    [2, { item_id: 2, item_lane: 'core', item_status: 'open', item_spec_ids: '' }],
    [3, { item_id: 3, item_lane: 'core', item_status: 'claimed', item_spec_ids: 'C7' }],
  ]);
  const entries = [
    { name: 'Old release', shipped: false, items: pending ? [1, 3] : [1] },
    { name: 'Open release', shipped: false, items: [2] },
  ];
  return { entries, itemOf: id => items.get(id) ?? null };
}

test('a new C7 item skips an earlier unshipped release whose items all landed and goes to the later open one [C7,N26]', () => {
  const { entries, itemOf } = catalog();
  const placed = placementFor(entries, { lane: 'core', specIds: ['C7'] }, itemOf);
  assert.equal(placed.milestone, 'Open release');
  assert.equal(placed.inputs.specs.milestone, null, 'the landed release no longer answers the spec-rows rule');
  const lane = placementFor(entries, { lane: 'core' }, itemOf);
  assert.equal(lane.milestone, 'Open release', 'the lane rule skips the landed release too');
});

test('an earlier release that still holds unlanded C7 work keeps taking new C7 items [C7,N26]', () => {
  const { entries, itemOf } = catalog({ pending: true });
  const placed = placementFor(entries, { lane: 'core', specIds: ['C7'] }, itemOf);
  assert.equal(placed.milestone, 'Old release');
  assert.equal(placed.rule, 'spec rows');
});

test('a move replayed under an engine before the live-release rule keeps its recorded placement [C7,N26]', () => {
  const { entries, itemOf } = catalog();
  const placed = placementFor(entries, { lane: 'core', specIds: ['C7'] }, itemOf, { liveReleases: false });
  assert.equal(placed.milestone, 'Old release');
});
