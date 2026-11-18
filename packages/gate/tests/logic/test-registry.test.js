/** The pure new-test rule names every unregistered added test and every added journey with no golden user path [C7,U148,#9400]. @pullboard-test-input source-cell packages/gate */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unregisteredNewTests } from '../../index.js';

const records = { 'spec.sig.ok': {} };
const golden = [{ file: 'apps/cli/journeys/init/gate.test.js' }];
const registeredCells = ['packages/spec'];
const run = added => unregisteredNewTests({ added, registeredCells, records, golden });

test('gate.logic-test-registry.a-finding-per-added-test-whose: clause 1: a finding per added test whose cell has no registry, whose title has no ID, or whose ID has no record, each naming file and next step [C7,U148]', () => {
  const noCell = run([{ path: 'packages/other/tests/a.test.js', text: "test('x.y: a', () => {});" }]);
  assert.deepEqual(noCell.map(f => f.code), ['CELL_NO_REGISTRY']);
  const noId = run([{ path: 'packages/spec/tests/a.test.js', text: "test('plain title', () => {});\ntest('spec.sig.ok: fine', () => {});" }]);
  assert.deepEqual(noId.map(f => f.code), ['TEST_NO_ID']);
  const noRecord = run([{ path: 'packages/spec/tests/a.test.js', text: "test('spec.sig.new: fine', () => {});" }]);
  assert.deepEqual(noRecord.map(f => f.code), ['ID_NO_RECORD']);
  for (const finding of [...noCell, ...noId, ...noRecord]) {
    assert.ok(finding.message.includes(finding.file), 'names the file');
    assert.ok(finding.next.length > 0, 'names one next step');
  }
});

test('gate.logic-test-registry.an-added-journey-no-golden-path: clause 2: an added journey no golden path names is a finding; golden journeys, registered tests and an empty change give none [C7,U148]', () => {
  const lone = run([{ path: 'apps/cli/journeys/new/thing.test.js', text: '' }]);
  assert.deepEqual(lone.map(f => f.code), ['JOURNEY_NO_PATH']);
  assert.ok(lone[0].next.includes('golden.json'));
  assert.deepEqual(run([{ path: 'apps/cli/journeys/init/gate.test.js', text: '' }]), [], 'a golden journey');
  assert.deepEqual(run([{ path: 'packages/spec/tests/a.test.js', text: "test('spec.sig.ok: fine', () => {});" }]), [], 'a registered test');
  assert.deepEqual(run([]), []);
  assert.deepEqual(run([{ path: 'packages/spec/tests/fixtures/helper.js', text: '' }]), [], 'a fixture helper');
});
