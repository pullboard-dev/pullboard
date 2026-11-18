/** A hand-landed item keeps its milestone and counts as landed there; a never-landed withdrawal still leaves; landed is one fact, the commit on main [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLanded } from '../../index.js';
import { roadmap } from '../../index.js';
import { workProgress } from '../../index.js';

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

test('roadmap.logic-hand-landing.clause-1-an-item-landed-by-hand-keeps: clause 1: an item landed by hand keeps its milestone and counts as landed in the milestone progress [C7]', () => {
  const release = card();
  assert.deepEqual(release.items.filter(entry => entry.state === 'landed').map(entry => entry.id).sort(), [1, 2]);
  assert.equal(release.landed, 2);
  assert.equal(release.done, 2);
  assert.equal(release.total, 3);
});

test('roadmap.logic-hand-landing.clause-2-a-withdrawn-item-that-never: clause 2: a withdrawn item that never landed still leaves its milestone as before [C7]', () => {
  const release = card();
  assert.equal(release.items.some(entry => entry.id === 3), false);
  assert.equal(release.withdrawn, 1);
});

/** One landed fact [C7]: item 5 is on main with no merge record, item 6 records a merge that is not on main. */
function onMainBoard() {
  const main = new Set(['c'.repeat(40)]);
  const onMain = commit => main.has(commit);
  const items = [
    { item_id: 5, item_title: 't5', item_status: 'withdrawn', item_commit: 'c'.repeat(40), item_merged_commit: null, item_created_at: '2026-11-15T00:00:00Z' },
    { item_id: 6, item_title: 't6', item_status: 'verified', item_commit: 'd'.repeat(40), item_merged_commit: 'e'.repeat(40), item_created_at: '2026-11-15T00:00:00Z' },
  ];
  const clock = { now: () => new Date('2026-11-15T00:00:00Z') };
  const db = { prepare: sql => ({ all: () => (/FROM item\b/.test(sql) && !/FROM event/.test(sql) ? items : []) }) };
  const ports = { listItems: () => items, milestones: () => [{ name: '0.9.5', note: '', items: [5, 6], shipped: null }] };
  return { board: { clock, db }, ports, onMain };
}

test('roadmap.logic-hand-landing.clause-1-an-item-whose-commit-is-on-main: clause 1: an item whose commit is on main is landed in its progress, its milestone entry and the milestone count, with no merge recorded [C7]', () => {
  const { board, ports, onMain } = onMainBoard();
  assert.equal(isLanded({ item_commit: 'c'.repeat(40) }, onMain), true);
  assert.equal(workProgress(board, { onMain }).get(5).stage, 'landed');
  const release = roadmap(board, null, { ...ports, onMain })[0];
  assert.equal(release.items.find(entry => entry.id === 5).state, 'landed');
  assert.equal(release.landed, 1);
});

test('roadmap.logic-hand-landing.clause-2-an-item-whose-recorded-merge: clause 2: an item whose recorded merge commit is not on main is not landed in its progress, milestone entry or count [C7]', () => {
  const { board, ports, onMain } = onMainBoard();
  assert.equal(workProgress(board, { onMain }).get(6).stage, 'accepted');
  const release = roadmap(board, null, { ...ports, onMain })[0];
  assert.equal(release.items.find(entry => entry.id === 6).state, 'accepted');
  assert.deepEqual(release.items.filter(entry => entry.state === 'landed').map(entry => entry.id), [5]);
});

test('roadmap.logic-hand-landing.clause-3-with-no-main-reader-landed: clause 3: with no main reader, landed reads the recorded merge commit as before [C7]', () => {
  const { board, ports } = onMainBoard();
  assert.equal(workProgress(board).get(5).stage, 'withdrawn');
  assert.equal(workProgress(board).get(6).stage, 'landed');
  const release = roadmap(board, null, ports)[0];
  assert.deepEqual(release.items.filter(entry => entry.state === 'landed').map(entry => entry.id), [6]);
});
