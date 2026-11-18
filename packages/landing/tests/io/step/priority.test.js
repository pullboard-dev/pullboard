/** Landing selection can take accepted items in the order next uses: urgent, milestone position, then accept age [C7,#3157]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../gate/tests/fixtures/child.js';
import { fixtureOpenBoard } from '../../../../board/tests/fixtures/board.js';
import * as store from '../../../../store/index.js';
import { candidates } from '../../../src/io/step/selection.js';

/** A real scratch repo and board, with the milestones stored as the roadmap stores them and an accept event per item in the order given. */
function scratch(t, { accepted, milestones }) {
  const fixture = privateFixtureFiles('pullboard-landing-priority-'), root = fixture.root;
  const vcs = (...args) => runFixtureChild('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).stdout.trim();
  vcs('init', '-q', '-b', 'main');
  fixture.write('a.txt', 'base\n');
  vcs('add', '-A');
  vcs('commit', '-q', '-m', 'base');
  const boards = privateFixtureFiles('pullboard-landing-priority-board-');
  const board = fixtureOpenBoard({ boardFile: join(boards.root, 'board.sqlite') });
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); rmSync(boards.root, { recursive: true, force: true }); });
  board.db.prepare('INSERT OR REPLACE INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run('milestones', JSON.stringify(milestones));
  for (const id of accepted) board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES ('2026-11-16T00:00:00.000Z', 'fixture', 'accept', ?, '{}')").run(id);
  return { root, board, base: vcs('rev-parse', 'HEAD') };
}

const listed = (base, ids, extra = {}) => ids.map(id => ({ item_id: id, item_status: 'verified', item_merged_commit: null, item_commit: base, item_hold_at: null, ...(extra[id] ?? {}) }));
const roadmap = (...lists) => lists.map((items, index) => ({ name: `m${index}`, items, order: [] }));
const picked = (board, root, base, items, options = {}) => candidates(board, root, base, 8, { listItems: () => items, ...options });

test('landing.priority.with-two-accepted-items-the-one: clause 1: with two accepted items, the one in an earlier milestone lands first even if accepted later [C7,#3157]', t => {
  const { root, board, base } = scratch(t, { accepted: [21, 22], milestones: roadmap([22, 99], [21]) });
  const items = listed(base, [21, 22]);
  assert.deepEqual(picked(board, root, base, items, { priority: true }).ready.map(item => item.item_id), [22, 21]);
  assert.deepEqual(picked(board, root, base, items).ready.map(item => item.item_id), [21, 22], 'priority off keeps the accept order');
});

test('landing.priority.a-person-urgent-accepted-item-lands: clause 2: a person-urgent accepted item lands before all others, whatever its milestone [C7,#3157]', t => {
  const { root, board, base } = scratch(t, { accepted: [31, 32, 33], milestones: roadmap([31], [32], [33]) });
  board.db.prepare('INSERT OR REPLACE INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run('item_urgent:33', 'on');
  const items = listed(base, [31, 32, 33]);
  assert.deepEqual(picked(board, root, base, items, { priority: true }).ready.map(item => item.item_id), [33, 31, 32]);
});

test('landing.priority.a-held-or-stale-item-is: clause 3: a held or stale item is skipped without changing the order of the rest [C7,#3157]', t => {
  const { root, board, base } = scratch(t, { accepted: [41, 42, 43], milestones: roadmap([41], [42], [43]) });
  const items = listed(base, [41, 42, 43], { 41: { item_hold_at: '2026-11-16T00:00:00.000Z', item_hold_reason: 'held' } });
  const { ready, blocked } = picked(board, root, base, items, { priority: true });
  assert.deepEqual(ready.map(item => item.item_id), [42, 43]);
  assert.deepEqual(blocked.map(item => [item.id, item.code]), [[41, 'ITEM_HELD']]);
});
