/** Test outcome rows record how a case failed, so a clause's base run can tell an assertion from a load error [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { runClauseBaseComparison } from '../../../index.js';
import { receiptFields } from '../../../index.js';
import { testOutcomeCollector } from '../../../index.js';
import { testOutcomeFields } from '../../../index.js';

/** Feed the collector events shaped as node:test emits them (captured from a real run) and return its rows. */
function collect(events) {
  const root = '/repo';
  const collector = testOutcomeCollector(root);
  for (const [type, file, name, error] of events) {
    collector.observe({ type, data: { file: `${root}/${file}`, name, details: { type: 'test', error } } });
  }
  return collector.finish(true, events.length);
}

test('gate.io-test-failure-kinds.an-assertion-failure-is-recorded-as: clause 1: an assertion failure is recorded as assertion, a load error as error [C7]', () => {
  const failed = (cause) => ({ message: 'x', failureType: 'testCodeFailure', cause });
  const rows = collect([
    ['test:fail', 'a.test.js', 'asserts', failed({ code: 'ERR_ASSERTION', name: 'AssertionError' })],
    ['test:fail', 'a.test.js', 'throws', failed(new Error('boom'))],
    ['test:pass', 'a.test.js', 'ok'],
    ['test:fail', 'b.test.js', '/repo/b.test.js', failed({})],
  ]);
  const by = name => rows.find(row => row.name === name);
  assert.equal(by('asserts').failure, 'assertion');
  assert.equal(by('throws').failure, 'error');
  assert.equal(by('ok').failure, undefined);
  assert.equal(rows.find(row => row.file === 'b.test.js').failure, 'error');
});

test('gate.io-test-failure-kinds.a-receipt-keeps-the-failure-kinds: clause 2: a receipt keeps the failure kinds of its outcomes [C7]', () => {
  const testOutcomes = [{ file: 'test/a.test.js', name: 'x', passed: false, skipped: false, failure: 'assertion' }];
  const receipt = receiptFields({ version: 1, id: '11111111-1111-4111-8111-111111111111', kind: 'main-red',
    tree: 'a'.repeat(40), head: 'b'.repeat(40), main: 'c'.repeat(40), command: 'd'.repeat(64), green: false,
    failures: [{ file: 'test/a.test.js', name: 'x' }], load: { average: [0, 0, 0], cpus: 1, freeMB: 4096 },
    at: '2026-11-15T12:00:00.000Z', full: false, testOutcomes,
    timing: { version: 1, node: '22.13.0', wallMs: 1, selectionMs: null, setupMs: null, shards: null, compareMs: 1 } });
  assert.deepEqual(receipt?.testOutcomes, testOutcomes);
});

test('gate.io-test-failure-kinds.the-base-comparison-refuses-a-file: clause 2: the base comparison refuses a file the base commit does not hold [C7]', async () => {
  const root = join(import.meta.dirname, '../../../../..');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  await assert.rejects(runClauseBaseComparison(root, head, 'test/no-such-file.test.js'), /NO_BASE_FILE|does not exist at the item's base/u);
  await assert.rejects(runClauseBaseComparison(root, 'main', 'x.test.js'), /base commit/u);
});

test('gate.io-test-failure-kinds.rows-recorded-before-the-failure-field: clause 3: rows recorded before the failure field still read as valid [C7]', () => {
  const old = [{ file: 'test/a.test.js', name: 'x', passed: false, skipped: false }];
  assert.deepEqual(testOutcomeFields(old), old);
  assert.equal(testOutcomeFields([{ ...old[0], failure: 'other' }]), null);
  assert.equal(testOutcomeFields([{ file: 'test/a.test.js', name: 'x', passed: true, skipped: false, failure: 'assertion' }]), null);
});
