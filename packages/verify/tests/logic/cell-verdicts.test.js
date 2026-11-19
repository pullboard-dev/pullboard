/** The pure per-cell verdict store: recording returns a new store, a verdict is reused only under its key, cells stay apart [C7,R38,S10]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellVerdict } from '../../src/logic/cell-verdicts.js';
import { recordCellVerdict } from '../../src/logic/cell-verdicts.js';

test('verify.logic-cell-verdicts.record-pure: clause 1: recordCellVerdict(store, cell, key, verdict) returns a new store and leaves the given store unchanged [C7,R38]', () => {
  const store = { gate: { key: 'k1', verdict: 'pass' } };
  const next = recordCellVerdict(store, 'store', 'k2', 'pass');
  assert.notEqual(next, store);
  assert.deepEqual(store, { gate: { key: 'k1', verdict: 'pass' } });
  assert.deepEqual(next.store, { key: 'k2', verdict: 'pass' });
  assert.deepEqual(recordCellVerdict(store, 'gate', 'k3', 'fail').gate, { key: 'k3', verdict: 'fail' });
  assert.deepEqual(store.gate, { key: 'k1', verdict: 'pass' });
});

test('verify.logic-cell-verdicts.same-key: clause 2: cellVerdict(store, cell, key) returns the recorded verdict for the same key, and null for a changed key of that cell or a cell never recorded [C7,R38]', () => {
  const store = recordCellVerdict({}, 'gate', 'k1', 'pass');
  assert.equal(cellVerdict(store, 'gate', 'k1'), 'pass');
  assert.equal(cellVerdict(store, 'gate', 'k1x'), null);
  assert.equal(cellVerdict(store, 'store', 'k1'), null);
  assert.equal(cellVerdict(store, 'constructor', 'k1'), null);
});

test('verify.logic-cell-verdicts.other-cells: clause 3: recording a verdict for one cell leaves every other cell\'s verdict as it was [C7,R38]', () => {
  const base = recordCellVerdict(recordCellVerdict({}, 'gate', 'k1', 'pass'), 'store', 'k2', 'fail');
  const next = recordCellVerdict(base, 'verify', 'k3', 'pass');
  assert.equal(cellVerdict(next, 'gate', 'k1'), 'pass');
  assert.equal(cellVerdict(next, 'store', 'k2'), 'fail');
  assert.equal(cellVerdict(next, 'verify', 'k3'), 'pass');
  assert.equal(next.gate, base.gate);
  assert.equal(next.store, base.store);
});
