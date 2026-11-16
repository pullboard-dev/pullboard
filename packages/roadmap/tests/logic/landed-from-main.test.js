/** landing.landedFromMain: with it on the milestone and progress read the commit on main, off they read the recorded merge [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landedOnMain } from '../../index.js';
import { roadmap } from '../../index.js';
import { workProgress } from '../../index.js';

/** Item 5 is on main with no merge record; item 6 recorded a merge that main does not hold. The reader stands in for git. */
function board() {
  const items = [
    { item_id: 5, item_title: 't5', item_status: 'verified', item_commit: 'c'.repeat(40), item_merged_commit: null, item_created_at: '2026-11-15T00:00:00Z' },
    { item_id: 6, item_title: 't6', item_status: 'verified', item_commit: 'd'.repeat(40), item_merged_commit: 'e'.repeat(40), item_created_at: '2026-11-15T00:00:00Z' },
  ];
  const clock = { now: () => new Date('2026-11-15T00:00:00Z') };
  const db = { prepare: sql => ({ all: () => (/FROM item\b/.test(sql) && !/FROM event/.test(sql) ? items : []) }) };
  const ports = { listItems: () => items, milestones: () => [{ name: '0.9.5', note: '', items: [5, 6], shipped: null }] };
  const reads = [];
  const reader = root => { reads.push(root); return commit => commit === 'c'.repeat(40); };
  return { board: { clock, db }, ports, reader, reads };
}

test('clause 1: with landing.landedFromMain on, an item whose commit is on main with no merge record is landed in the milestone and in its progress [C7]', () => {
  const { board: fixture, ports, reader, reads } = board();
  const onMain = landedOnMain('/repo', { landing: { landedFromMain: true } }, { reader });
  assert.deepEqual(reads, ['/repo'], 'the setting reads main once');
  assert.equal(workProgress(fixture, { onMain }).get(5).stage, 'landed');
  const release = roadmap(fixture, null, { ...ports, onMain })[0];
  assert.equal(release.items.find(entry => entry.id === 5).state, 'landed');
  assert.equal(release.landed, 1);
  assert.equal(workProgress(fixture, { onMain }).get(6).stage, 'accepted', 'a recorded merge that main lacks is not landed');
});

test('clause 2: with landing.landedFromMain off, the default, the milestone and progress read the recorded merge as before [C7]', () => {
  const { board: fixture, ports, reader, reads } = board();
  for (const config of [undefined, {}, { landing: {} }, { landing: { landedFromMain: false } }]) {
    const onMain = landedOnMain('/repo', config, { reader });
    assert.equal(onMain, null);
    assert.equal(workProgress(fixture, { onMain }).get(5).stage, 'accepted');
    assert.equal(workProgress(fixture, { onMain }).get(6).stage, 'landed');
    const release = roadmap(fixture, null, { ...ports, onMain })[0];
    assert.deepEqual(release.items.filter(entry => entry.state === 'landed').map(entry => entry.id), [6]);
  }
  assert.deepEqual(reads, [], 'off never reads main');
});
