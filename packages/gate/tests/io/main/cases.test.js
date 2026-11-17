/** @pullboard-test-input source-cell gate */
/** A main comparison can run only the named cases of a file, and never shares a result with a whole-file run [C7,#3066]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { mainComparisonCommand } from '../../../src/io/execution.js';
import { runMainComparison } from '../../../src/io/execution.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { fixtureCommitAll } from '../../fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../fixtures/testkit.js';

const CASES = `import test from 'node:test';
test('gate.io-main-cases.first-case: first case', () => {});
test('gate.io-main-cases.second-case-with-parens: second case (with parens)', () => {});
test('gate.io-main-cases.third-case: third case', () => {});
`;

/** A clean repository whose accepted focused command is the plain node runner with the TAP reporter. */
function fixtureRepo() {
  const files = privateFixtureFiles('pullboard-main-cases-');
  const root = files.root;
  fixtureProjectPolicy(root, { config: { affectedTests: 'env -u NODE_TEST_CONTEXT node --test --test-reporter=tap' } });
  files.write('three.test.js', CASES);
  fixtureCommitAll(root);
  return root;
}

/** The case names a run's TAP says passed. */
const ran = run => [...run.output.matchAll(/^ok \d+ - (.+)$/gmu)].map(match => match[1]);

test('gate.io-main-cases.a-comparison-given-one-case-name: clause 1: a comparison given one case name runs only that case of a three-case file on base main [C7]', async () => {
  const root = fixtureRepo();
  try {
    const filtered = await runMainComparison(root, 'three.test.js', { cases: ['second case (with parens)'] });
    assert.deepEqual(ran(filtered), ['second case (with parens)'], JSON.stringify(filtered).slice(0, 1500));
    assert.ok(filtered.receiptId, 'the filtered run leaves its own receipt');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gate.io-main-cases.a-filtered-run-and-a-whole: clause 2: a filtered run and a whole-file run of one file share no command, receipt or result [C7]', async () => {
  const root = fixtureRepo();
  try {
    const filtered = await runMainComparison(root, 'three.test.js', { cases: ['first case'] });
    const whole = await runMainComparison(root, 'three.test.js');
    assert.deepEqual(ran(whole), ['first case', 'second case (with parens)', 'third case'], 'the whole-file run ran every case after the filtered one');
    assert.notEqual(filtered.receiptId, whole.receiptId);
    const command = 'node --test';
    assert.notEqual(mainComparisonCommand(command, 'three.test.js', ['first case']), mainComparisonCommand(command, 'three.test.js'));
    assert.notEqual(mainComparisonCommand(command, 'three.test.js', ['first case']), mainComparisonCommand(command, 'three.test.js', ['third case']));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gate.io-main-cases.an-empty-or-non-string-case: clause 1: an empty or non-string case list is refused, never run as the whole file [C7]', async () => {
  const root = fixtureRepo();
  try {
    await assert.rejects(runMainComparison(root, 'three.test.js', { cases: [] }), error => error.code === 'USAGE');
    await assert.rejects(runMainComparison(root, 'three.test.js', { cases: [''] }), error => error.code === 'USAGE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
