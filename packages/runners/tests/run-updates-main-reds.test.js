/** A test run at a main commit closes and files Main red items; item code that touches the file never does [C7,#4635]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellRepo } from '../../store/tests/fixtures/cell.js';
import { cellSandbox } from '../../store/tests/fixtures/cell.js';
import { mainRedUpdates } from '../index.js';
import { filesOfMain } from '../index.js';

const MAIN = 'a'.repeat(40);
const red = (id, file, status = 'open') => ({ item_id: id, item_title: `Main red: ${file}`, item_status: status, item_merged_commit: null });

/** A real repository with main at one commit and an item commit on top that edits only b.test.js. */
function repo(t) {
  const box = cellRepo(t, { real: true }), sandbox = cellSandbox(t);
  box.put('t/a.test.js', '// a\n'); box.put('t/b.test.js', '// b\n');
  const main = box.commitAll();
  box.put('t/b.test.js', '// b changed\n');
  const head = box.commitAll();
  return { git: args => sandbox.tryGit(box.root, ...args), main, head };
}

test('runners.run-updates-main-reds.a-green-run-of-a-file: [C7] a green run of a file at a main commit closes its open Main red item', () => {
  const items = [red(7, 't/a.test.js'), red(8, 't/c.test.js'), red(9, 't/a.test.js', 'claimed')];
  const out = mainRedUpdates({ items: [items[0], items[1]], files: ['t/a.test.js'], green: true, qualified: ['t/a.test.js'], main: MAIN });
  assert.deepEqual(out.close, [{ item: 7, file: 't/a.test.js' }]);
  assert.deepEqual(out.file, []);
  // A claimed item has a builder, who finishes it; a file with no item changes nothing.
  assert.deepEqual(mainRedUpdates({ items: [items[2]], files: ['t/a.test.js'], green: true, qualified: ['t/a.test.js'], main: MAIN }).close, []);
});

test('runners.run-updates-main-reds.a-red-run-of-a-file: [C7] a red run of a file with no open Main red item files one naming the failing cases', () => {
  const failing = [{ file: 't/a.test.js', name: 'case one' }, { file: 't/a.test.js', name: 'case two' }, { file: 't/c.test.js', name: 'owned' }];
  const out = mainRedUpdates({ items: [red(8, 't/c.test.js')], files: ['t/a.test.js', 't/c.test.js'], green: false, failing, qualified: ['t/a.test.js', 't/c.test.js'], main: MAIN });
  assert.deepEqual(out.file, [{ file: 't/a.test.js', names: ['case one', 'case two'] }]);
  assert.deepEqual(out.close, []);
});

test('runners.run-updates-main-reds.a-run-on-unlanded-item-code: [C7] a run on unlanded item code never closes or files for a file its diff touches', t => {
  const { git, main, head } = repo(t);
  {
    const files = ['t/a.test.js', 't/b.test.js'];
    assert.deepEqual(filesOfMain(git, { main, head, files }), ['t/a.test.js']);
    assert.deepEqual(filesOfMain(git, { main, head: main, files }), files);
    const qualified = filesOfMain(git, { main, head, files });
    const green = mainRedUpdates({ items: [red(1, 't/a.test.js'), red(2, 't/b.test.js')], files, green: true, qualified, main });
    assert.deepEqual(green.close, [{ item: 1, file: 't/a.test.js' }]);
    const failing = [{ file: 't/b.test.js', name: 'item broke it' }];
    assert.deepEqual(mainRedUpdates({ items: [], files, green: false, failing, qualified, main }).file, []);
    // Item code built on an older main proves nothing about the current one.
    assert.deepEqual(filesOfMain(git, { main: 'b'.repeat(40), head, files }), []);
  }
});
