/** @pullboard-test-input test-tree */
/** Source-only scanner for unclassified file-backed board opens in tests [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { BOARD_FILE_BASELINE } from '../bin/checks/board-file-baseline.js';
import { boardFileGrowth } from '../bin/checks/board-files.js';
import { boardFileOpens } from '../bin/checks/board-files.js';
import { boardFileProblems } from '../bin/checks/board-files.js';
import { boardFileReport } from '../bin/checks/board-files.js';

test('the board-file lint names direct, namespaced and aliased logic file opens [C7]', () => {
  const source = [
    "import { openBoard as open } from '../src/board.js';",
    "const a = store.openBoard(':memory:');",
    "const b = openBoard(file);",
    "const c = open(join(root, 'board.sqlite'));",
    "const d = store.openBoard(`:memory:`);",
    "// store.openBoard('ignored.sqlite');",
    'const text = "openBoard(file)";',
    '// @pullboard-board-file locking: a competing connection must see the lock',
    'const e = openBoard(file);',
    "const f = openBoard(':memory:' + suffix);",
  ].join('\n');
  assert.deepEqual(boardFileOpens(source, 'test/example.test.js').map(({ path, line }) => ({ path, line })), [
    { path: 'test/example.test.js', line: 3 }, { path: 'test/example.test.js', line: 4 },
    { path: 'test/example.test.js', line: 10 },
  ]);
  assert.equal(boardFileOpens('// @pullboard-board-file logic: not a boundary\nopenBoard(file)', 'test/logic.test.js').length, 1);
});

test('the board-file debt ratchet names outstanding tests and prevents new logic file opens [C7]', () => {
  const root = join(import.meta.dirname, '..');
  const baseline = BOARD_FILE_BASELINE;
  assert.deepEqual(boardFileProblems(root, baseline), []);
  const debt = boardFileReport(root);
  assert.ok(debt.every(row => /\.(?:test|spec)\.[cm]?js$/u.test(row.path) && row.line > 0));
  const path = 'test/new-logic.test.js';
  const one = boardFileOpens('openBoard(file);', path);
  assert.deepEqual(boardFileGrowth(one, {}), one, 'a new logic file opening a board file is refused');
  const allowed = { [path]: 1 };
  assert.deepEqual(boardFileGrowth(one, allowed), []);
  const grown = boardFileOpens('openBoard(file);\nstore.openBoard(other);', path);
  assert.deepEqual(boardFileGrowth(grown, allowed), [grown[1]], 'a second file open exceeds the existing debt');
  for (const path of ['test/engine.test.js', 'test/item-notes-engine.test.js']) {
    assert.equal(debt.some(row => row.path === path), false, `${path} has no remaining board-file opens`);
  }
});
