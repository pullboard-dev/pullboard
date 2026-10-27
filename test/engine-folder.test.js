/** @pullboard-test-input source-tree */
/** @pullboard-test-loads src/engine-numbers.js */
/** A package move preserves the engine folder, identities and landing placeholders [C7]. */
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { engineFolderProblems } from '../src/engine-folder.js';
import { engineFolderViolations } from '../src/engine-folder.js';
import { assignEngineNumbers } from '../src/engine-numbers.js';
import { readEngineLeaves } from '../src/engine-numbers.js';
import { runFixtureChild } from './fixture-child.js';
import { runFixtureGit } from './fixture-child.js';

test('the repository keeps historical engine markers in its existing src folder [C7]', () => {
  assert.deepEqual(engineFolderProblems(resolve(import.meta.dirname, '..')), []);
});

/** Build a real private repository with a move and a separately owned engine declaration. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-engine-folder-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'packages', 'sample', 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, 'src', 'sample-engine.js'), '/** The sample move engine. */\nexport const SAMPLE_ENGINE = 17;\n');
  writeFileSync(join(root, 'src', 'move.js'), "import { SAMPLE_ENGINE } from './sample-engine.js';\nexport function move() { return { operation: 'sample', engine: SAMPLE_ENGINE }; }\n");
  for (const file of ['engine-numbers.js', 'engine-next.js', 'discovery.js']) cpSync(new URL(`../src/${file}`, import.meta.url), join(root, 'src', file));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root });
  runFixtureGit(['add', '.'], { cwd: root });
  return root;
}

/** Execute the fixture's real moved move without importing fixture modules into the test worker. */
function moveAt(root, path) {
  const url = pathToFileURL(join(root, path)).href;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', `import { move } from ${JSON.stringify(url)}; console.log(JSON.stringify(move()));`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('moving a fixture package keeps its move engine number and marker in the one folder [C7]', t => {
  const root = fixture(t);
  const engine = join(root, 'src', 'sample-engine.js');
  const bytes = readFileSync(engine);
  const before = moveAt(root, 'src/move.js');
  const registry = readEngineLeaves(join(root, 'src'));
  runFixtureGit(['mv', 'src/move.js', 'packages/sample/src/move.js'], { cwd: root });
  writeFileSync(join(root, 'packages', 'sample', 'src', 'move.js'), "import { SAMPLE_ENGINE } from '../../../src/sample-engine.js';\nexport function move() { return { operation: 'sample', engine: SAMPLE_ENGINE }; }\n");
  assert.deepEqual(moveAt(root, 'packages/sample/src/move.js'), before);
  assert.deepEqual(before, { operation: 'sample', engine: 17 });
  assert.deepEqual(readFileSync(engine), bytes, 'the engine marker declaration retains every byte');
  assert.deepEqual(readEngineLeaves(join(root, 'src')), registry);
  assert.deepEqual(registry, [{ file: 'sample-engine.js', name: 'SAMPLE_ENGINE', number: 17 }]);
  assert.deepEqual(engineFolderProblems(root), []);
  assert.deepEqual(assignEngineNumbers(root), { files: [], assigned: [] }, 'moving a landed feature never renumbers its engine');
});

test('a moved or duplicated engine leaf is refused while fixture strings and imports remain allowed [C7]', t => {
  const root = fixture(t);
  const misplaced = join(root, 'packages', 'sample', 'src', 'sample-engine.js');
  cpSync(join(root, 'src', 'sample-engine.js'), misplaced);
  assert.match(engineFolderProblems(root)[0].text, /SAMPLE_ENGINE must stay in src\//u);
  rmSync(misplaced);
  renameSync(join(root, 'src', 'sample-engine.js'), misplaced);
  assert.equal(readEngineLeaves(join(root, 'src')).length, 0, 'the broken move really removes the canonical registry entry');
  assert.equal(engineFolderProblems(root)[0].file, 'packages/sample/src/sample-engine.js');
  rmSync(misplaced);
  writeFileSync(join(root, 'packages', 'sample', 'src', 'numbers.js'), 'const SAMPLE_ENGINE = 17; export { SAMPLE_ENGINE };\n');
  assert.equal(engineFolderProblems(root)[0].file, 'packages/sample/src/numbers.js', 'renaming the leaf and separating its export cannot hide the moved marker');
  assert.match(engineFolderProblems(root)[0].text, /SAMPLE_ENGINE must stay in src\//u);
  writeFileSync(join(root, 'packages', 'sample', 'src', 'numbers.js'), 'const value = 17; export { value as SAMPLE_ENGINE };\n');
  assert.match(engineFolderProblems(root)[0].text, /SAMPLE_ENGINE must stay in src\//u, 'an exported marker alias cannot hide a relocated engine');
  assert.deepEqual(engineFolderViolations([{ file: 'packages/sample/tests/fixture.js',
    source: "// export const COMMENT_ENGINE = 1;\nconst fixture = 'export const STRING_ENGINE = 2;';\nexport { SAMPLE_ENGINE } from '../../../src/sample-engine.js';\n" }]), []);
  assert.equal(engineFolderViolations([{ file: 'apps/cli/number.js', source: 'export const HIDDEN_ENGINE = 17;' }]).length, 1);
  for (const kind of ['let', 'var']) assert.equal(engineFolderViolations([{ file: 'apps/cli/number.js',
    source: `${kind} HIDDEN_ENGINE = 17; export { HIDDEN_ENGINE };` }]).length, 1);
  for (const source of ['const harmless = 0, SAMPLE_ENGINE = 17; export { SAMPLE_ENGINE };',
    'const { nested: { SAMPLE_ENGINE } } = source; export { SAMPLE_ENGINE };',
    'const harmless = 0, { nested: { value: SAMPLE_ENGINE = 17 } } = source;',
    'const [harmless, SAMPLE_ENGINE] = source;']) {
    assert.equal(engineFolderViolations([{ file: 'packages/sample/src/numbers.js', source }])[0].text,
      'SAMPLE_ENGINE must stay in src/ with the engine leaves; move the feature without its engine declaration');
  }
  assert.deepEqual(engineFolderViolations([{ file: 'packages/sample/src/consumer.js', source:
    "import { SAMPLE_ENGINE } from '../../../src/sample-engine.js'; export { SAMPLE_ENGINE } from '../../../src/sample-engine.js';\nconst value = SAMPLE_ENGINE, other = { SAMPLE_ENGINE };\nconst { value: alias = SAMPLE_ENGINE, SAMPLE_ENGINE: local } = source;\n" }]), []);
});

test('an unassigned engine keeps its placeholder outside a moved package until landing [C7]', t => {
  const root = fixture(t);
  const path = join(root, 'src', 'pending-engine.js');
  const text = "import { unassignedEngine } from './engine-next.js';\nexport const PENDING_ENGINE = unassignedEngine();\n";
  writeFileSync(path, text);
  assert.deepEqual(engineFolderProblems(root), []);
  assert.equal(readEngineLeaves(join(root, 'src')).find(leaf => leaf.name === 'PENDING_ENGINE').number, null);
  assert.deepEqual(assignEngineNumbers(root).assigned, [{ name: 'PENDING_ENGINE', number: 18 }]);
  assert.equal(readFileSync(path, 'utf8'), 'export const PENDING_ENGINE = 18;\n');
  assert.equal(readFileSync(join(root, 'src', 'sample-engine.js'), 'utf8'), '/** The sample move engine. */\nexport const SAMPLE_ENGINE = 17;\n');
});
