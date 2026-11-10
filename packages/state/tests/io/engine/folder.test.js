/** @pullboard-test-input source-tree */
/** @pullboard-test-loads packages/state/src/io/engine/numbers.js */
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
import { engineFolderProblems } from '../../../index.js';
import { engineFolderViolations } from '../../../index.js';
import { assignEngineNumbers } from '../../../src/io/engine/numbers.js';
import { readEngineLeaves } from '../../../src/io/engine/numbers.js';
import { runFixtureChild } from '../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';
import { copyPackageSubset } from '../../../../../apps/cli/tests/fixtures/copy.js';

/** The one folder engine leaves live in. */
const E = 'packages/state/src/logic/engines';

test('the repository keeps every engine marker in the state cell engines folder [C7]', () => {
  assert.deepEqual(engineFolderProblems(resolve(import.meta.dirname, '../../../../..')), []);
});

/** Build a real private repository with a move and a separately owned engine declaration. */
function fixture(t, root = mkdtempSync(join(tmpdir(), 'pullboard-engine-folder-'))) {
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, E), { recursive: true });
  mkdirSync(join(root, 'packages', 'sample', 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, E, 'sample-engine.js'), '/** The sample move engine. */\nexport const SAMPLE_ENGINE = 17;\n');
  writeFileSync(join(root, 'src/move.js'), "import { SAMPLE_ENGINE } from '../packages/state/src/logic/engines/sample-engine.js';\nexport function move() { return { operation: 'sample', engine: SAMPLE_ENGINE }; }\n");
  copyPackageSubset(resolve(import.meta.dirname, '../../../../..'), root,
    [...['engine-numbers.js', 'discovery.js'].map(file => ({ path: `src/${file}`, as: `src/${file}` })), { path: `${E}/engine-next.js`, as: `${E}/engine-next.js` }]);
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
  const engine = join(root, E, 'sample-engine.js');
  const bytes = readFileSync(engine);
  const before = moveAt(root, 'src/move.js');
  const registry = readEngineLeaves(join(root, E));
  runFixtureGit(['mv', 'src/move.js', 'packages/sample/src/move.js'], { cwd: root });
  writeFileSync(join(root, 'packages/sample/src/move.js'), "import { SAMPLE_ENGINE } from '../../state/src/logic/engines/sample-engine.js';\nexport function move() { return { operation: 'sample', engine: SAMPLE_ENGINE }; }\n");
  assert.deepEqual(moveAt(root, 'packages/sample/src/move.js'), before);
  assert.deepEqual(before, { operation: 'sample', engine: 17 });
  assert.deepEqual(readFileSync(engine), bytes, 'the engine marker declaration retains every byte');
  assert.deepEqual(readEngineLeaves(join(root, E)), registry);
  assert.deepEqual(registry, [{ file: 'sample-engine.js', name: 'SAMPLE_ENGINE', number: 17 }]);
  assert.deepEqual(engineFolderProblems(root), []);
  assert.deepEqual(assignEngineNumbers(root), { files: [], assigned: [] }, 'moving a landed feature never renumbers its engine');
});

