/** A red criterion or proof refuses a concurrent submit and retains both independent raw receipts [V4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { project } from '../../../tests/fixtures/submit/parallel.js';
import { submit } from '../../../tests/fixtures/submit/parallel.js';

for (const role of ['criterion', 'proof']) {
  test(`a red ${role} refuses submit and retains both independent raw receipts [V4,C7]`, t => {
    const { box } = project(t, 25);
    const { result, receipts } = submit(box, `fail-${role}`);
    assert.notEqual(result.code, 0, result.out);
    assert.match(result.err + result.out, /GATE_RED/u);
    assert.equal(receipts.length, 2, 'the passing sibling also finishes and records its result');
    assert.deepEqual(receipts.map(receipt => receipt.exitCode).toSorted(), [0, 1]);
    assert.equal(new Set(receipts.map(receipt => receipt.id)).size, 2);
  });
}
