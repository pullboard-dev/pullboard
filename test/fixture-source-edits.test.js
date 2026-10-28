/** @pullboard-test-input source-tree */
/** The fixture source analyzer reports source-path reads and names board or data file reads as excluded [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureSourceEdits } from '../bin/cells-move-fixtures.js';

const PREFIX = "import { cpSync, readFileSync } from 'node:fs'; import { join } from 'node:path';\n";
const options = { file: 'test/data-reads.test.js', moves: [['src/git.js', 'packages/git/src/shell/git.js']], readSource: () => null };

test('a read whose path can name a moved source file is still reported [C7]', () => {
  const result = fixtureSourceEdits(PREFIX + "const code = join(root, 'src', 'git.js');\nreadFileSync(code);", options);
  assert.equal(result.excluded, undefined);
  assert.ok(result.edits.length || result.problems.length, 'the source-path read is an edit or a problem');
  const unknown = fixtureSourceEdits(PREFIX + 'readFileSync(mystery);', options);
  assert.equal(unknown.problems.length, 1);
  assert.match(unknown.problems[0], /unproven input expression or root/);
});

test('board database and fixture data reads are excluded and each is named with its reason [C7]', () => {
  // A `default` keyword in scope defeats the constant-folding leaf proof, as a real test body does, so only the data-root rule can clear these.
  const cases = [
    ["const mode = { default: 1 };\nconst dbFile = join(repo, '.git', 'pullboard', 'board.sqlite');\nreadFileSync(dbFile);", 'dbFile', 'board.sqlite'],
    ["const mode = { default: 1 };\nconst boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');\nconst privateLegacy = join(box.dir, 'index-migration.sqlite');\ncpSync(boardFile, privateLegacy);", 'boardFile', 'board.sqlite'],
    ["const file = join(root, '.git/pullboard/board.sqlite');\nconst box = { file };\nreadFileSync(box.file);", 'box.file', 'board.sqlite'],
  ];
  for (const [body, root, leaf] of cases) {
    const result = fixtureSourceEdits(PREFIX + body, options);
    assert.deepEqual([result.edits, result.problems], [[], []], body);
    assert.equal(result.excluded.length, 1, body);
    assert.match(result.excluded[0], new RegExp(`^test/data-reads\\.test\\.js:\\d+: excluded data read ${root.replace('.', '\\.')}: declared as data file ${leaf.replace('.', '\\.')}, not a tracked source path$`));
  }
});

test('a data-looking name shared with a moved source file stays reported [C7]', () => {
  const result = fixtureSourceEdits(PREFIX + "const dbFile = join(repo, 'board.sqlite');\nreadFileSync(dbFile);",
    { ...options, moves: [['src/board.sqlite', 'packages/board/src/shell/board.sqlite']] });
  assert.equal(result.excluded, undefined);
  assert.equal(result.problems.length, 1);
});
