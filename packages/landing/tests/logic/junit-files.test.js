/** @pullboard-test-input source-cell packages/landing */
/** @pullboard-world-pin: reads the checked-in registry.json and this file as text, never a tool run. */
/** The JUnit file rows map a language's report case to its repo file with no tool run: a pure table check [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { junitFile } from '../../src/logic/junit-files.js';

test('landing.junit-files.julia-runtests-file: clause 1: junitFile(julia, row) returns test/runtests.jl for a row with any classname [C7]', () => {
  assert.equal(junitFile('julia', { classname: 'MyPkg' }), 'test/runtests.jl');
});

test('landing.junit-files.julia-no-classname: clause 2: junitFile(julia, row) returns null for a row without a classname [C7]', () => {
  assert.equal(junitFile('julia', {}), null);
});

test('landing.junit-files.julia-registry-records: clause 3: every julia title in this file has an ID starting landing.junit-files.julia and a record in registry.json [C7]', () => {
  const records = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'registry.json'), 'utf8'));
  const own = Object.keys(records).filter(id => id.startsWith('landing.junit-files.julia'));
  assert.ok(own.length >= 3);
  const titles = [...readFileSync(import.meta.filename, 'utf8').matchAll(/^test\('(landing\.junit-files\.julia[^':\s]*): /gmu)].map(m => m[1]);
  assert.deepEqual(titles.filter(id => !Object.hasOwn(records, id)), []);
});
