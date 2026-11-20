/** The import-edge diff returns exactly the added edges and never matches modules by basename [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addedImportEdges } from '../../src/logic/import-edges.js';

test('gate.logic-import-edges.given-two-import-graphs-the: clause 1: given two import graphs the pure function returns exactly the added edges [C7]', () => {
  const before = { 'a.js': ['b.js', 'c.js'], 'b.js': [] };
  const after = { 'a.js': ['b.js', 'c.js', 'd.js'], 'b.js': ['c.js'], 'e.js': ['a.js'] };
  assert.deepEqual(addedImportEdges(before, after), [
    { from: 'a.js', to: 'd.js' },
    { from: 'b.js', to: 'c.js' },
    { from: 'e.js', to: 'a.js' },
  ]);
  assert.deepEqual(addedImportEdges(after, before), []);
  assert.deepEqual(addedImportEdges(before, before), []);
});

test('gate.logic-import-edges.two-modules-with-the-same: clause 2: two modules with the same basename in different folders are never matched as one [C7]', () => {
  const before = { 'src/a/index.js': ['src/a/util.js'] };
  const after = { 'src/a/index.js': ['src/a/util.js', 'src/b/util.js'], 'src/b/index.js': ['src/a/util.js'] };
  assert.deepEqual(addedImportEdges(before, after), [
    { from: 'src/a/index.js', to: 'src/b/util.js' },
    { from: 'src/b/index.js', to: 'src/a/util.js' },
  ]);
});