test('a moved or duplicated engine leaf is refused while fixture strings and imports remain allowed [C7]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-private-engine-copy-'));
  fixture(t, root);
  const misplaced = join(root, 'packages/sample/src/sample-engine.js');
  cpSync(join(root, E, 'sample-engine.js'), misplaced);
  assert.match(engineFolderProblems(root)[0].text, /SAMPLE_ENGINE must be declared in its own leaf/u);
  rmSync(misplaced);
  renameSync(join(root, E, 'sample-engine.js'), misplaced);
  assert.equal(readEngineLeaves(join(root, E)).length, 0, 'the broken move really removes the canonical registry entry');
  assert.equal(engineFolderProblems(root)[0].file, 'packages/sample/src/sample-engine.js');
  rmSync(misplaced);
  writeFileSync(join(root, 'packages/sample/src/numbers.js'), 'const SAMPLE_ENGINE = 17; export { SAMPLE_ENGINE };\n');
  assert.equal(engineFolderProblems(root)[0].file, 'packages/sample/src/numbers.js', 'renaming the leaf and separating its export cannot hide the moved marker');
  assert.match(engineFolderProblems(root)[0].text, /SAMPLE_ENGINE must be declared in its own leaf/u);
  writeFileSync(join(root, 'packages/sample/src/numbers.js'), 'const value = 17; export { value as SAMPLE_ENGINE };\n');
  assert.match(engineFolderProblems(root)[0].text, /SAMPLE_ENGINE must be declared in its own leaf/u, 'an exported marker alias cannot hide a relocated engine');
  assert.deepEqual(engineFolderViolations([{ file: 'packages/sample/tests/fixture.js',
    source: "// export const COMMENT_ENGINE = 1;\nconst fixture = 'export const STRING_ENGINE = 2;';\nexport { SAMPLE_ENGINE } from '../../state/src/logic/engines/sample-engine.js';\n" }]), []);
  assert.equal(engineFolderViolations([{ file: 'apps/cli/number.js', source: 'export const HIDDEN_ENGINE = 17;' }]).length, 1);
  for (const kind of ['let', 'var']) assert.equal(engineFolderViolations([{ file: 'apps/cli/number.js',
    source: `${kind} HIDDEN_ENGINE = 17; export { HIDDEN_ENGINE };` }]).length, 1);
  for (const source of ['const harmless = 0, SAMPLE_ENGINE = 17; export { SAMPLE_ENGINE };',
    'const { nested: { SAMPLE_ENGINE } } = source; export { SAMPLE_ENGINE };',
    'const harmless = 0, { nested: { value: SAMPLE_ENGINE = 17 } } = source;',
    'const [harmless, SAMPLE_ENGINE] = source;']) {
    assert.equal(engineFolderViolations([{ file: 'packages/sample/src/numbers.js', source }])[0].text,
      'SAMPLE_ENGINE must be declared in its own leaf in packages/state/src/logic/engines; move the feature without its engine declaration');
  }
  assert.deepEqual(engineFolderViolations([{ file: 'packages/sample/src/consumer.js', source:
    "import { SAMPLE_ENGINE } from '../../state/src/logic/engines/sample-engine.js'; export { SAMPLE_ENGINE } from '../../state/src/logic/engines/sample-engine.js';\nconst value = SAMPLE_ENGINE, other = { SAMPLE_ENGINE };\nconst { value: alias = SAMPLE_ENGINE, SAMPLE_ENGINE: local } = source;\n" }]), []);
});

test('named engine reexports come only from the canonical engine folder [C7]', t => {
  const root = fixture(t);
  const consumer = join(root, 'packages/sample/src/forward.js');
  writeFileSync(join(root, 'packages/sample/src/numbers.js'), 'export const value = 17;\n');
  writeFileSync(consumer, "export { value as SAMPLE_ENGINE } from './numbers.js';\n");
  assert.equal(engineFolderProblems(root)[0].file, 'packages/sample/src/forward.js');
  assert.match(engineFolderProblems(root)[0].text, /SAMPLE_ENGINE must be declared in its own leaf/u);
  writeFileSync(consumer, "export { SAMPLE_ENGINE } from '../../state/src/logic/engines/sample-engine.js';\n");
  assert.deepEqual(engineFolderProblems(root), []);
  for (const target of ['sample', '#sample', './nested/numbers.js']) {
    assert.equal(engineFolderViolations([{ file: 'packages/sample/src/forward.js', source:
      `export { value as SAMPLE_ENGINE } from '${target}';` }]).length, 1);
  }
});

/** Create actual public pure forwarding modules while preserving the original root engine bytes. */
function stateExitFixture(t) {
  const root = fixture(t);
  const canonical = join(root, E, 'exit-rules-engine.js');
  const directory = join(root, 'packages/state/src/logic/engine');
  mkdirSync(directory, { recursive: true });
  writeFileSync(canonical, 'export const EXIT_RULES_ENGINE = 183;\n');
  const metadata = join(directory, 'metadata.js');
  writeFileSync(metadata, 'export { EXIT_RULES_ENGINE } from "../engines/exit-rules-engine.js";\n');
  writeFileSync(join(root, 'packages', 'state', 'light.js'), 'export { EXIT_RULES_ENGINE } from "./src/logic/engine/metadata.js";\n');
  writeFileSync(join(root, 'packages', 'state', 'index.js'), 'export { EXIT_RULES_ENGINE } from "./light.js";\n');
  const consumer = join(root, 'packages/sample/src/exit-rules.js');
  writeFileSync(consumer, 'export { EXIT_RULES_ENGINE } from "../../state/light.js";\n');
  return { root, canonical, metadata, consumer, original: readFileSync(canonical) };
}

test('pure state forwarding preserves the actual root exit engine declaration and public binding [C7,H16]', t => {
  const box = stateExitFixture(t);
  assert.deepEqual(engineFolderProblems(box.root), []);
  const source = `import { EXIT_RULES_ENGINE } from ${JSON.stringify(pathToFileURL(box.consumer).href)}; console.log(EXIT_RULES_ENGINE);`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { cwd: box.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '183');
  assert.deepEqual(readFileSync(box.canonical), box.original, 'no canonical engine declaration is copied, moved or renumbered');
});

