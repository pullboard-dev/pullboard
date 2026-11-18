/** An item serving a row of the current release, or waiting on a current-release item, is placed in the current release [C7,#4028]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placementFor } from '../../index.js';

/** The current release holds unlanded C7 work (item 3); a later release holds open web-lane work (item 2). */
function catalog() {
  const items = new Map([
    [2, { item_id: 2, item_lane: 'web', item_status: 'open', item_spec_ids: '' }],
    [3, { item_id: 3, item_lane: 'core', item_status: 'claimed', item_spec_ids: 'C7' }],
  ]);
  const entries = [
    { name: 'Current release', shipped: false, items: [3] },
    { name: 'Later release', shipped: false, items: [2] },
  ];
  return { entries, itemOf: id => items.get(id) ?? null };
}

test('roadmap.logic-placement-current-release.clause-1-an-item-serving-a-row-held-by: clause 1: an item serving a spec row held by the current release is placed there, never in a later one [C7,#4028]', () => {
  const { entries, itemOf } = catalog();
  const placed = placementFor(entries, { lane: 'web', specIds: ['C7'] }, itemOf);
  assert.equal(placed.milestone, 'Current release');
  assert.equal(placed.rule, 'spec rows');
});

test('roadmap.logic-placement-current-release.clause-2-an-item-waiting-on-a-current-release: clause 2: an item waiting on a current-release item is placed in the current release, never in a later one [C7,#4028]', () => {
  const { entries, itemOf } = catalog();
  const placed = placementFor(entries, { lane: 'web', after: [3] }, itemOf);
  assert.equal(placed.milestone, 'Current release', 'the later release holds the web lane, but the wait on item 3 keeps it current');
  assert.equal(placed.rule, 'dependencies');
});

test('roadmap.logic-placement-current-release.clause-2-a-move-replayed-under-an-engine-before: clause 2: a wait on a current-release item replayed under an engine before the live-release rule keeps its recorded placement [C7,#4028]', () => {
  const { entries, itemOf } = catalog();
  const placed = placementFor(entries, { lane: 'web', after: [3] }, itemOf, { liveReleases: false });
  assert.equal(placed.milestone, 'Later release');
});
