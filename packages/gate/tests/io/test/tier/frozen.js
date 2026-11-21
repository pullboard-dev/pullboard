/** A repository after the layout freeze, and changes selected on top of it, shared by the tier selection tests [C7,#4015]. */
import { selectTestTiers } from '../../../../heavy.js';
import { writeTestTiers } from '../../../../heavy.js';
import { fixture as repository } from '../../../../../landing/tests/fixtures/plan.js';
import { git } from '../../../../../landing/tests/fixtures/plan.js';
import { DEFAULT_CANARY } from '../../../../src/io/test/tier/selection.js';
import { submitGatePlan } from '../../../../heavy.js';

export const SIZE_TEST = 'packages/gate/tests/io/size.test.js';
export const OTHER_TEST = 'packages/gate/tests/io/other.test.js';
export const MIXED_TEST = 'packages/gate/tests/io/mixed.test.js';
export const WEB_TEST = 'packages/web/tests/page.test.js';

/**
 * A repository after the layout freeze: one test reaches a size module, one reaches an ordinary gate module, one reaches both,
 * and a web cell stands apart.
 */
export function frozen(t) {
  const { root, put } = repository(t);
  put('packages/gate/data/ceilings/size.json', '{"cap":1500}\n');
  put('packages/gate/src/io/size.js', 'export const size = 1;\n');
  put('packages/gate/src/io/other.js', 'export const other = 1;\n');
  put(SIZE_TEST, "import { size } from '../../src/io/size.js';\nvoid size;\n");
  put(OTHER_TEST, "import { other } from '../../src/io/other.js';\nvoid other;\n");
  put(MIXED_TEST, "import { size } from '../../src/io/size.js';\nimport { other } from '../../src/io/other.js';\nvoid [size, other];\n");
  put('packages/web/src/page.js', 'export const page = 1;\n');
  put(WEB_TEST, "import { page } from '../src/page.js';\nvoid page;\n");
  // The inventory reads tracked files only, so stage the fixture before the manifest is written.
  git(root, 'add', '-A');
  writeTestTiers(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'freeze');
  return { root, put, base: git(root, 'rev-parse', 'HEAD').trim() };
}

/** Commit one change on top of the frozen repository and select its tiers. */
export function change(box, files) {
  for (const [file, source] of Object.entries(files)) box.put(file, source);
  git(box.root, 'add', '-A');
  writeTestTiers(box.root);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'change');
  const commit = git(box.root, 'rev-parse', 'HEAD').trim();
  return selectTestTiers(box.root, { base: box.base, commit });
}

export const H_TEST = 'packages/alpha/tests/uses-helper.test.js';
export const SRC_TEST = 'packages/alpha/tests/uses-source.test.js';
export const LONE_TEST = 'packages/alpha/tests/alone.test.js';
export const HELPER = 'packages/alpha/tests/helpers/h.js';
export const CELL_TESTS = [LONE_TEST, SRC_TEST, H_TEST];
export const NARROW_CONFIG = { gate: 'true', affectedTests: 'node --test', submitInvariants: [], registryGuards: [] };

/** A sealed cell with three tests: one imports a test helper, one the cell's source, one nothing; the canary files ride at main. */
export function sealedCell(t) {
  const { root, put } = repository(t);
  const listing = { version: 1, journeys: {}, pureHelpers: {}, leaves: [], findings: {}, rootTests: 0, sealed: ['alpha'], splits: {} };
  put('package.json', '{"type":"module"}\n');
  put('packages/alpha/index.js', 'export { a } from "./src/core/a.js";\n');
  put('packages/alpha/src/core/a.js', 'export const a = 1;\n');
  put('packages/alpha/data/rows.json', '{"rows":1}\n');
  put(HELPER, 'export const h = 1;\n');
  put(H_TEST, 'import { h } from "./helpers/h.js";\nvoid h;\n');
  put(SRC_TEST, 'import { a } from "../index.js";\nvoid a;\n');
  put(LONE_TEST, 'import assert from "node:assert/strict";\nassert.ok(true);\n');
  for (const file of DEFAULT_CANARY) put(file, "import assert from 'node:assert/strict';\nassert.ok(true);\n");
  put('packages/gate/data/tests/test-cells.json', JSON.stringify(listing));
  put('packages/gate/data/ceilings/cells-edges.json', JSON.stringify({ files: { 'packages/alpha/src/core/a.js': { cells: 0, deep: 0 } }, cells: { alpha: { imports: [], deepImporters: 0 } } }));
  put('packages/codemap/data/plan/01-alpha.json', JSON.stringify({ order: 1, name: 'alpha', kind: 'package', root: 'packages/alpha', frontDoor: 'packages/alpha/index.js', paths: [['src/a.js', 'packages/alpha/src/core/a.js', 'seed']] }));
  git(root, 'add', '-A');
  writeTestTiers(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return { root, put, base: git(root, 'rev-parse', 'HEAD').trim() };
}

/** Commit edits to the sealed cell's existing files, and plan the submit gate with the repo key given. */
export function planWith(box, edits, key) {
  for (const [file, source] of Object.entries(edits)) box.put(file, source);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'change');
  const commit = git(box.root, 'rev-parse', 'HEAD').trim();
  const config = { ...NARROW_CONFIG, ...(key === undefined ? {} : { confinedImportSelection: key }) };
  return { commit, plan: submitGatePlan(box.root, config, { base: box.base, commit }) };
}

export const READS_TEST = 'packages/alpha/tests/reads-fixture.test.js';
export const NAMED_TEST = 'packages/alpha/tests/reads-named.test.js';
export const FIXTURE_READ = "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nreadFileSync(join(import.meta.dirname, 'fixtures', 'rows.json'));\n";

/** The sealed cell plus a test that reads a cell fixture no header names, and one that names the same read in a header. */
export function readerCell(t) {
  const box = sealedCell(t);
  box.put('packages/alpha/tests/fixtures/rows.json', '{}\n');
  box.put(READS_TEST, FIXTURE_READ);
  box.put(NAMED_TEST, `/** @pullboard-test-input packages/alpha/tests/fixtures/rows.json */\n${FIXTURE_READ}`);
  git(box.root, 'add', '-A');
  writeTestTiers(box.root);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'readers');
  return { ...box, base: git(box.root, 'rev-parse', 'HEAD').trim() };
}