for (const fault of ['alias', 'copy', 'cycle', 'cross-cell', 'missing-root']) {
  test(`pure state engine forwarding refuses ${fault} provenance [C7,H16]`, t => {
    const box = stateExitFixture(t);
    if (fault === 'alias') writeFileSync(box.metadata, 'export { SAMPLE_ENGINE as EXIT_RULES_ENGINE } from "../engines/sample-engine.js";\n');
    if (fault === 'copy') writeFileSync(box.metadata, 'export const EXIT_RULES_ENGINE = 183;\n');
    if (fault === 'cycle') writeFileSync(box.metadata, 'export { EXIT_RULES_ENGINE } from "../../../light.js";\n');
    if (fault === 'cross-cell') {
      mkdirSync(join(box.root, 'packages', 'other'), { recursive: true });
      writeFileSync(join(box.root, 'packages', 'other', 'core.js'), 'export { EXIT_RULES_ENGINE } from "../state/src/logic/engines/exit-rules-engine.js";\n');
      writeFileSync(box.metadata, 'export { EXIT_RULES_ENGINE } from "../../../../other/core.js";\n');
    }
    if (fault === 'missing-root') rmSync(box.canonical);
    assert.ok(engineFolderProblems(box.root).some(problem => problem.file === 'packages/state/light.js'
      && problem.text.includes('EXIT_RULES_ENGINE must be declared in its own leaf')), 'the public entry cannot borrow an unproven engine binding');
    if (fault !== 'missing-root') assert.deepEqual(readFileSync(box.canonical), box.original);
  });
}

test('an unassigned engine keeps its placeholder outside a moved package until landing [C7]', t => {
  const root = fixture(t);
  const path = join(root, E, 'pending-engine.js');
  const text = "import { unassignedEngine } from './engine-next.js';\nexport const PENDING_ENGINE = unassignedEngine();\n";
  writeFileSync(path, text);
  assert.deepEqual(engineFolderProblems(root), []);
  assert.equal(readEngineLeaves(join(root, E)).find(leaf => leaf.name === 'PENDING_ENGINE').number, null);
  assert.deepEqual(assignEngineNumbers(root).assigned, [{ name: 'PENDING_ENGINE', number: 18 }]);
  assert.equal(readFileSync(path, 'utf8'), 'export const PENDING_ENGINE = 18;\n');
  assert.equal(readFileSync(join(root, E, 'sample-engine.js'), 'utf8'), '/** The sample move engine. */\nexport const SAMPLE_ENGINE = 17;\n');
});


test('canonical state front door preserves engine identity without accepting copied or renamed declarations [C7,CD60]', t => {
  const root = fixture(t), state = join(root, 'packages/state');
  mkdirSync(state, { recursive: true });
  const front = "export { SAMPLE_ENGINE } from './src/logic/engines/sample-engine.js';\n";
  writeFileSync(join(state, 'index.js'), front);
  const consumer = "export { SAMPLE_ENGINE } from '../../state/index.js';\n";
  writeFileSync(join(root, 'packages/sample/src/forward.js'), consumer);
  assert.deepEqual(engineFolderProblems(root), []);
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e',
    "import { SAMPLE_ENGINE as canonical } from './packages/state/src/logic/engines/sample-engine.js'; import { SAMPLE_ENGINE as forwarded } from './packages/sample/src/forward.js'; if (canonical !== forwarded || forwarded !== 17) process.exit(1);"],
    { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const canonical = { file: `${E}/sample-engine.js`, source: 'export const SAMPLE_ENGINE = 17;' };
  const caller = { file: 'packages/sample/src/forward.js', source: consumer };
  for (const source of ['export const SAMPLE_ENGINE = 17;',
    "export { value as SAMPLE_ENGINE } from '../sample/src/numbers.js';",
    "export { OTHER_ENGINE as SAMPLE_ENGINE } from './src/logic/engines/sample-engine.js';", '']) {
    assert.ok(engineFolderViolations([canonical, { file: 'packages/state/index.js', source }, caller])
      .some(row => row.file === caller.file), 'the caller needs an exact canonical same-name engine forward');
  }
  assert.ok(engineFolderViolations([canonical, { file: 'packages/state/index.js', source: front },
    { ...caller, source: "export { SAMPLE_ENGINE } from '../../state/lookalike.js';" }]).some(row => row.file === caller.file));
  assert.ok(engineFolderViolations([canonical, caller]).some(row => row.file === caller.file), 'a missing state entry remains unproved');
});
