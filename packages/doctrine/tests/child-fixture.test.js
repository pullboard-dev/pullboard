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

/** Fixtures and a view-owned test that still import it: repointing them adds a cell to a ratchet or crosses a lane. */
const FIXTURE_OWNED = ['gate/tests/io/static/style.test.js'];

test('clause 1: no package test imports the CLI app child fixture [C7]', () => {
  const offenders = readdirSync(join(ROOT, 'packages'), { recursive: true })
    .filter((name) => /\.test\.m?js$/.test(name) && !name.split('/').includes('node_modules'))
    .filter((name) => !FIXTURE_OWNED.includes(name))
    .filter((name) => STATIC_IMPORT.test(readFileSync(join(ROOT, 'packages', name), 'utf8')));
  assert.deepEqual(offenders, [], 'package tests import packages/gate/tests/fixtures/child.js directly');
});

test('the import pattern catches one-line and multi-line forms [C7]', () => {
  const child = ['apps', 'cli', 'tests', 'fixtures', 'child.js'].join('/');
  assert.match(`import { a } from '../../${child}';`, STATIC_IMPORT);
  assert.match(`import {\n  a,\n  b,\n} from '../../../${child}';`, STATIC_IMPORT);
  assert.doesNotMatch("import { a } from '../../gate/tests/fixtures/child.js';", STATIC_IMPORT);
});
