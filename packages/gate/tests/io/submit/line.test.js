import test from 'node:test';
import assert from 'node:assert/strict';
import { receiptLine as cellsReceiptLine } from '../../../../git/index.js';
import { receiptLine as gateReceiptLine } from '../../../index.js';

/** A reused cells receipt as the check-receipt store writes it: it has no runner slot, since nothing ran. */
const reused = { kind: 'cells', id: 'r1', tree: 'a'.repeat(40), by: 'core-1', at: '2026-11-01T00:00:00.000Z' };

test('submit cites a reused cells receipt with the check-receipt line, which needs no slot [C7,D3]', () => {
  assert.match(cellsReceiptLine(reused), /^cells check reused receipt r1 for tree aaaaaaaaaaaa/u);
  assert.throws(() => gateReceiptLine(reused), TypeError, 'the gate line reads a runner slot a cells receipt never has');
});
