/** After 2 infrastructure failures the head item steps aside behind the next accepted item and still lands later [C7,#3118]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { runFixtureChild } from '../../../gate/tests/fixtures/child.js';
import { fixtureOpenBoard } from '../../../board/tests/fixtures/board.js';
import * as store from '../../../store/index.js';
import { candidates } from '../../src/io/step/selection.js';

/** A real scratch repo and board, with the milestones stored as the roadmap stores them and an accept event per item in the order given. */
function scratch(t, { accepted}) {
  const fixture = privateFixtureFiles('pullboard-landing-stepaside-'), root = fixture.root;
  const vcs = (...args) => runFixtureChild('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).stdout.trim();
  vcs('init', '-q', '-b', 'main');
  fixture.write('a.txt', 'base\n');
  vcs('add', '-A');
  vcs('commit', '-q', '-m', 'base');
  const boards = privateFixtureFiles('pullboard-landing-stepaside-board-');
  const board = fixtureOpenBoard({ boardFile: join(boards.root, 'board.sqlite') });
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); rmSync(boards.root, { recursive: true, force: true }); });
  for (const id of accepted) board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES ('2026-11-16T00:00:00.000Z', 'fixture', 'accept', ?, '{}')").run(id);
  return { root, board, base: vcs('rev-parse', 'HEAD') };
}

const listed = (base, ids, extra = {}) => ids.map(id => ({ item_id: id, item_status: 'verified', item_merged_commit: null, item_commit: base, item_hold_at: null, ...(extra[id] ?? {}) }));
const picked = (board, root, base, items, options = {}) => candidates(board, root, base, 8, { listItems: () => items, ...options });

test('landing.step-aside.after-2-infrastructure-failures-the-head: clause 1: after 2 infrastructure failures the head item moves behind the next accepted item [C7,#3118]', t => {
  const { root, board, base } = scratch(t, { accepted: [51, 52, 53] });
  const items = listed(base, [51, 52, 53]);
  store.countLeaseLapse(board, 51);
  assert.deepEqual(picked(board, root, base, items, { stepAside: 2 }).ready.map(item => item.item_id), [51, 52, 53], 'one failure keeps the place');
  store.countLeaseLapse(board, 51);
  assert.deepEqual(picked(board, root, base, items, { stepAside: 2 }).ready.map(item => item.item_id), [52, 53, 51]);
  assert.deepEqual(picked(board, root, base, items).ready.map(item => item.item_id), [51, 52, 53], 'the setting off keeps the accept order');
});

test('landing.step-aside.the-stepped-aside-item-keeps-its: clause 2: the stepped-aside item keeps its accept and lands later [C7,#3118]', t => {
  const { root, board, base } = scratch(t, { accepted: [61, 62] });
  store.countLeaseLapse(board, 61);
  store.countLeaseLapse(board, 61);
  const first = picked(board, root, base, listed(base, [61, 62]), { stepAside: 2 });
  assert.deepEqual(first.ready.map(item => item.item_id), [62, 61], 'still ready, behind the next accepted item');
  assert.equal(board.db.prepare("SELECT count(*) AS n FROM event WHERE event_kind='accept' AND item_id=61").get().n, 1, 'its accept is untouched');
  store.clearStepAside(board, 61);
  assert.deepEqual(picked(board, root, base, listed(base, [61, 62]), { stepAside: 2 }).ready.map(item => item.item_id), [61, 62], 'its count cleared, it leads again');
});
