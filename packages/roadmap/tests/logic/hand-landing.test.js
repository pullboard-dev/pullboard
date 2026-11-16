/** A hand-landed item keeps its milestone and counts as landed there; a never-landed withdrawal still leaves [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roadmap } from '../../index.js';

/** One release holding a verified landing, a hand landing, and a plain withdrawal; ports stand in for the board. */
function card() {
  const row = (item_id, item_status, item_merged_commit = null) => ({ item_id, item_title: `t${item_id}`, item_status, item_merged_commit });
  const items = [row(1, 'verified', 'a'.repeat(40)), row(2, 'withdrawn', 'b'.repeat(40)), row(3, 'withdrawn'), row(4, 'open')];
  const ports = {
    listItems: () => items,
    milestones: () => [{ name: '0.9.5', note: '', items: [1, 2, 3, 4], shipped: null }],
  };
  return roadmap({ clock: { now: () => new Date('2026-11-15T00:00:00Z') } }, null, ports)[0];
}

test('clause 1: an item landed by hand keeps its milestone and counts as landed in the milestone progress [C7]', () => {
  const release = card();
  assert.deepEqual(release.items.filter(entry => entry.state === 'landed').map(entry => entry.id).sort(), [1, 2]);
  assert.equal(release.landed, 2);
  assert.equal(release.done, 2);
  assert.equal(release.total, 3);
});

test('clause 2: a withdrawn item that never landed still leaves its milestone as before [C7]', () => {
  const release = card();
  assert.equal(release.items.some(entry => entry.id === 3), false);
  assert.equal(release.withdrawn, 1);
});
