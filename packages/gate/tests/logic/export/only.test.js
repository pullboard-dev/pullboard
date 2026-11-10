/** The export-only ratchet refuses a new file of only exports and lets the known ones leave [C7]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXPORT_ONLY_CEILINGS } from '../../../src/logic/export/only.js';
import { exportOnly } from '../../../src/logic/export/only.js';
import { declaredDoorFiles } from '../../../src/logic/export/only.js';
import { exportOnlyProblems } from '../../../src/logic/export/only.js';

test('a file of one or two export lines is export-only; a front door, an engine leaf or real code is not [C7]', () => {
  assert.equal(exportOnly('src/x.js', "/** Why. */\nexport { a } from '../packages/a/index.js';\n"), true);
  assert.equal(exportOnly('packages/a/src/core/b.js', 'export const B = 1;\nexport const C = 2;\n'), true);
  assert.equal(exportOnly('packages/a/src/core/b.js', 'export const B = 1;\nexport const C = 2;\nexport const D = 3;\n'), false);
  assert.equal(exportOnly('packages/a/src/core/b.js', "import { a } from './a.js';\nexport const B = a;\n"), false);
  assert.equal(exportOnly('packages/a/index.js', "export { a } from './src/core/a.js';\n"), false);
  assert.equal(exportOnly('packages/state/src/logic/engines/item-notes-engine.js', 'export const ITEM_NOTES_ENGINE = 112;\n'), false);
  assert.equal(exportOnly('src/item-notes-engine.js', 'export const ITEM_NOTES_ENGINE = 112;\n'), true, 'no engine leaf comes back to src/');
});

test('a new export-only file is refused and a listed one passes [C7]', () => {
  const sources = [{ file: 'src/new.js', source: 'export const X = 1;\n' }, { file: 'src/old.js', source: 'export const Y = 1;\n' }];
  assert.deepEqual(exportOnlyProblems(sources, ['src/old.js']).map(row => row.path), ['src/new.js']);
});

test('the ceilings list only files that are still export-only, sorted [C7]', () => {
  const root = join(import.meta.dirname, '../../../../..');
  const { files } = JSON.parse(readFileSync(join(root, EXPORT_ONLY_CEILINGS), 'utf8'));
  assert.deepEqual(files, [...files].sort());
  for (const file of files) assert.equal(exportOnly(file, readFileSync(join(root, file), 'utf8')), true, `${file} left the export-only shape; drop it from ${EXPORT_ONLY_CEILINGS}`);
});

/** A reader over an in-memory plan: an index naming one shard that declares the given door keys. */
function planReader(doors) {
  const files = { 'packages/codemap/data/plan/cells.json': JSON.stringify({ cells: [{ file: 'packages/codemap/data/plan/01-a.json' }] }), 'packages/codemap/data/plan/01-a.json': JSON.stringify(doors) };
  return file => { if (!(file in files)) throw new Error('missing ' + file); return files[file]; };
}

test('a one-export door the plan declares passes; the same file undeclared is refused [C7]', () => {
  const sources = [{ file: 'packages/a/core.js', source: "export { a } from './src/shell/a.js';\n" }, { file: 'packages/a/pure.js', source: "export { b } from './src/core/b.js';\n" }];
  const declared = declaredDoorFiles(planReader({ lightFrontDoor: 'packages/a/core.js', pureDoor: 'packages/a/pure.js' }));
  assert.deepEqual([...declared].sort(), ['packages/a/core.js', 'packages/a/pure.js']);
  assert.deepEqual(exportOnlyProblems(sources, [], declared), []);
  assert.deepEqual(exportOnlyProblems(sources, [], declaredDoorFiles(planReader({}))).map(row => row.path), ['packages/a/core.js', 'packages/a/pure.js']);
  assert.deepEqual(exportOnlyProblems(sources, []).map(row => row.path), ['packages/a/core.js', 'packages/a/pure.js'], 'no third argument keeps the rule exactly');
});

test('a declared pureFrontDoor passes, and a malformed or missing plan exempts nothing [C7]', () => {
  const sources = [{ file: 'packages/a/core.js', source: "export { a } from './src/core/a.js';\n" }];
  assert.deepEqual(exportOnlyProblems(sources, [], declaredDoorFiles(planReader({ pureFrontDoor: 'packages/a/core.js' }))), []);
  assert.equal(declaredDoorFiles(() => '{not json').size, 0);
  assert.equal(declaredDoorFiles(() => { throw new Error('no plan'); }).size, 0);
});
