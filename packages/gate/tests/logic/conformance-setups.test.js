/** @pullboard-test-input source-cell gate */
/** @pullboard-test-input packages/gate/tests/fixtures/conformance/node.xml packages/gate/tests/fixtures/conformance/typescript.xml packages/gate/tests/fixtures/conformance/python.xml packages/gate/tests/fixtures/conformance/go.xml packages/gate/tests/fixtures/conformance/rust.xml packages/gate/tests/fixtures/conformance/php.xml packages/gate/tests/fixtures/conformance/elixir.xml packages/gate/tests/fixtures/conformance/csharp.xml packages/gate/tests/fixtures/conformance/ctest.xml */
/** @pullboard-world-pin reads the checked-in conformance report fixtures, never a tool run. */
/** The conformance list names each language setup, its report fixture and its toolchain, and a missing toolchain is unavailable, never red [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { conformanceResults } from '../../src/logic/conformance-setups.js';
import { conformanceSetups } from '../../src/logic/conformance-setups.js';
import { setupAvailability } from '../../src/logic/conformance-setups.js';
import { CONFORMANCE_STAGES } from '../../src/logic/conformance-setups.js';
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

test('gate.conformance-setups.results-rows: clause 1: conformanceResults gives one row per setup and stage carrying the outcome and run id of the latest run that reached that stage [C7]', () => {
  const setups = conformanceSetups();
  const runs = [
    { id: 'r1', language: 'go', at: '2026-11-18T10:00:00Z', stages: { claim: 'pass', submit: 'pass', gate: 'fail' } },
    { id: 'r2', language: 'go', at: '2026-11-19T10:00:00Z', stages: { claim: 'pass', submit: 'pass', gate: 'pass', review: 'pass' } },
    { id: 'r0', language: 'go', at: '2026-11-17T10:00:00Z', stages: { land: 'pass' } },
  ];
  const rows = conformanceResults(setups, runs, () => true);
  assert.equal(rows.length, setups.length * CONFORMANCE_STAGES.length);
  assert.deepEqual(CONFORMANCE_STAGES, ['claim', 'submit', 'gate', 'review', 'accept', 'land']);
  assert.deepEqual(rows.map(row => [row.language, row.stage]), setups.flatMap(({ language }) => CONFORMANCE_STAGES.map(stage => [language, stage])));
  const go = Object.fromEntries(rows.filter(row => row.language === 'go').map(row => [row.stage, row]));
  assert.deepEqual(go.gate, { language: 'go', stage: 'gate', outcome: 'pass', run: 'r2' }, 'the later run wins a stage both reached');
  assert.equal(go.claim.run, 'r2');
  assert.deepEqual([go.land.outcome, go.land.run], ['pass', 'r0'], 'an older run still answers a stage only it reached');
  assert.deepEqual([go.accept.outcome, go.accept.run], ['unknown', null]);
});

test('gate.conformance-setups.results-unavailable-unknown: clause 2: a setup whose toolchain is missing is unavailable at every stage, never red, and a setup with no recorded run is unknown [C7]', () => {
  const setups = conformanceSetups();
  const runs = [{ id: 'r1', language: 'rust', at: '2026-11-19T10:00:00Z', stages: { claim: 'fail' } }];
  const rows = conformanceResults(setups, runs, name => name !== 'cargo');
  const rust = rows.filter(row => row.language === 'rust');
  assert.equal(rust.length, CONFORMANCE_STAGES.length);
  assert.ok(rust.every(row => row.outcome === 'unavailable' && row.run === null), 'rust is unavailable at every stage even with a recorded run');
  const node = rows.filter(row => row.language === 'node');
  assert.ok(node.every(row => row.outcome === 'unknown' && row.run === null), 'a setup with no run is unknown');
  assert.ok(!rows.some(row => row.outcome === 'red'), 'nothing is red');
  const present = conformanceResults(setups, runs, () => true).find(row => row.language === 'rust' && row.stage === 'claim');
  assert.equal(present.outcome, 'fail');
});
