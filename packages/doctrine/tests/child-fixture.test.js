/** @pullboard-test-input source-tree */
/** @pullboard-world-pin reads the package test sources to prove none imports the CLI child fixture. */
/** No package test imports the CLI app's child fixture, which only re-exports the gate's [C7]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const STATIC_IMPORT = /\b(?:import|export)\b[^;'"`]*?\bfrom\s*['"][^'"]*apps\/cli\/tests\/fixtures\/child\.js['"]/;

/** Named exceptions, kept in the gate's data file the static stage reads too (#8435): tests in cells with no edge to gate, where repointing would add one (#8200); each leaves this list when its cell gains the edge. */
const CLI_SHIM_IMPORTERS = JSON.parse(readFileSync(join(ROOT, 'packages/gate/data/baselines/cli-child-importers.json'), 'utf8'));

test('doctrine.child-fixture.clause-1-no-package-test-imports-the-cli: clause 1: no package test imports the CLI app child fixture [C7]', () => {
  const offenders = readdirSync(join(ROOT, 'packages'), { recursive: true })
    .filter((name) => /\.test\.m?js$/.test(name) && !name.split('/').includes('node_modules'))
    .filter((name) => !CLI_SHIM_IMPORTERS.includes(name))
    .filter((name) => STATIC_IMPORT.test(readFileSync(join(ROOT, 'packages', name), 'utf8')));
  assert.deepEqual(offenders, [], 'package tests import packages/gate/tests/fixtures/child.js directly');
});

test('doctrine.child-fixture.every-named-exception-still-imports-the: every named exception still imports the CLI child fixture [C7]', () => {
  const stale = CLI_SHIM_IMPORTERS.filter((name) => !STATIC_IMPORT.test(readFileSync(join(ROOT, 'packages', name), 'utf8')));
  assert.deepEqual(stale, [], 'remove an exception once its test is repointed');
});

test('doctrine.child-fixture.the-import-pattern-catches-one-line-and: the import pattern catches one-line and multi-line forms [C7]', () => {
  const child = ['apps', 'cli', 'tests', 'fixtures', 'child.js'].join('/');
  assert.match(`import { a } from '../../${child}';`, STATIC_IMPORT);
  assert.match(`import {\n  a,\n  b,\n} from '../../../${child}';`, STATIC_IMPORT);
  assert.doesNotMatch("import { a } from '../../gate/tests/fixtures/child.js';", STATIC_IMPORT);
});
