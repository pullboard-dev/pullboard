/** Fixtures copy and read tool sources through one shim-following copier, so a cells move needs no per-test path edits [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
  posix,
} from 'node:path';
import { test } from 'node:test';
import { fixtureSourceEdits } from '../../../../packages/codemap/index.js';
import { canonicalCopierPaths } from '../../../../packages/codemap/src/io/cells-move-mentions.js';
import {
  copyPackageFiles,
  shimTargets,
} from '../../../../packages/runners/index.js';
import { toolSourcePath } from '../../../../packages/runners/index.js';

const BODY = 'export const answer = 42;\n';
const MOVES = [['src/foo.js', 'packages/foo/src/shell/foo.js']];

/** Build a package whose src/foo.js has been moved: a shim, a front door and the body behind them. */
function movedPackage(t, shim = "export * from '../packages/foo/index.js';\n") {
  const root = mkdtempSync(join(tmpdir(), 'fixture-copier-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    'package.json': JSON.stringify({ name: 'moved', files: ['src', 'packages', '!packages/*/tests/**'] }),
    'src/foo.js': shim,
    'src/plain.js': BODY,
    'packages/foo/index.js': "export * from './src/shell/foo.js';\n",
    'packages/foo/src/shell/foo.js': BODY,
    'packages/foo/tests/foo.test.js': '// not shipped\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

/** Make a private destination outside its source. */
function destination(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fixture-copier-copy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a fixture built through the copier after a simulated move contains the moved body [C7]', t => {
  const root = movedPackage(t), whole = destination(t), subset = destination(t);
  copyPackageFiles(root, whole);
  assert.equal(readFileSync(join(whole, 'packages/foo/src/shell/foo.js'), 'utf8'), BODY);
  const copied = copyPackageFiles(root, subset, { files: ['src/foo.js'] });
  assert.deepEqual(copied.sort(), ['packages/foo/index.js', 'packages/foo/src/shell/foo.js', 'src/foo.js'],
    'naming only the shim still carries the front door and the body it forwards to');
  assert.equal(readFileSync(toolSourcePath(subset, 'src/foo.js'), 'utf8'), BODY);
  assert.equal(toolSourcePath(subset, 'src/foo.js'), join(subset, 'packages/foo/src/shell/foo.js'));
});

test('a source that has not moved resolves to itself, so the same test line is right before and after a move [C7]', t => {
  const root = movedPackage(t), copy = destination(t);
  copyPackageFiles(root, copy, { files: ['src/plain.js'] });
  assert.equal(toolSourcePath(copy, 'src/plain.js'), join(copy, 'src/plain.js'));
  assert.deepEqual(shimTargets(BODY), null);
  assert.deepEqual(shimTargets("/** shim */\nexport * from './a.js'; // c\nexport { x } from './b.js';"), ['./a.js', './b.js']);
});

test('a shim that forwards to nothing shipped, or to several modules, is refused by name [C7]', t => {
  const dangling = movedPackage(t, "export * from '../packages/missing/index.js';\n"), copy = destination(t);
  assert.throws(() => copyPackageFiles(dangling, copy, { files: ['src/foo.js'] }), /packages\/missing\/index\.js/u);
  const many = movedPackage(t, "export * from '../packages/foo/index.js';\nexport * from './plain.js';\n");
  assert.throws(() => toolSourcePath(many, 'src/foo.js'), /src\/foo\.js is a shim over 2 modules/u);
  assert.throws(() => toolSourcePath(many, '../outside.js'), /unsafe package files entry/u);
});

const PREFIX = "import { copyFileSync, readFileSync } from 'node:fs'; import { join, resolve } from 'node:path'; import { pathToFileURL, fileURLToPath } from 'node:url';\nimport { toolSourcePath } from '../packages/runners/index.js';\n";
const options = { file: 'test/some.test.js', moves: MOVES, readSource: () => null, mentionsOnly: true };

/** Analyze a fixture body under the plan's file-level gate. */
function analyze(body) {
  return fixtureSourceEdits(PREFIX + body, options);
}

test('a read through the copier is proven for any move, beside reads the analyzer cannot resolve [C7]', () => {
  const body = "const body = readFileSync(toolSourcePath(dir, 'src/foo.js'), 'utf8');\nconst other = readFileSync(somewhere);\n";
  assert.deepEqual(analyze(body), { edits: [], problems: [] }, 'no moved path is read by name, so the unrelated read is not this move\'s concern');
  const mixed = analyze(body + "const first = readFileSync(toolSourcePath(dir, 'src/foo.js'));\ncopyFileSync(join(dir, 'src/foo.js'), target);\n");
  assert.ok(mixed.edits.length + mixed.problems.length > 0, 'a literal copy of the moved path still needs repointing');
  assert.ok(!mixed.problems.some(problem => /toolSourcePath/u.test(problem)));
});

test('module addressing of a moved source is not a read to repoint [C7]', () => {
  const unrelated = 'const other = readFileSync(somewhere);\n';
  const safe = [
    "import { x } from '../src/foo.js';\n",
    "const url = pathToFileURL(resolve(import.meta.dirname, '../src/foo.js')).href;\n",
    "const url = new URL('../src/foo.js', import.meta.url).href;\n",
    "const program = `import { x } from ${JSON.stringify(resolve(import.meta.dirname, '../src/foo.js'))};`;\n",
    "const MODULE = resolve(import.meta.dirname, '../src/foo.js');\nconst program = `import { x } from ${JSON.stringify(MODULE)};`;\n",
    "const key = 'foo.js#answer';\n",
  ];
  for (const line of safe) assert.deepEqual(analyze(line + unrelated), { edits: [], problems: [] }, line);
});

test('a moved source named as a path to read stays reported [C7]', () => {
  const unsafe = [
    "const file = join(root, 'src/foo.js');\nreadFileSync(file);\n",
    "readFileSync(new URL('../src/foo.js', import.meta.url));\n",
    "readFileSync(pathToFileURL(resolve(import.meta.dirname, '../src/foo.js')), 'utf8');\n",
    "const file = fileURLToPath(new URL('../src/foo.js', import.meta.url));\nreadFileSync(file);\n",
    "const MODULE = resolve(import.meta.dirname, '../src/foo.js');\nreadFileSync(MODULE, 'utf8');\n",
    "const MODULE = resolve(import.meta.dirname, '../src/foo.js');\nconst program = `import { x } from ${JSON.stringify(MODULE)};`;\nreadFileSync(MODULE);\n",
  ];
  for (const body of unsafe) {
    const result = analyze(body);
    assert.ok(result.edits.length + result.problems.length > 0, body);
  }
});

test('only the imported, unshadowed copier exempts a mention; shadows and lookalikes stay reported [C7]', () => {
  const unrelated = 'const other = readFileSync(somewhere);\n';
  const proven = "const a = readFileSync(toolSourcePath(dir, 'src/foo.js'));\n";
  assert.deepEqual(analyze(proven + unrelated), { edits: [], problems: [] });
  const shadows = [
    "function read(toolSourcePath, root) { return readFileSync(toolSourcePath(root, 'src/foo.js'), 'utf8'); }\nread((root, name) => join(root, name), dir);\n",
    "let toolSourcePath = (root, name) => join(root, name);\nreadFileSync(toolSourcePath(dir, 'src/foo.js'));\n",
    "function read(options) { const { copy: toolSourcePath } = options; return readFileSync(toolSourcePath(dir, 'src/foo.js')); }\n",
    "function read(options) { const { toolSourcePath } = options; return readFileSync(toolSourcePath(dir, 'src/foo.js')); }\n",
    "const other = { toolSourcePath: (root, name) => join(root, name) };\nreadFileSync(other.toolSourcePath(dir, 'src/foo.js'));\n",
    "const read = toolSourcePath => readFileSync(toolSourcePath(dir, 'src/foo.js'));\nread((root, name) => join(root, name));\n",
  ];
  for (const body of shadows) {
    const result = analyze(body);
    assert.ok(result.edits.length + result.problems.length > 0, body);
  }
});

test('only an import that resolves to the canonical copier body makes a copier [C7]', () => {
  const read = "const a = readFileSync(toolSourcePath(dir, 'src/foo.js'));\n";
  const unrelated = 'const other = readFileSync(somewhere);\n';
  const withImport = (specifier, file) => fixtureSourceEdits(
    `import { readFileSync } from 'node:fs'; import { join } from 'node:path';\nimport { toolSourcePath } from '${specifier}';\n${read}${unrelated}`,
    { ...options, file });
  const clean = { edits: [], problems: [] };
  assert.deepEqual(withImport('../src/package-files.js', 'test/a.test.js'), clean);
  assert.deepEqual(withImport('../../packages/runners/src/io/package/files.js', 'test/sub/a.test.js'), clean, 'a relative variant that resolves to the canonical file');
  assert.deepEqual(withImport('../packages/runners/src/io/package/files.js', 'test/a.test.js'), clean);
  for (const [specifier, file] of [['./private/package-files.js', 'test/a.test.js'], ['../private/package-files.js', 'test/a.test.js'],
    ['../src/io/package/files.js', 'test/sub/a.test.js'], ['../lib/package-files.js', 'test/a.test.js']]) {
    const result = withImport(specifier, file);
    assert.ok(result.edits.length + result.problems.length > 0, `${specifier} from ${file} is a lookalike`);
  }
});

test('the copier is also accepted at the cells-plan target of the old copier path, read from the plan [C7]', () => {
  const target = [...canonicalCopierPaths()].find(path => path.startsWith('packages/'));
  assert.ok(target, 'the committed plan names where the old copier path moves');
  const read = "const a = readFileSync(toolSourcePath(dir, 'src/foo.js'));\nconst other = readFileSync(somewhere);\n";
  const as = (specifier, file) => fixtureSourceEdits(
    `import { readFileSync } from 'node:fs';\nimport { toolSourcePath } from '${specifier}';\n${read}`, { ...options, file });
  const from = 'test/a.test.js';
  assert.deepEqual(as(posix.relative(posix.dirname(from), target), from), { edits: [], problems: [] }, target);
  const lookalike = posix.join(posix.dirname(target), 'package-files-copy.js');
  const refused = as(posix.relative(posix.dirname(from), lookalike), from);
  assert.ok(refused.edits.length + refused.problems.length > 0, 'a sibling module in the same package is not the copier');
  const wrongPackage = as(posix.relative(posix.dirname(from), posix.join('packages/other', posix.relative('packages/runners', target))), from);
  assert.ok(wrongPackage.edits.length + wrongPackage.problems.length > 0);
});

test('the copier is also accepted through the front door of the cell that owns it, and through no other [C7]', () => {
  assert.ok(canonicalCopierPaths().has('packages/runners/index.js'), 'the runners front door forwards toolSourcePath from the body');
  const read = "const a = readFileSync(toolSourcePath(dir, 'src/foo.js'));\nconst other = readFileSync(somewhere);\n";
  const as = specifier => fixtureSourceEdits(
    `import { readFileSync } from 'node:fs';\nimport { toolSourcePath } from '${specifier}';\n${read}`, { ...options, file: 'test/a.test.js' });
  assert.deepEqual(as('../packages/runners/index.js'), { edits: [], problems: [] });
  for (const lookalike of ['../../config/index.js', '../packages/runners/other.js', '../../../apps/runner/index.js']) {
    const refused = as(lookalike);
    assert.ok(refused.edits.length + refused.problems.length > 0, `${lookalike} is not the copier`);
  }
});

test('only real import declarations make a copier; quoted text and comments never do [C7]', () => {
  const head = "import { readFileSync } from 'node:fs'; import { join } from 'node:path';\nimport { toolSourcePath } from './private/package-files.js';\n";
  const read = "const a = readFileSync(toolSourcePath(dir, 'src/foo.js'));\nconst other = readFileSync(somewhere);\n";
  const fake = "import { toolSourcePath } from '../index.js'";
  for (const decoy of [`const text = "${fake}";\n`, `const text = '${fake}';\n`, `const text = \`${fake}\`;\n`, `// ${fake}\n`, `/* ${fake} */\n`]) {
    const result = fixtureSourceEdits(head + decoy + read, options);
    assert.ok(result.edits.length + result.problems.length > 0, decoy);
  }
  const real = fixtureSourceEdits("import { readFileSync } from 'node:fs';\nimport { toolSourcePath as copy } from '../packages/runners/index.js';\n"
    + "const a = readFileSync(copy(dir, 'src/foo.js'));\nconst other = readFileSync(somewhere);\n", options);
  assert.deepEqual(real, { edits: [], problems: [] }, 'a real aliased import still counts');
});
