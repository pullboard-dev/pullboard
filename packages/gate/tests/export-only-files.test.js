/** The export-only ratchet refuses a new file of only exports and lets the known ones leave [C7]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXPORT_ONLY_CEILINGS } from '../src/core/export-only-files.js';
import { exportOnly } from '../src/core/export-only-files.js';
import { exportOnlyProblems } from '../src/core/export-only-files.js';

test('a file of one or two export lines is export-only; a front door, an engine leaf or real code is not [C7]', () => {
  assert.equal(exportOnly('src/x.js', "/** Why. */\nexport { a } from '../packages/a/index.js';\n"), true);
  assert.equal(exportOnly('packages/a/src/core/b.js', 'export const B = 1;\nexport const C = 2;\n'), true);
  assert.equal(exportOnly('packages/a/src/core/b.js', 'export const B = 1;\nexport const C = 2;\nexport const D = 3;\n'), false);
  assert.equal(exportOnly('packages/a/src/core/b.js', "import { a } from './a.js';\nexport const B = a;\n"), false);
  assert.equal(exportOnly('packages/a/index.js', "export { a } from './src/core/a.js';\n"), false);
  assert.equal(exportOnly('src/item-notes-engine.js', 'export const ITEM_NOTES_ENGINE = 112;\n'), false);
});

test('a new export-only file is refused and a listed one passes [C7]', () => {
  const sources = [{ file: 'src/new.js', source: 'export const X = 1;\n' }, { file: 'src/old.js', source: 'export const Y = 1;\n' }];
  assert.deepEqual(exportOnlyProblems(sources, ['src/old.js']).map(row => row.path), ['src/new.js']);
});

test('the ceilings list only files that are still export-only, sorted [C7]', () => {
  const root = join(import.meta.dirname, '../../..');
  const { files } = JSON.parse(readFileSync(join(root, EXPORT_ONLY_CEILINGS), 'utf8'));
  assert.deepEqual(files, [...files].sort());
  for (const file of files) assert.equal(exportOnly(file, readFileSync(join(root, file), 'utf8')), true, `${file} left the export-only shape; drop it from ${EXPORT_ONLY_CEILINGS}`);
});
