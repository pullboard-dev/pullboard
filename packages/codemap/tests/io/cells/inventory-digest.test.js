/** @pullboard-test-input source-cell codemap */
/** The inventory code digest takes its file list as an argument [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { inventoryCodeDigest } from '../../../index.js';

const CELLS = fileURLToPath(new URL('../../../src/io/cells/', import.meta.url));
const TODAY = ['../../cell/lint/inventory.js', '../../module/imports.js', './cache.js']
  .map(path => fileURLToPath(new URL(path, `file://${CELLS}scripts/`)));

/** Three small files in a private fixture folder, returning its root and a way to rewrite one. */
function folder() {
  const fixture = privateFixtureFiles('inventory-digest-');
  const names = ['a.js', 'b.js', 'c.js'];
  names.forEach((name, index) => fixture.write(name, `export const n = ${index};\n`));
  return { root: fixture.root, files: names.map(name => join(fixture.root, name)), write: fixture.write };
}

test('codemap.inventory-digest.the-digest-takes-the-file: clause 1: the digest takes the file list and gives today\'s value for today\'s three files [C7]', () => {
  assert.equal(inventoryCodeDigest(TODAY), inventoryCodeDigest());
  assert.equal(typeof inventoryCodeDigest(), 'string');
});

test('codemap.inventory-digest.the-digest-changes-when-one: clause 1: the digest changes when one file\'s bytes change and not otherwise [C7]', () => {
  const { root, files, write } = folder();
  const before = inventoryCodeDigest(files, root);
  assert.equal(inventoryCodeDigest(files, root), before);
  write('b.js', 'export const n = 99;\n');
  assert.notEqual(inventoryCodeDigest(files, root), before);
});
