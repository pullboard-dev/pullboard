/** Test outcome rows record how a case failed, so a clause's base run can tell an assertion from a load error [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { run } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runClauseBaseComparison } from '../../../index.js';
import { receiptFields } from '../../../index.js';
import { testOutcomeCollector } from '../../../index.js';
import { testOutcomeFields } from '../../../index.js';

/** Drive real node:test events for fixture files through the collector and return its rows. */
async function collect(files) {
  const box = privateFixtureFiles('failure-kinds-');
  for (const [name, body] of Object.entries(files)) box.write(name, body);
  const collector = testOutcomeCollector(box.root);
  let count = 0;
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    for await (const event of run({ files: Object.keys(files).map(name => join(box.root, name)) })) {
      collector.observe(event);
      if (event.type === 'test:summary') count = event.data.counts.tests;
    }
  } finally {
    if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
  }
  return collector.finish(true, count);
}

test('clause 1: an assertion failure is recorded as assertion, a load error as error [C7]', async () => {
  const rows = await collect({
    'a.test.js': "import test from 'node:test'; import assert from 'node:assert/strict';\ntest('asserts', () => assert.equal(1, 2));\ntest('throws', () => { throw new Error('boom'); });\ntest('ok', () => {});\n",
    'b.test.js': "import './missing.js';\n",
  });
  const by = name => rows.find(row => row.name === name);
  assert.equal(by('asserts').failure, 'assertion');
  assert.equal(by('throws').failure, 'error');
  assert.equal(by('ok').failure, undefined);
  assert.equal(rows.find(row => row.file === 'b.test.js').failure, 'error');
});

test('clause 2: a receipt keeps the failure kinds of its outcomes [C7]', () => {
  const testOutcomes = [{ file: 'test/a.test.js', name: 'x', passed: false, skipped: false, failure: 'assertion' }];
  const receipt = receiptFields({ version: 1, id: '11111111-1111-4111-8111-111111111111', kind: 'main-red',
    tree: 'a'.repeat(40), head: 'b'.repeat(40), main: 'c'.repeat(40), command: 'd'.repeat(64), green: false,
    failures: [{ file: 'test/a.test.js', name: 'x' }], load: { average: [0, 0, 0], cpus: 1, freeMB: 4096 },
    at: '2026-11-15T12:00:00.000Z', full: false, testOutcomes,
    timing: { version: 1, node: '22.13.0', wallMs: 1, selectionMs: null, setupMs: null, shards: null, compareMs: 1 } });
  assert.deepEqual(receipt?.testOutcomes, testOutcomes);
});

test('clause 2: the base comparison refuses a file the base commit does not hold [C7]', async () => {
  const root = join(import.meta.dirname, '../../../../..');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  await assert.rejects(runClauseBaseComparison(root, head, 'test/no-such-file.test.js'), /NO_BASE_FILE|does not exist at the item's base/u);
  await assert.rejects(runClauseBaseComparison(root, 'main', 'x.test.js'), /base commit/u);
});

test('clause 3: rows recorded before the failure field still read as valid [C7]', () => {
  const old = [{ file: 'test/a.test.js', name: 'x', passed: false, skipped: false }];
  assert.deepEqual(testOutcomeFields(old), old);
  assert.equal(testOutcomeFields([{ ...old[0], failure: 'other' }]), null);
  assert.equal(testOutcomeFields([{ file: 'test/a.test.js', name: 'x', passed: true, skipped: false, failure: 'assertion' }]), null);
});
