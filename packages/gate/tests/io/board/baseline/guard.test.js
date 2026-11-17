/** @pullboard-test-input test-tree */
/** Source-only scanner for unclassified file-backed board opens in tests [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { BOARD_FILE_BASELINE } from '../../../../src/io/board/baseline.js';
import { boardFileGrowth } from '../../../../src/io/board/files.js';
import { boardFileOpens } from '../../../../src/io/board/files.js';
import { boardFileProblems } from '../../../../src/io/board/files.js';
import { boardFileReport } from '../../../../src/io/board/files.js';

test('gate.io-board-baseline-guard.the-board-file-lint-names-direct: the board-file lint names direct, namespaced and aliased logic file opens [C7]', () => {
  const source = [
    "import { openBoard as open } from '../../../../../../apps/lib/index.js';",
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

test('gate.io-board-baseline-guard.the-board-file-debt-ratchet-names: the board-file debt ratchet names outstanding tests and prevents new logic file opens [C7]', () => {
  const root = join(import.meta.dirname, '../../../../../..');
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

/** Moving a test relocates its existing debt; neither spelling gains another allowance. */
test('gate.io-board-baseline-guard.moved-store-tests-retain-exact-board: moved store tests retain exact board-file ceilings and refuse one extra open [C7]', () => {
  const moved = {
    'api-identity': ['packages/board/tests/from-store/io/board.test.js', 8],
    badge: ['apps/cli/journeys/badge/main.test.js', 1],
    'board-capture': ['packages/board/tests/from-store/io/board/capture.test.js', 4],
    'claim-reopen-clock': ['packages/moves/tests/logic/moves/claim.test.js', 1],
    'commit-metadata': ['apps/cli/journeys/release/metadata.test.js', 1],
    'landing-noop': ['apps/cli/journeys/land/landing/noop.test.js', 1],
    'shout-readable': ['apps/cli/journeys/shout/readable.test.js', 1],
    'stacked-submit': ['apps/cli/journeys/submit/stacked.test.js', 2],
    'verdict-check': ['apps/cli/journeys/verify/check.test.js', 1],
    verify: ['apps/cli/journeys/verify/main.test.js', 1],
  };
  for (const [name, [path, ceiling]] of Object.entries(moved)) {
    const legacy = `test/${name}.test.js`;
    assert.equal(BOARD_FILE_BASELINE[path], ceiling);
    assert.equal(Object.hasOwn(BOARD_FILE_BASELINE, legacy), false);
    const opens = boardFileOpens('openBoard(file);\n'.repeat(ceiling + 1), path);
    assert.deepEqual(boardFileGrowth(opens, BOARD_FILE_BASELINE), [opens[ceiling]]);
    const oldOpen = boardFileOpens('openBoard(file);', legacy);
    assert.deepEqual(boardFileGrowth(oldOpen, BOARD_FILE_BASELINE), oldOpen);
  }
});
