/** The export-only ratchet refuses a new file of only exports and lets the known ones leave [C7]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXPORT_ONLY_CEILINGS } from '../../../src/logic/export/only.js';
import { exportOnly } from '../../../src/logic/export/only.js';
import { declaredDoorFiles } from '../../../src/logic/export/only.js';
import { exportOnlyProblems } from '../../../src/logic/export/only.js';

test('gate.logic-export-only.a-file-of-one-or-two: a file of one or two export lines is export-only; a front door, an engine leaf or real code is not [C7]', () => {
  assert.equal(exportOnly('src/x.js', "/** Why. */\nexport { a } from '../packages/a/index.js';\n"), true);
  assert.equal(exportOnly('packages/a/src/core/b.js', 'export const B = 1;\nexport const C = 2;\n'), true);
  assert.equal(exportOnly('packages/a/src/core/b.js', 'export const B = 1;\nexport const C = 2;\nexport const D = 3;\n'), false);
  assert.equal(exportOnly('packages/a/src/core/b.js', "import { a } from './a.js';\nexport const B = a;\n"), false);
  assert.equal(exportOnly('packages/a/index.js', "export { a } from './src/core/a.js';\n"), false);
  assert.equal(exportOnly('packages/state/src/logic/engines/item-notes-engine.js', 'export const ITEM_NOTES_ENGINE = 112;\n'), false);
  assert.equal(exportOnly('src/item-notes-engine.js', 'export const ITEM_NOTES_ENGINE = 112;\n'), true, 'no engine leaf comes back to src/');
});

test('gate.logic-export-only.a-new-export-only-file-is: a new export-only file is refused and a listed one passes [C7]', () => {
  const sources = [{ file: 'src/new.js', source: 'export const X = 1;\n' }, { file: 'src/old.js', source: 'export const Y = 1;\n' }];
  assert.deepEqual(exportOnlyProblems(sources, ['src/old.js']).map(row => row.path), ['src/new.js']);
});

test('gate.logic-export-only.the-ceilings-list-only-files-that: clause 1: the ceilings list only files that are still export-only, sorted [C7]', () => {
  const root = join(import.meta.dirname, '../../../../..');
  const { files } = JSON.parse(readFileSync(join(root, EXPORT_ONLY_CEILINGS), 'utf8'));
  assert.deepEqual(files, [...files].sort());
  for (const file of files) assert.equal(exportOnly(file, readFileSync(join(root, file), 'utf8')), true, `${file} left the export-only shape; drop it from ${EXPORT_ONLY_CEILINGS}`);
});

/** An existence check over an in-memory file list. */
function filesExist(...files) {
  return file => files.includes(file);
}

test('gate.logic-export-only.doors-from-folders: declaredDoorFiles returns each cell folder\'s light.js and browser.js that exist, from the folders alone [C7]', () => {
  const folders = ['packages/a', 'packages/b', 'apps/c'];
  const declared = declaredDoorFiles(folders, filesExist('packages/a/light.js', 'packages/a/browser.js', 'packages/b/browser.js', 'packages/b/index.js', 'apps/c/light.js', 'packages/z/light.js'));
  assert.deepEqual([...declared].sort(), ['apps/c/light.js', 'packages/a/browser.js', 'packages/a/light.js', 'packages/b/browser.js']);
  const root = join(import.meta.dirname, '../../../../..');
  const real = declaredDoorFiles(['packages/kernel', 'packages/git', 'packages/queue', 'apps/cli'], file => existsSync(join(root, file)));
  for (const door of ['packages/kernel/light.js', 'packages/kernel/browser.js', 'packages/git/browser.js', 'packages/queue/light.js', 'apps/cli/light.js']) assert.equal(real.has(door), true, `${door} is a door`);
});

test('gate.logic-export-only.a-folder-door-passes-and-no-folder-exempts: a one-export door found in its folder passes; the same file with no door found is refused [C7]', () => {
  const sources = [{ file: 'packages/a/light.js', source: "export { a } from './src/shell/a.js';\n" }, { file: 'packages/a/browser.js', source: "export { b } from './src/core/b.js';\n" }];
  const declared = declaredDoorFiles(['packages/a'], filesExist('packages/a/light.js', 'packages/a/browser.js'));
  assert.deepEqual(exportOnlyProblems(sources, [], declared), []);
  assert.deepEqual(exportOnlyProblems(sources, [], declaredDoorFiles([], filesExist())).map(row => row.path), ['packages/a/light.js', 'packages/a/browser.js']);
  assert.deepEqual(exportOnlyProblems(sources, []).map(row => row.path), ['packages/a/light.js', 'packages/a/browser.js'], 'no third argument keeps the rule exactly');
});
