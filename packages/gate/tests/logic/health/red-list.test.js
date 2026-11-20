/** @pullboard-test-input source-cell gate */
/** The gate state red list is redNow over the recorded ledger rows, and gate health reads no other source [U152,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateHealthLines } from '../../../heavy.js';
import { gateHealthSummary } from '../../../heavy.js';
import { redNow } from '../../../heavy.js';

const row = (file, status, at, inputKey = 'k1', context = 'ctx') => ({ file, command: 'proof', context, status, inputKey, commit: 'c'.repeat(40), receipt: `r${at}`, origin: 'run', at });
const window = { records: [], spans: [], since: 0, now: 1_000_000 };

test('gate.logic-health-red-list.the-gate-state-red-list: clause 1: the gate state red list equals redNow over the recorded rows [U152,C7]', () => {
  const rows = [row('a.test.js', 'fail', 10), row('b.test.js', 'fail', 11), row('b.test.js', 'pass', 20, 'k2'), row('c.test.js', 'pass', 5), row('d.test.js', 'fail', 7, 'k9', 'linux')];
  const summary = gateHealthSummary({ ...window, ledgerRows: rows });
  assert.deepEqual(summary.reds, redNow(rows));
  assert.deepEqual(summary.reds.map(red => red.file), ['a.test.js', 'd.test.js']);
  const text = gateHealthLines(summary, '2h').join('\n');
  assert.match(text, /red now, from the ledger \(2\):/u);
  assert.match(text, /a\.test\.js \[ctx\]/u);
  assert.match(text, /d\.test\.js \[linux\]/u);
});

test('gate.logic-health-red-list.with-no-ledger-rows-the: clause 1: with no ledger rows the red list is empty, whatever the gate records say [U152,C7]', () => {
  const failing = { id: 'j1', state: 'red', at: new Date(100).toISOString(), completedAt: new Date(200).toISOString(), item: '1', error: { code: 'GATE_RED' } };
  const summary = gateHealthSummary({ ...window, records: [failing] });
  assert.deepEqual(summary.reds, []);
  assert.doesNotMatch(gateHealthLines(summary, '2h').join('\n'), /red now/u);
});
