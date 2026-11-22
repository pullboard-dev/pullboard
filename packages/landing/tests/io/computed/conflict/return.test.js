/** @pullboard-test-input test-tree */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixtureCommittedGraph } from '../../../../../store/tests/fixtures/cell.js';
import { runFixtureGit } from '../../../../../store/tests/fixtures/cell.js';
import { staticImportClosure } from '../../../fixtures/conflict-import.js';
import { computeConflictReturn } from '../../../../src/io/computed/conflict/return.js';

/** Build two real Git histories whose same-line edits conflict at their tips. */
function conflictRepo(t) {
  const graph = fixtureCommittedGraph('pullboard-landing-return-');
  const root = graph.root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  graph.put('conflict.txt', 'base\n');
  graph.commit();
  runFixtureGit(['checkout', '-q', '-b', 'candidate'], { cwd: root });
  graph.put('conflict.txt', 'candidate\n');
  const head = graph.commit();
  runFixtureGit(['checkout', '-q', 'main'], { cwd: root });
  graph.put('conflict.txt', 'trunk\n');
  const trunk = graph.commit();
  const boardFile = join(root, '.git', 'pullboard', 'board.sqlite');
  graph.put('.git/pullboard/board.sqlite', 'fixture');
  return { root, boardFile, head, trunk };
}

test('landing.conflict.return-cold-import: clause 1: importing the return caller does not load packages/merge/index.js [C7]', () => {
  assert.equal(staticImportClosure('packages/landing/src/io/computed/conflict/return.js')
    .includes('packages/merge/index.js'), false, 'a cold caller import does not reach the merge barrel');
});

test('landing.conflict.return-current-trunk: clause 2: a real synchronous return records the current trunk conflict through the merge public door [C7]', t => {
  const repo = conflictRepo(t);
  const item = { item_id: 17, item_status: 'submitted', item_commit: repo.head };
  const actor = 'core-fixture';
  const boardId = 'b'.repeat(32);
  const board = { clock: { now: () => new Date('2026-11-22T00:00:00.000Z') }, db: { prepare(sql) {
    return {
      all: () => sql === 'PRAGMA database_list' ? [{ name: 'main', file: repo.boardFile }] : [],
      get: (...args) => {
        if (sql.includes("SELECT agent_path FROM agent WHERE agent_id='coordinator'")) return { agent_path: repo.root };
        if (sql === 'SELECT * FROM item WHERE item_id=?') return item;
        if (sql === 'SELECT agent_id FROM agent WHERE agent_id=?') return { agent_id: actor };
        if (sql.includes("meta_key='board_id'")) return { meta_value: boardId };
        if (sql.includes("event_kind='submit'")) return { event_id: 9 };
        return undefined;
      },
    };
  } } };
  const receipt = computeConflictReturn(board, item.item_id, actor);
  assert.equal(receipt.version, 4);
  assert.equal(receipt.head, repo.head);
  assert.equal(receipt.trunk, repo.trunk);
  assert.deepEqual(receipt.files, ['conflict.txt']);
  assert.equal(receipt.item, item.item_id);
  assert.equal(receipt.actor, actor);
});
