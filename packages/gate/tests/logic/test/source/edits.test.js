/** @pullboard-test-input .github/workflows/cla.yml packages/blueprints/data/blueprints/pullboard.json packages/codemap/index.js packages/git/index.js packages/git/src/io/main.js */
/** The fixture source analyzer reports source-path reads and names board or data file reads as excluded [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureSourceEdits } from '../../../../../codemap/index.js';
import { withCellLintParser } from '../../../../../codemap/index.js';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFixtureChildAsync } from '../../../fixtures/child.js';

const PREFIX = "import { cpSync, readFileSync } from 'node:fs'; import { join } from 'node:path';\n";
const options = { file: 'test/data-reads.test.js', moves: [['packages/git/index.js', 'packages/git/src/io/main.js']], readSource: () => null };

test('gate.logic-test-source-edits.a-read-whose-path-can: a read whose path can name a moved source file is still reported [C7]', () => {
  const result = fixtureSourceEdits(PREFIX + "const code = join(root, 'packages/git/index.js');\nreadFileSync(code);", options);
  assert.equal(result.excluded, undefined);
  assert.ok(result.edits.length || result.problems.length, 'the source-path read is an edit or a problem');
  const unknown = fixtureSourceEdits(PREFIX + 'readFileSync(mystery);', options);
  assert.equal(unknown.problems.length, 1);
  assert.match(unknown.problems[0], /unproven input expression or root/);
});

test('gate.logic-test-source-edits.a-repo-root-file-with: a repo-root file with a moved asset basename is distinct from the moved path [C7]', () => {
  const move = { file: 'test/blueprint-reads.test.js', moves: [['src/blueprints/pullboard.json', 'packages/blueprints/data/blueprints/pullboard.json']], mentionsOnly: true };
  const root = fixtureSourceEdits(PREFIX + "readFileSync('pullboard.json'); readFileSync(unknown);", move);
  assert.deepEqual(root.problems, [], 'a known root file does not make an unrelated read part of this move');
  const source = fixtureSourceEdits(PREFIX + "readFileSync('src/blueprints/pullboard.json');", move);
  assert.equal(source.edits.length, 1, 'the actual moved source is still repointed');
  const ambiguous = fixtureSourceEdits(PREFIX + "readFileSync(join(root, 'pullboard.json'));", move);
  assert.ok(ambiguous.problems.length, 'an unproven root may still name the moved asset');
  const cwd = fixtureSourceEdits(PREFIX + "process.chdir(folder); readFileSync('pullboard.json'); readFileSync(unknown);", move);
  assert.ok(cwd.problems.length, 'a mutated cwd keeps the analysis conservative');
  const alias = fixtureSourceEdits(PREFIX + "import { chdir as change } from 'node:process'; change('src/blueprints'); readFileSync('pullboard.json'); readFileSync(unknown);", move);
  assert.ok(alias.problems.length || alias.edits.length, 'an imported cwd-changing alias cannot claim the root-file exemption');
  const computed = fixtureSourceEdits(PREFIX + "process['ch' + 'dir']('src/blueprints'); readFileSync('pullboard.json'); readFileSync(unknown);", move);
  assert.ok(computed.problems.length || computed.edits.length, 'a computed process operation keeps the cwd unproven');
  const processAlias = fixtureSourceEdits(PREFIX + "const proc = process; proc['ch' + 'dir']('src/blueprints'); readFileSync('pullboard.json'); readFileSync(unknown);", move);
  assert.ok(processAlias.problems.length || processAlias.edits.length, 'a process alias cannot hide a cwd change');
  for (const dependency of ["import './changes-cwd.js';", "import { change } from './changes-cwd.js'; change();", "await import('./changes-cwd.js');", "import { runInThisContext } from 'node:vm'; runInThisContext(code);"]) {
    const importedCwd = fixtureSourceEdits(PREFIX + dependency + " readFileSync('pullboard.json'); readFileSync(unknown);", move);
    assert.ok(importedCwd.problems.length || importedCwd.edits.length, 'an unevaluated dependency cannot establish the caller cwd');
  }
  const cwdProgram = "process.chdir('src/blueprints')";
  const encoded = [...cwdProgram].map(character => character.charCodeAt(0)).join(',');
  for (const program of [
    `const change = Function(String.fromCharCode(${encoded})); change();`,
    'unknown();', 'unknown`program`;', 'readFileSync(unknown);',
  ]) {
    const indirectCwd = fixtureSourceEdits(PREFIX + program + " readFileSync('pullboard.json'); readFileSync(unknown);", move);
    assert.ok(indirectCwd.problems.length || indirectCwd.edits.length, 'unproven earlier operations cannot establish the cwd');
  }
  const wrapper = fixtureSourceEdits("import * as fs from 'node:fs'; import { join } from 'node:path'; function readFileSync(name) { return fs.readFileSync(join('src/blueprints', name)); } readFileSync('pullboard.json');", move);
  assert.ok(wrapper.problems.length || wrapper.edits.length, 'a local reader wrapper may resolve the same name to the moved asset');
  const shadow = fixtureSourceEdits(PREFIX + "function run(readFileSync) { readFileSync('pullboard.json'); } run(unknown);", move);
  assert.ok(shadow.problems.length, 'a shadowed reader cannot claim the native root-file exemption');
});

test('gate.logic-test-source-edits.a-proven-realpath-of-a: a proven realpath of a fresh fixture remains distinct from a repository asset [C7]', () => {
  const prefix = "import { readFileSync, mkdtempSync, realpathSync } from 'node:fs'; import { join, resolve, dirname } from 'node:path'; import { tmpdir } from 'node:os';\n";
  const move = { file: 'test/fixture-root.test.js', moves: [['src/blueprints/pullboard.json', 'packages/blueprints/data/blueprints/pullboard.json']], mentionsOnly: true };
  const safe = fixtureSourceEdits(prefix + "const dir = realpathSync(mkdtempSync(join(tmpdir(), 'demo-'))); const root = join(dir, 'repo'); readFileSync(join(root, 'pullboard.json'));", move);
  assert.deepEqual(safe.problems, [], 'a native fresh temporary directory stays a fixture after canonicalization');
  const unknown = fixtureSourceEdits(prefix + "const dir = realpathSync(untrusted); readFileSync(join(dir, 'pullboard.json'));", move);
  assert.ok(unknown.problems.length, 'realpath of an unknown root is not evidence of fixture identity');
  const source = fixtureSourceEdits(prefix + "const dir = realpathSync('src/blueprints'); readFileSync(join(dir, 'pullboard.json'));", move);
  assert.ok(source.problems.length || source.edits.length, 'realpath of a repository source directory remains reported');
  for (const operand of ["resolve(dir, '/src/blueprints/pullboard.json')", "join(dir, '..', 'src/blueprints/pullboard.json')", "join(dirname(dir), 'src/blueprints/pullboard.json')"]) {
    const escaped = fixtureSourceEdits(prefix + `const dir = realpathSync(mkdtempSync(join(tmpdir(), 'demo-'))); readFileSync(${operand});`, move);
    assert.ok(escaped.problems.length || escaped.edits.length, `${operand} can escape the fresh directory`);
  }
});

test('gate.logic-test-source-edits.board-database-and-fixture-data: board database and fixture data reads are excluded and each is named with its reason [C7]', () => {
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

test('gate.logic-test-source-edits.a-data-looking-name-shared: a data-looking name shared with a moved source file stays reported [C7]', () => {
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

test('gate.logic-test-source-edits.closed-local-helper-calls-classify: closed local helper calls classify real repository YAML without trusting the parameter name [C7]', () => {
  const source = FLOW_PREFIX + `
const ROOT = resolve(import.meta.dirname, '../../../../../..');
function workflowText(path) { return readFileSync(path, 'utf8'); }
const first = workflowText(resolve(ROOT, '.github/workflows/cla.yml'));
const second = workflowText(resolve(ROOT, '.github/workflows/ci.yml'));
`;
  const result = fixtureSourceEdits(source, options);
  assert.deepEqual(result.edits, []);
  assert.deepEqual(result.problems, []);
  assert.equal(editedFixture(source, result.edits), source, 'repository workflow bytes and all callers remain unchanged');
});

test('gate.logic-test-source-edits.a-closed-helper-reading-moved: a closed helper reading moved implementation rewrites its actual source and preserves destinations and assertions [C7]', () => {
  const source = FLOW_PREFIX + `
function sourceText(path) { return readFileSync(path, 'utf8'); }
const code = sourceText(new URL('../packages/git/index.js', import.meta.url));
writeFileSync(join(root, 'packages/git/index.js'), code);
assert.equal(code.includes('packages/git/index.js'), true);
`;
  const result = fixtureSourceEdits(source, options);
  assert.deepEqual(result.problems, []);
  assert.equal(result.edits.length, 1);
  const rewritten = editedFixture(source, result.edits);
  assert.match(rewritten, /new URL\(['"]\.\.\/packages\/git\/src\/io\/main\.js['"], import\.meta\.url\)/u);
  assert.ok(rewritten.includes("writeFileSync(join(root, 'packages/git/index.js'), code)"));
  assert.ok(rewritten.includes("assert.equal(code.includes('packages/git/index.js'), true)"));
  assert.deepEqual(fixtureSourceEdits(rewritten, options).edits, [], 'an actual-home source is not rewritten again');
});

test('gate.logic-test-source-edits.mixed-dynamic-and-escaped-local: mixed, dynamic and escaped local helper arguments keep the source read unknown [C7]', () => {
  const helper = "function text(path) { return readFileSync(path, 'utf8'); }\n";
  for (const body of [
    helper + "text(new URL('../../../../../../.github/workflows/cla.yml', import.meta.url)); text(mystery);",
    helper + 'text(computePath());',
    helper + "const escaped = text; escaped(new URL('../packages/git/index.js', import.meta.url));",
    helper + 'consume(text); text(mystery);',
    helper + "text(...paths); text(new URL('../../../../../../.github/workflows/cla.yml', import.meta.url));",
  ]) assertUnprovenFixture(body);
});

test('gate.logic-test-source-edits.an-explicit-factory-return-binds: an explicit factory return binds only its actual fixture member to generated bytes [C7]', () => {
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

test('gate.logic-test-source-edits.a-fixture-field-spelling-does: a fixture field spelling does not authorize a different receiver or a source-returning factory [C7]', () => {
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
function makeBox() { return { marker: new URL('../packages/git/index.js', import.meta.url) }; }
const box = makeBox(); readFileSync(box.marker, 'utf8');
`);
});

test('gate.logic-test-source-edits.factory-member-assignment-prototype-writes: factory member assignment, prototype writes, shadowing, spreads and unknown branches stay unknown [C7]', () => {
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

test('gate.logic-test-source-edits.copying-implementation-into-a-temporary: copying implementation into a temporary fixture never excuses the original moved source [C7]', () => {
  const source = FLOW_PREFIX + `
function makeBox() {
  const dir = mkdtempSync(join(tmpdir(), 'source-flow-'));
  const marker = join(dir, 'git.js');
  cpSync(new URL('../packages/git/index.js', import.meta.url), marker);
  return { marker };
}
const box = makeBox();
readFileSync(box.marker, 'utf8');
`;
  const result = fixtureSourceEdits(source, options);
  assert.ok(result.edits.length || result.problems.length, 'a copied source remains an edit or named unknown');
  if (result.edits.length) {
    const rewritten = editedFixture(source, result.edits);
    assert.match(rewritten, /new URL\(['"]\.\.\/packages\/git\/src\/io\/main\.js['"], import\.meta\.url\)/u);
    assert.match(rewritten, /cpSync\(new URL\(['"]\.\.\/packages\/git\/src\/io\/main\.js['"], import\.meta\.url\), marker\)/u);
    assert.ok(rewritten.includes("readFileSync(box.marker, 'utf8')"));
  }
});

/** A generated private config is exact site data; a bundled source with the same basename stays a move obligation. */
test('gate.logic-test-source-edits.blueprint-config-declarations-retain-actual: blueprint config declarations retain actual-source and exact-site negatives [C7,CD64]', () => {
  const file = 'test/blueprints-data-read.fixture.js';
  const moves = [['src/blueprints/pullboard.json', 'packages/blueprints/data/blueprints/pullboard.json']];
  const expression = "join(box.repo, 'pullboard.json')";
  const source = PREFIX + `readFileSync(${expression}, 'utf8');\n`;
  const row = { file, line: 2, expression, kind: 'config', why: 'The private fixture creates its own root configuration.' };
  const options = { file, moves, dataReads: [row], mentionsOnly: true };
  const generated = fixtureSourceEdits(source, options);
  assert.deepEqual(generated.problems, []);
  assert.deepEqual(generated.edits, []);
  assert.deepEqual(generated.matchedDataReads, [row]);
  for (const changed of [source.replace('box.repo', 'other.repo'), '\n' + source]) {
    const result = fixtureSourceEdits(changed, options);
    assert.ok(result.problems.length, 'an unlisted expression or shifted line remains unproven');
    assert.deepEqual(result.matchedDataReads ?? [], []);
  }
  const real = "new URL('../src/blueprints/pullboard.json', import.meta.url)";
  const actual = fixtureSourceEdits(PREFIX + `readFileSync(${real}, 'utf8');\n`, {
    ...options, dataReads: [{ ...row, expression: real }],
  });
  assert.equal(actual.edits.length, 1, 'a declaration cannot hide the real moved repository asset');
  assert.deepEqual(actual.matchedDataReads ?? [], []);
});

