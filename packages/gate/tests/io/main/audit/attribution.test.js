/** Canonical receipt-field validation is a pure schema control, not fabricated execution evidence [C7,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { receiptBody } from '../../../../heavy.js';
import { receiptFields } from '../../../../heavy.js';

/** Explicit synthetic parser input has no native receipt file and cannot authorize a gate event. */
function input() {
  return { version: 1, id: '11111111-1111-4111-8111-111111111111', kind: 'land',
    tree: 'a'.repeat(40), head: 'b'.repeat(40), main: 'c'.repeat(40), command: 'd'.repeat(64),
    green: false, failures: [{ file: 'test/actual.test.js', name: 'an actual named case' }],
    load: { average: [0, 0, 0], cpus: 1, freeMB: 4096 }, at: '2026-10-27T12:00:00.000Z' };
}
/** Equal file sets can still be explicitly incomplete when executor cleanup remains unverified. */
function collection() {
  const files = ['test/actual.test.js', 'test/other.test.js'];
  const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return { version: 1, mode: 'all', full: true, files, batchId: '22222222-2222-4222-8222-222222222222', complete: true,
    plannedFiles: 2, completedFiles: 2, planDigest: digest, completedDigest: digest };
}

test('gate.io-main-audit-attribution.legacy-native-gate-receipt-bytes-remain: legacy native gate receipt bytes remain exact when collection is absent [C7,H16]', () => {
  const old = input();
  assert.equal(receiptBody(old), JSON.stringify(old) + '\n');
  assert.equal(Object.hasOwn(receiptFields(old), 'collection'), false);
});

test('gate.io-main-audit-attribution.complete-red-coverage-remains-red-and: complete red coverage remains red and false may retain equal observed file sets [C7,H16]', () => {
  const red = receiptFields({ ...input(), collection: collection() });
  assert.equal(red.collection.complete, true); assert.equal(red.green, false);
  const partial = receiptFields({ ...input(), collection: { ...collection(), complete: false } });
  assert.equal(partial.collection.complete, false);
  assert.equal(receiptFields({ ...input(), collection: { ...collection(), batchId: 'coordinator-batch_1' } }).collection.batchId, 'coordinator-batch_1');
  assert.deepEqual(receiptFields(JSON.parse(receiptBody(red))), red);
});

test('gate.io-main-audit-attribution.malformed-zero-mismatched-and-wrong-kind: malformed, zero, mismatched and wrong-kind collection claims are rejected rather than dropped [C7,H16]', () => {
  for (const bad of [null, [], {}, { ...collection(), complete: 'true' }, { ...collection(), plannedFiles: 0, completedFiles: 0 },
    { ...collection(), completedFiles: 1 }, { ...collection(), completedDigest: 'f'.repeat(64) },
    { ...collection(), plannedFiles: 1.5 }, { ...collection(), completedFiles: -1 },
    { ...collection(), batchId: '../not-an-id' }]) {
    assert.equal(receiptFields({ ...input(), collection: bad }), null);
  }
  assert.equal(receiptFields({ ...input(), kind: 'gate', collection: collection() }), null);
});


test('gate.io-main-audit-attribution.explicit-selected-plans-and-full-scope: explicit selected plans and full scope are validated without implying green [C7,H16]', () => {
  const selected = collection();
  const red = receiptFields({ ...input(), collection: selected });
  assert.equal(red.collection.full, true);
  assert.deepEqual(red.collection.files, selected.files);
  assert.equal(red.green, false);
  const narrow = receiptFields({ ...input(), collection: { ...selected, full: false } });
  assert.equal(narrow.collection.full, false); // A complete selected run is not necessarily a full-suite audit.
  const partial = receiptFields({ ...input(), collection: { ...selected, complete: false, completedFiles: 1,
    completedDigest: createHash('sha256').update(JSON.stringify([selected.files[0]])).digest('hex') } });
  assert.equal(partial.collection.complete, false);
  for (const delta of [ { full: undefined }, { full: 'true' }, { files: undefined }, { files: null },
    { files: [...selected.files].reverse() }, { files: [selected.files[0], selected.files[0]] },
    { files: ['test/../actual.test.js', selected.files[1]] }, { files: ['/test/actual.test.js', selected.files[1]] },
    { files: ['C:/test/actual.test.js', selected.files[1]] }, { files: ['./test/actual.test.js', selected.files[1]] },
    { files: ['test//actual.test.js', selected.files[1]] }, { files: ['test/actual\n.test.js', selected.files[1]] },
    { files: Array(100001).fill('test/x.js') }, { plannedFiles: 1 }, { planDigest: 'f'.repeat(64) } ]) {
    assert.equal(receiptFields({ ...input(), collection: { ...selected, ...delta } }), null);
  }
  const { full, ...missingFull } = selected;
  const { files, ...missingFiles } = selected;
  assert.equal(receiptFields({ ...input(), collection: missingFull }), null);
  assert.equal(receiptFields({ ...input(), collection: missingFiles }), null);
});
