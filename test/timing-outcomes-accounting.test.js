/** Strict waiver accounting keeps unknown output visible [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatSuiteTiming,
  timingAccountingOutput,
  timingAccountingStages,
} from '../src/run-timing.js';
import { formatTestOutcomes } from '../src/test-outcomes.js';

const id = '12345678-1234-1234-1234-123456789abc';
const foreign = '87654321-1234-1234-1234-123456789abc';
const source = { head: 'a'.repeat(40), tree: 'b'.repeat(40) };
const frame = { version: 1, id, ...source, node: process.versions.node, full: false,
  wallMs: 3, selectionMs: null, setupMs: null, shards: [], compareMs: null };
const timing = formatSuiteTiming(frame);
const rows = [{ file: 'test/red.test.js', name: 'known failure', passed: false, skipped: false },
  { file: 'test/green.test.js', name: 'known pass', passed: true, skipped: false }];
const outcomes = formatTestOutcomes(id, rows);
const tap = 'TAP version 13\nnot ok 1 - known failure\n1..1\n# fail 1\n';

test('canonical native outcomes leave the strict TAP account only after source-bound timing [C7,H16]', () => {
  const raw = tap + outcomes + timing;
  assert.equal(timingAccountingOutput(raw, id, source), tap);
  assert.equal(raw, tap + outcomes + timing, 'raw proof bytes remain intact');
  for (const invalid of ['', timing + timing, formatSuiteTiming({ ...frame, id: foreign }),
    formatSuiteTiming({ ...frame, head: 'c'.repeat(40) }), '# pullboard suite timing {broken}\n']) {
    const value = tap + outcomes + invalid;
    assert.equal(timingAccountingOutput(value, id, source), value, 'unbound outcomes remain visible');
  }
});

test('duplicate malformed foreign and noncanonical outcomes remain visible to waiver accounting [C7,H16]', () => {
  const one = formatTestOutcomes(id, [rows[0]]);
  const broken = [one + one,
    '# pullboard test outcomes {broken}\n',
    one.replace('"version":1', '"version":2'),
    one.replace('"version":1', '"version":1,"extra":true'),
    one.replace('test/red.test.js', '../red.test.js'),
    one.replace('"version":1', '"version": 1'),
    formatTestOutcomes(foreign, [rows[0]])];
  for (const invalid of broken) {
    assert.equal(timingAccountingOutput(tap + invalid + timing, id, source), tap + invalid);
  }
  const unknown = '# unexplained failing producer\n';
  assert.equal(timingAccountingOutput(tap + outcomes + timing + unknown, id, source), tap + unknown);
});

test('each pipeline component independently authenticates its diagnostic projection [C7,H16]', () => {
  const wrongTiming = formatSuiteTiming({ ...frame, tree: 'c'.repeat(40) });
  const raw = [{ status: 1, output: tap + outcomes + timing,
    pipeline: [{ status: 1, output: tap + outcomes + wrongTiming }] }];
  const view = timingAccountingStages(raw, id, source);
  assert.equal(view[0].output, tap);
  assert.equal(view[0].pipeline[0].output, raw[0].pipeline[0].output);
  assert.equal(raw[0].output, tap + outcomes + timing);
  assert.equal(raw[0].pipeline[0].output, tap + outcomes + wrongTiming);
});
