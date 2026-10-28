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

const FLOW_PREFIX = "import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'; import { join, resolve } from 'node:path'; import { tmpdir } from 'node:os';\n";

/** Apply the analyzer's source edits without evaluating any fixture or replacing unrelated text. */
function editedFixture(source, edits) {
  let result = source;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

/** An uncertain read must remain a named problem rather than a data exclusion or partial rewrite. */
function assertUnprovenFixture(body) {
  const result = fixtureSourceEdits(FLOW_PREFIX + body, options);
  assert.deepEqual(result.edits, [], body);
  assert.ok(result.problems.length > 0, body);
  assert.ok(result.problems.every(problem => problem.includes(options.file)), body);
  assert.equal(result.excluded, undefined, body);
}

test('closed local helper calls classify real repository YAML without trusting the parameter name [C7]', () => {
  const source = FLOW_PREFIX + `
const ROOT = resolve(import.meta.dirname, '..');
function workflowText(path) { return readFileSync(path, 'utf8'); }
const first = workflowText(resolve(ROOT, '.github/workflows/dco.yml'));
const second = workflowText(resolve(ROOT, '.github/workflows/ci.yml'));
`;
  const result = fixtureSourceEdits(source, options);
  assert.deepEqual(result.edits, []);
  assert.deepEqual(result.problems, []);
  assert.equal(editedFixture(source, result.edits), source, 'repository workflow bytes and all callers remain unchanged');
});

test('a closed helper reading moved implementation rewrites its actual source and preserves destinations and assertions [C7]', () => {
  const source = FLOW_PREFIX + `
function sourceText(path) { return readFileSync(path, 'utf8'); }
const code = sourceText(new URL('../src/git.js', import.meta.url));
writeFileSync(join(root, 'src', 'git.js'), code);
assert.equal(code.includes('src/git.js'), true);
`;
  const result = fixtureSourceEdits(source, options);
  assert.deepEqual(result.problems, []);
  assert.equal(result.edits.length, 1);
  const rewritten = editedFixture(source, result.edits);
  assert.match(rewritten, /new URL\(['"]\.\.\/packages\/git\/src\/shell\/git\.js['"], import\.meta\.url\)/u);
  assert.ok(rewritten.includes("writeFileSync(join(root, 'src', 'git.js'), code)"));
  assert.ok(rewritten.includes("assert.equal(code.includes('src/git.js'), true)"));
  assert.deepEqual(fixtureSourceEdits(rewritten, options).edits, [], 'an actual-home source is not rewritten again');
});

test('mixed, dynamic and escaped local helper arguments keep the source read unknown [C7]', () => {
  const helper = "function text(path) { return readFileSync(path, 'utf8'); }\n";
  for (const body of [
    helper + "text(new URL('../.github/workflows/dco.yml', import.meta.url)); text(mystery);",
    helper + 'text(computePath());',
    helper + "const escaped = text; escaped(new URL('../src/git.js', import.meta.url));",
    helper + 'consume(text); text(mystery);',
    helper + "text(...paths); text(new URL('../.github/workflows/dco.yml', import.meta.url));",
  ]) assertUnprovenFixture(body);
});

test('an explicit factory return binds only its actual fixture member to generated bytes [C7]', () => {
  const source = FLOW_PREFIX + `
function makeBox() {
  const dir = mkdtempSync(join(tmpdir(), 'source-flow-'));
  const marker = join(dir, 'executed-hook');
  writeFileSync(marker, 'hook pre-commit\\n');
  return { marker };
}
const box = makeBox();
const snapshot = { marker: box.marker };
const observed = readFileSync(box.marker, 'utf8');
`;
  const result = fixtureSourceEdits(source, options);
  assert.deepEqual(result.edits, []);
  assert.deepEqual(result.problems, []);
  assert.equal(editedFixture(source, result.edits), source, 'generated fixture input is classified without changing its bytes');
});

test('a fixture field spelling does not authorize a different receiver or a source-returning factory [C7]', () => {
  const factory = `
function makeBox() {
  const dir = mkdtempSync(join(tmpdir(), 'source-flow-'));
  const marker = join(dir, 'executed-hook');
  writeFileSync(marker, 'generated');
  return { marker };
}
const box = makeBox();
`;
  assertUnprovenFixture(factory + "const other = unknownBox(); readFileSync(other.marker, 'utf8');");
  assertUnprovenFixture(`
function makeBox() { return { marker: new URL('../src/git.js', import.meta.url) }; }
const box = makeBox(); readFileSync(box.marker, 'utf8');
`);
});

test('factory member assignment, prototype writes, shadowing, spreads and unknown branches stay unknown [C7]', () => {
  const factory = `
function makeBox() {
  const dir = mkdtempSync(join(tmpdir(), 'source-flow-'));
  const marker = join(dir, 'executed-hook');
  writeFileSync(marker, 'generated');
  return { marker };
}
const box = makeBox();
`;
  for (const body of [
    factory + "box.marker = mystery; readFileSync(box.marker, 'utf8');",
    factory + "({ marker: box.marker } = incoming); readFileSync(box.marker, 'utf8');",
    factory + "({ nested: { marker: box.marker } } = incoming); readFileSync(box.marker, 'utf8');",
    factory + "({ marker: box.marker = mystery } = incoming); readFileSync(box.marker, 'utf8');",
    factory + "([box.marker] = incoming); readFileSync(box.marker, 'utf8');",
    factory + "([...box.marker] = incoming); readFileSync(box.marker, 'utf8');",
    factory + "({...box.marker} = incoming); readFileSync(box.marker, 'utf8');",
    factory + "++box.marker; readFileSync(box.marker, 'utf8');",
    factory + "for (box.marker of incoming) {} readFileSync(box.marker, 'utf8');",
    factory + "for (box.marker in incoming) {} readFileSync(box.marker, 'utf8');",
    factory + "delete box.marker; readFileSync(box.marker, 'utf8');",
    factory + "delete (box.marker); readFileSync(box.marker, 'utf8');",
    factory + "delete (((box.marker))); readFileSync(box.marker, 'utf8');",
    factory + "Object.setPrototypeOf(box, unknownPrototype); readFileSync(box.marker, 'utf8');",
    factory + "box.__proto__ = unknownPrototype; readFileSync(box.marker, 'utf8');",
    factory + "function inspect(box) { return readFileSync(box.marker, 'utf8'); } inspect(unknownBox());",
    factory + "const other = { ...box, ...unknownBox() }; readFileSync(other.marker, 'utf8');",
    `function makeBox() {
      const dir = mkdtempSync(join(tmpdir(), 'source-flow-'));
      const marker = join(dir, 'executed-hook');
      writeFileSync(marker, 'generated');
      if (unknownCondition) return { marker: mystery };
      return { marker };
    }
    const box = makeBox(); readFileSync(box.marker, 'utf8');`,
  ]) assertUnprovenFixture(body);
});

test('copying implementation into a temporary fixture never excuses the original moved source [C7]', () => {
  const source = FLOW_PREFIX + `
function makeBox() {
  const dir = mkdtempSync(join(tmpdir(), 'source-flow-'));
  const marker = join(dir, 'git.js');
  cpSync(new URL('../src/git.js', import.meta.url), marker);
  return { marker };
}
const box = makeBox();
readFileSync(box.marker, 'utf8');
`;
  const result = fixtureSourceEdits(source, options);
  assert.ok(result.edits.length || result.problems.length, 'a copied source remains an edit or named unknown');
  if (result.edits.length) {
    const rewritten = editedFixture(source, result.edits);
    assert.match(rewritten, /new URL\(['"]\.\.\/packages\/git\/src\/shell\/git\.js['"], import\.meta\.url\)/u);
    assert.match(rewritten, /cpSync\(new URL\(['"]\.\.\/packages\/git\/src\/shell\/git\.js['"], import\.meta\.url\), marker\)/u);
    assert.ok(rewritten.includes("readFileSync(box.marker, 'utf8')"));
  }
});
