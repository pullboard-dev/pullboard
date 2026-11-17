/** @pullboard-test-input source-cell gate */
/** A check run with no TAP counts takes its receipt counts from the report gate.junitReport names [C7,#10373]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../fixtures/child.js';
import { fixtureMachineSettings } from '../fixtures/testkit.js';
import { receiptCounts } from '../../src/io/junit-receipt.js';

const REPORT = `<?xml version="1.0"?>
<testsuites><testsuite name="s" tests="4">
<testcase name="a" classname="x"/>
<testcase name="b" classname="x"/>
<testcase name="c" classname="x"><failure message="m">boom</failure></testcase>
<testcase name="d" classname="x"><skipped/></testcase>
</testsuite></testsuites>`;
const TAP = { passed: 3, failed: 0, skipped: 0 };
const UNKNOWN = { passed: null, failed: null, skipped: null };

/** A checkout holding junit.xml and a private machine home with the given settings. */
function fixture(t, settings) {
  const box = privateFixtureFiles('pullboard-junit-receipt-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  const home = join(box.root, 'machine-home');
  mkdirSync(home);
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; rmSync(box.root, { recursive: true, force: true }); });
  if (settings) fixtureMachineSettings(home, settings);
  box.write('repo/junit.xml', REPORT);
  return join(box.root, 'repo');
}

test('gate.junit-receipt-counts.report-counts: clause 1: a run with no TAP summary and the report gate.junitReport names gets pass, fail and skip counts from junitCounts [C7,#10373]', (t) => {
  const repo = fixture(t, { gate: { junitReport: 'junit.xml' } });
  assert.deepEqual(receiptCounts(repo, UNKNOWN), { passed: 2, failed: 1, skipped: 1 });
  assert.deepEqual(receiptCounts(repo, { passed: 5, failed: null, skipped: null }), { passed: 2, failed: 1, skipped: 1 });
});

test('gate.junit-receipt-counts.tap-wins: clause 2: a run with TAP counts keeps them and ignores the report [C7,#10373]', (t) => {
  const repo = fixture(t, { gate: { junitReport: 'junit.xml' } });
  assert.deepEqual(receiptCounts(repo, TAP), TAP);
});

test('gate.junit-receipt-counts.unset-unknown: clause 3: with gate.junitReport unset, or its report missing, outside the checkout or damaged, the counts are unknown as today [C7,#10373]', (t) => {
  const unset = fixture(t, null);
  assert.deepEqual(receiptCounts(unset, UNKNOWN), UNKNOWN);
  for (const path of ['absent.xml', '../escape.xml']) {
    const repo = fixture(t, { gate: { junitReport: path } });
    assert.deepEqual(receiptCounts(repo, UNKNOWN), UNKNOWN);
  }
  const damaged = fixture(t, { gate: { junitReport: 'bad.xml' } });
  writeFileSync(join(damaged, 'bad.xml'), '<testsuite><testcase name="a">');
  assert.deepEqual(receiptCounts(damaged, UNKNOWN), UNKNOWN);
});
