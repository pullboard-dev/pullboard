/** Every receipt and landing line reports reuse hits, misses and keyless files with the top keyless reason (#5839) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ledgerFromOutput } from '../../../../index.js';
import { formatCacheRows } from '../../../../src/io/test/account.js';
import { cacheProfile } from '../../../../src/io/test/account.js';
import { ledgerLine } from '../../../../src/io/test/account.js';
import { renderTestSummary } from '../../../../src/io/test/summary.js';

const HOOK = 'no key: non-literal dynamic import in reached file apps/cli/src/io/hook/static.js';

/**
 * The 12 Nov 02:03Z landing candidate's log, as its rows read (landing 8d6a5100, candidate 95b6a58f, candidate-1.log):
 * 125 files ran, every one with no key for the same reason, between the run's own TAP lines.
 */
function candidateLog() {
  const lines = ['main facts cache evicted 1 stale entries'];
  for (let index = 0; index < 125; index += 1) {
    lines.push(`# pullboard test cache ${JSON.stringify({ file: `apps/cli/tests/io/case-${index}.test.js`, outcome: 'ran', key: null, missed: HOOK })}`);
  }
  lines.push('TAP version 13', 'ok 1 - apps/cli/tests/io/case-0.test.js', '# pass 125', '# fail 0');
  return `${lines.join('\n')}\n`;
}

test('clause 1: replaying the 02:03Z landing candidate prints 125 keyless with reason non-literal dynamic import in apps/cli/src/io/hook/static.js [C7]', () => {
  assert.equal(ledgerFromOutput(candidateLog()),
    'ledger: 0 hits, 0 misses, 125 keyless (non-literal dynamic import in apps/cli/src/io/hook/static.js)');
});

test('clause 1: the ledger counts hits, keyed misses and keyless files apart, naming the most common keyless reason [C7]', () => {
  const rows = [
    { file: 'a.test.js', outcome: 'reused', key: 'k1', missed: null },
    { file: 'b.test.js', outcome: 'ran', key: 'k2', missed: 'import lib/x.js' },
    { file: 'c.test.js', outcome: 'ran', key: null, missed: 'no key: unresolved package import in reached file src/y.js' },
    { file: 'd.test.js', outcome: 'ran', key: null, missed: 'no key: a reached module may create CommonJS imports in reached file src/z.js' },
    { file: 'e.test.js', outcome: 'ran', key: null, missed: 'no key: unresolved package import in reached file src/y.js' },
  ];
  assert.equal(ledgerLine(rows), 'ledger: 1 hits, 1 misses, 3 keyless (unresolved package import in src/y.js)');
  assert.equal(ledgerLine(rows.slice(0, 2)), 'ledger: 1 hits, 1 misses, 0 keyless');
  assert.equal(ledgerFromOutput('TAP version 13\nok 1 - x\n'), null, 'a run with no per-file account says none, never zero');
});

test('clause 1: a run prints the ledger line, its profile keeps it, and the rendered summary shows it [C7]', () => {
  const rows = [{ file: 'a.test.js', outcome: 'ran', key: null, missed: HOOK }];
  const output = formatCacheRows(rows);
  assert.match(output, /^# ledger: 0 hits, 0 misses, 1 keyless \(non-literal dynamic import in apps\/cli\/src\/io\/hook\/static\.js\)$/mu);
  assert.equal(cacheProfile(output).testCache.ledger, 'ledger: 0 hits, 0 misses, 1 keyless (non-literal dynamic import in apps/cli/src/io/hook/static.js)');
  const rendered = renderTestSummary({ counts: { passed: 1, failed: 0, skipped: 0 }, cache: 'test cache: 1 files, 0 reused, 1 ran; top missed inputs: none',
    ledger: ledgerFromOutput(output), failures: [], logPath: '/x' });
  assert.match(rendered, /^ledger: 0 hits, 0 misses, 1 keyless /mu);
});
