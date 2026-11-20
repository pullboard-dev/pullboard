/** The pure cell verdict key: stable under order, moved by the cell's own files and reached contracts, not by another cell [C7,R38,S10]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellVerdictKey } from '../../src/logic/cell-key.js';

const cell = { files: { 'a/one.js': 'd1', 'a/two.js': 'd2' }, contracts: { gate: 'k1', store: 'k2' } };

test('verify.logic-cell-key.order: clause 1: the same file digests and contract keys in a different order give the same key [C7,R38]', () => {
  const shuffled = { files: { 'a/two.js': 'd2', 'a/one.js': 'd1' }, contracts: { store: 'k2', gate: 'k1' } };
  assert.equal(cellVerdictKey(cell), cellVerdictKey(shuffled));
  assert.match(cellVerdictKey(cell), /^[a-f0-9]{64}$/u);
});

test('verify.logic-cell-key.change: clause 2: changing one file digest of the cell, or one reached contract key, changes the key [C7,R38]', () => {
  const base = cellVerdictKey(cell);
  assert.notEqual(cellVerdictKey({ ...cell, files: { ...cell.files, 'a/two.js': 'd2x' } }), base);
  assert.notEqual(cellVerdictKey({ ...cell, contracts: { ...cell.contracts, store: 'k2x' } }), base);
});

test('verify.logic-cell-key.other-cell: clause 3: changing a file of another cell, passed in no input, leaves this cell\'s key the same [C7,R38]', () => {
  const other = { files: { 'b/one.js': 'e1' }, contracts: {} };
  const before = cellVerdictKey(cell), otherBefore = cellVerdictKey(other);
  other.files['b/one.js'] = 'e1x';
  assert.equal(cellVerdictKey(cell), before);
  assert.notEqual(cellVerdictKey(other), otherBefore);
});
