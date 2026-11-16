/** The view reads one landed fact, a recorded merge commit, so hand-landed (withdrawn) items count and leave In flight [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landedCounts } from '../../src/logic/counts.js';
import { dashboardModel } from '../../src/io/dashboard/model.js';
import { readMilestoneModel } from '../../src/io/roadmap/render.js';

const now = Date.parse('2026-11-15T18:00:00Z');
const until = new Date(now + 3_600_000).toISOString();
const item = (id, fields) => ({ id, title: 't' + id, lane: 'view', specs: [], status: 'open', ...fields });
const project = () => ({
  items: [
    item(1, { status: 'withdrawn', merged: 'abc123' }),
    item(2, { status: 'withdrawn' }),
    item(3, { status: 'claimed', owner: 'view-1', claim: { by: 'view-1', until }, merged: 'def456' }),
    item(4, { status: 'submitted', reviewer: 'tests-1', merged: 'fed789' }),
    item(5, { status: 'claimed', owner: 'view-2', claim: { by: 'view-2', until } }),
  ],
  milestones: [{ name: '0.9.5: x', items: [1, 2, 3, 4, 5].map(id => ({ id })), summary: { total: 5, left: 3, landed: 2 } }],
});

test('clause 1: a withdrawn item with a merge commit counts as landed in the totals, stage counts and roadmap rows [C7]', () => {
  const state = project();
  assert.equal(landedCounts(state, now).total, 3, 'every item with a merge commit counts, withdrawn or not');
  const model = dashboardModel(state, [], { now, complete: true });
  assert.equal(model.stageCounts.merged, 3, 'the stage strip counts the hand-landed item as merged');
  const rows = [{ label: '#1', state: 'verified', stage: 'merged' }, { label: '#2', state: 'withdrawn', stage: 'withdrawn' }];
  const read = readMilestoneModel(state.milestones[0], rows);
  assert.deepEqual(read.rows.map(row => row.label), ['#1'], 'a landed row stays; a plain withdrawn row drops');
});

test('clause 2: a landed item still marked claimed or submitted is absent from In flight [C7]', () => {
  const model = dashboardModel(project(), [], { now, complete: true });
  assert.deepEqual(model.inFlight.building.map(entry => entry.id), [5]);
  assert.deepEqual(model.inFlight.review.map(entry => entry.id), []);
});