test('gate.logic-test-source-edits.a-real-syntax-error-names: a real syntax error names its fixture file through the batch parser [C7,P3]', () => {
  const result = withCellLintParser(() => fixtureSourceEdits("import { readFileSync } from 'node:fs';\nconst broken = ;\n",
    { file: 'test/broken-fixture.js', moves: [['packages/git/index.js', 'packages/git/src/io/main.js']] }));
  assert.match(result.problems.join('\n'), /test\/broken-fixture\.js: fixture source does not compile/u);
});

test('gate.logic-test-source-edits.a-real-compiler-process-failure: a real compiler process failure retains its exit, stderr and fixture name [C7,P3]', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-probe-failure-'));
  const preload = join(directory, 'fail-compiler.mjs');
  writeFileSync(preload, "if(process.argv.includes('--compile')){process.stderr.write('owned fixture compiler failed\\n');process.exit(23);}\n");
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = [previous, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' ');
  try {
    withCellLintParser(() => {
      const source = PREFIX + "readFileSync('packages/git/index.js');\n";
      for (const file of ['test/first-probe.js', 'test/later-probe.js']) {
        const result = fixtureSourceEdits(source, { ...options, file });
        assert.deepEqual(result.edits, [], 'a crashed compiler authorizes no source rewrite');
        assert.ok(result.problems.some(problem => problem.startsWith(file + ': fixture binding compiler unavailable: CELL_BINDING_WORKER_EXIT:')));
        assert.match(result.problems.join('\n'), /exited 23, signal none; stderr: owned fixture compiler failed/u);
      }
    });
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('gate.logic-test-source-edits.shared-compiler-rotations-complete-every: shared compiler rotations complete every request under a bounded heap [C7,P3]', async () => {
  const entry = new URL('../../../../../codemap/index.js', import.meta.url).href;
  const script = `import {withCellLintParser} from ${JSON.stringify(entry)};
const source='export const values=['+Array.from({length:1000},(_,i)=>i).join(',')+'];';
let requests=0,compiled=0;
withCellLintParser(parse=>{for(let i=0;i<128;i++){
  const rows=parse(Array(64).fill(source));
  if(rows.some(row=>!row.compiles))throw new Error('a valid module failed compilation');
  requests++;compiled+=rows.length;
}});
console.log(JSON.stringify({requests,compiled}));`;
  // budget: the existing owned-child hang ceiling; completion is asserted by request and module counts.
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--max-old-space-size=96'].filter(Boolean).join(' ') },
    encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(result.status, 0, result.context);
  assert.deepEqual(JSON.parse(result.stdout), { requests: 128, compiled: 8192 });
});
