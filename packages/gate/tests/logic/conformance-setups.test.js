/** @pullboard-test-input source-cell gate */
/** @pullboard-test-input packages/gate/tests/fixtures/conformance/node.xml packages/gate/tests/fixtures/conformance/typescript.xml packages/gate/tests/fixtures/conformance/python.xml packages/gate/tests/fixtures/conformance/go.xml packages/gate/tests/fixtures/conformance/rust.xml packages/gate/tests/fixtures/conformance/php.xml packages/gate/tests/fixtures/conformance/elixir.xml packages/gate/tests/fixtures/conformance/csharp.xml packages/gate/tests/fixtures/conformance/ctest.xml */
/** @pullboard-world-pin reads the checked-in conformance report fixtures, never a tool run. */
/** The conformance list names each language setup, its report fixture and its toolchain, and a missing toolchain is unavailable, never red [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { conformanceSetups } from '../../src/logic/conformance-setups.js';
import { setupAvailability } from '../../src/logic/conformance-setups.js';
import { junitCases } from '../../src/logic/junit.js';
import { SELECTION_UNITS } from '../../src/logic/selection-unit.js';

const LANGUAGES = ['node', 'typescript', 'python', 'go', 'rust', 'php', 'elixir', 'csharp', 'ctest'];
const GATE = join(import.meta.dirname, '..', '..');

test('gate.conformance-setups.list: clause 1: conformanceSetups lists node, typescript, python, go, rust, php, elixir, csharp and ctest, each with command, report, fixture and selection unit [C7]', () => {
  const setups = conformanceSetups();
  assert.deepEqual(setups.map(row => row.language), LANGUAGES);
  for (const row of setups) {
    assert.deepEqual(Object.keys(row).sort(), ['command', 'fixture', 'language', 'report', 'toolchains', 'unit'], `${row.language} shape`);
    assert.ok(row.command.trim() && row.report.trim() && row.fixture.trim(), `${row.language} names its command, report and fixture`);
    assert.ok(SELECTION_UNITS.includes(row.unit), `${row.language} unit ${row.unit} is a known selection unit`);
    assert.ok(row.toolchains.length > 0, `${row.language} names a toolchain`);
  }
  assert.equal(setups.find(row => row.language === 'go').unit, 'package');
  assert.equal(setups.find(row => row.language === 'rust').unit, 'crate');
  setups[0].command = 'changed';
  assert.notEqual(conformanceSetups()[0].command, 'changed', 'a caller cannot change the list');
});

test('gate.conformance-setups.unavailable: clause 2: a setup whose toolchain probe fails reports unavailable naming the toolchain, never red [C7]', () => {
  const none = setupAvailability(() => false);
  assert.equal(none.length, LANGUAGES.length);
  for (const row of none) {
    assert.equal(row.status, 'unavailable', `${row.language} is unavailable`);
    assert.match(row.toolchain, /^[a-z][a-z0-9+_-]*$/u, `${row.language} names its toolchain`);
  }
  const noGo = setupAvailability(name => name !== 'go');
  assert.deepEqual(noGo.find(row => row.language === 'go'), { language: 'go', status: 'unavailable', toolchain: 'go' });
  assert.deepEqual(noGo.find(row => row.language === 'rust'), { language: 'rust', status: 'available', toolchain: null });
  assert.equal(setupAvailability(name => name !== 'ctest').find(row => row.language === 'ctest').toolchain, 'ctest');
  assert.ok(setupAvailability(() => true).every(row => row.status === 'available' && row.toolchain === null));
  assert.ok(![...none, ...noGo].some(row => row.status === 'red' || row.status === 'fail'), 'no status is red');
});

test('gate.conformance-setups.fixtures: clause 3: every listed fixture exists and junitCases reads a passing and a failing case from it [C7]', () => {
  for (const { language, fixture } of conformanceSetups()) {
    const path = join(GATE, fixture);
    assert.ok(existsSync(path), `${language} fixture ${fixture} exists`);
    const { cases, reason } = junitCases(readFileSync(path, 'utf8'));
    assert.equal(reason, null, `${language} reads`);
    assert.ok(cases.some(row => row.outcome === 'pass'), `${language} has a passing case`);
    assert.ok(cases.some(row => row.outcome === 'fail'), `${language} has a failing case`);
  }
});
