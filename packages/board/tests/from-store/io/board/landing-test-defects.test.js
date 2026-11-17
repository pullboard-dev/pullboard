/** One test file is one landing test defect while its item lives: a changed hash adds a fact, a closed item files anew [C7,E29]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { cellRepo } from '../../../../../store/tests/fixtures/cell.js';

/** A real SQLite board in a scratch git repo, plus a filer for one test file's defect. */
function fixture(t) {
  const repo = cellRepo(t);
  const board = cellBoard(t, repo.boardFile);
  const root = repo.root;
  store.board_ensureCoordinator(board, root);
  let n = 0;
  const file = (hash, names = ['case one']) => store.recordLandingTestDefect(board, { agentId: 'coordinator', test: 'test/a.test.js',
    hash: hash.repeat(64), blob: 'c'.repeat(40), trunkBlob: null, names, lane: 'core', batchId: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, branch: 'refs/heads/main' });
  const open = () => store.listItems(board).filter(item => item.item_title.startsWith('Landing test defect'));
  return { board, file, open };
}

test('clause 1: two defects for one test file with different hashes leave one open item with a fact [C7,E29]', t => {
  const f = fixture(t);
  const first = f.file('a'), second = f.file('b', ['case two']);
  assert.equal(second.item, first.item);
  assert.equal(f.open().length, 1);
  assert.ok(second.names.includes('case one') && second.names.includes('case two'));
  assert.ok(store.itemThread(f.board, first.item).some(entry => JSON.stringify(entry).includes('case two')), 'the new names and hash are logged on the open item');
});

test('clause 2: a defect whose item is withdrawn files a new item [C7,E29]', t => {
  const f = fixture(t);
  const first = f.file('a');
  store.withdraw(f.board, first.item, { agentId: 'coordinator', reason: 'test' });
  const second = f.file('b');
  assert.notEqual(second.item, first.item);
});
