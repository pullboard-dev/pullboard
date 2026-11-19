/** With gate.receiptMissingCause on, a gate job that printed no receipt names the worker's last output, not the proof list [C7,#9925]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failingParts } from '../../../api/index.js';

const FILES = Array.from({ length: 40 }, (_, index) => `packages/gate/tests/generated-${index}.test.js`);
const LEAD = 'the gate job printed no PULLBOARD_GATE_RECEIPT line (exit 1): ';
const STDERR = ['Error: ENOSPC: no space left on device, write', '    at writeSync (node:fs:900:3)', 'worker stopped: disk full'];
const error = `${LEAD}${JSON.stringify(FILES)}\n${STDERR.join('\n')}`;
const receipt = { status: 1, gate: { green: false, error } };

test('gate.io-receipt-missing-cause.with-the-setting-on-a: clause 1: with the setting on, a worker that exits 1 with stderr and no receipt yields a part holding the last stderr lines [C7]', () => {
  const [part, ...rest] = failingParts(receipt, { receiptMissingCause: true });
  assert.equal(rest.length, 0);
  assert.ok(part.startsWith('gate: the gate job printed no PULLBOARD_GATE_RECEIPT line (exit 1); worker output ended: '));
  for (const line of STDERR) assert.ok(part.includes(line.trim()), `part names ${line}`);
  assert.ok(part.indexOf('worker stopped: disk full') < part.indexOf('proof files:'), 'the worker error leads the file list');
});

test('gate.io-receipt-missing-cause.the-proof-file-list-in: clause 2: the proof file list in that part is cut to its first 5 names plus a count [C7]', () => {
  const [part] = failingParts(receipt, { receiptMissingCause: true });
  assert.ok(part.includes('generated-4.test.js'));
  assert.ok(!part.includes('generated-5.test.js'));
  assert.ok(part.endsWith('(+35 more)'));
});

test('gate.io-receipt-missing-cause.with-the-setting-off-the: clause 3: with the setting off the part text is as before [C7]', () => {
  const [part] = failingParts(receipt);
  assert.deepEqual(failingParts(receipt, { receiptMissingCause: false }), [part]);
  assert.ok(part.startsWith(`gate: ${LEAD}["packages/gate/tests/generated-0.test.js"`));
  assert.ok(part.endsWith(' ...'));
});
