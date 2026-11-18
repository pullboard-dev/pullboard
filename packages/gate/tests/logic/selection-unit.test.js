/** @pullboard-test-input source-cell gate */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MACHINE_DEFAULTS } from '../../../config/index.js';
import { describeSetting } from '../../../config/index.js';
import * as unitModule from '../../src/logic/selection-unit.js';

const { SELECTION_UNITS, selectionUnits } = unitModule;

const FILES = [
  'go.mod', 'cmd/app/main.go', 'pkg/a/a.go', 'pkg/a/a_test.go',
  'crates/x/Cargo.toml', 'crates/x/src/lib.rs', 'crates/y/Cargo.toml', 'README.md',
  'src/App/App.csproj', 'src/App/Program.cs', 'apps/web/mix.exs', 'apps/web/lib/web.ex', 'Root.sln',
];

test('gate.logic-selection-unit.gate-selectionunit-is-a-described-setting: clause 1: gate.selectionUnit is a described setting with file, package, crate and project, default file [C7]', () => {
  assert.equal(MACHINE_DEFAULTS['gate.selectionUnit'], 'file');
  assert.ok(describeSetting('gate.selectionUnit'));
  assert.deepEqual(SELECTION_UNITS, ['file', 'package', 'crate', 'project', 'module']);
});

test('gate.logic-selection-unit.selectionunits-maps-file-package-crate-and: clause 2: selectionUnits maps file, package, crate and project from the manifest list alone [C7]', () => {
  assert.deepEqual(selectionUnits('file', ['./b.js', 'a.js', 'a.js'], FILES), { units: ['a.js', 'b.js'], full: false, reason: null });
  assert.deepEqual(selectionUnits('package', ['pkg/a/a.go', 'pkg/a/a_test.go', 'cmd/app/main.go'], FILES).units, ['cmd/app', 'pkg/a']);
  assert.deepEqual(selectionUnits('crate', ['crates/x/src/lib.rs', 'crates/y/Cargo.toml'], FILES).units, ['crates/x', 'crates/y']);
  assert.deepEqual(selectionUnits('project', ['src/App/Program.cs', 'apps/web/lib/web.ex'], FILES).units, ['apps/web', 'src/App']);
  assert.deepEqual(selectionUnits('project', ['Root.sln'], FILES).units, ['.']);
});

test('gate.logic-selection-unit.a-path-with-no-unit-above: clause 3: a path with no unit above it, or the binary unit, returns full true with a reason [C7]', () => {
  const orphan = selectionUnits('crate', ['crates/x/src/lib.rs', 'README.md'], FILES);
  assert.equal(orphan.full, true);
  assert.deepEqual(orphan.units, []);
  assert.match(orphan.reason, /README\.md/u);
  assert.equal(selectionUnits('project', ['crates/x/src/lib.rs'], ['crates/x/Cargo.toml']).full, true);
  const binary = selectionUnits('binary', ['src/a.c'], FILES);
  assert.equal(binary.full, true);
  assert.match(binary.reason, /affectedSuites/u);
  assert.equal(selectionUnits('nonsense', ['a'], FILES).full, true);
});
