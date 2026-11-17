/** @pullboard-test-input source-cell packages/landing */
/** @pullboard-world-pin: reads the checked-in registry.json and this file as text, never a tool run. */
/** The JUnit file rows map a language's report case to its repo file with no tool run: a pure table check [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { junitFile } from '../../src/logic/junit-files.js';

test('landing.junit-files.nim-test-file: clause 1: junitFile(nim, row) returns the classname with the .nim extension under the tests folder [C7]', () => {
  assert.equal(junitFile('nim', { classname: 'tcalc' }), 'tests/tcalc.nim');
  assert.equal(junitFile('nim', { classname: 'tcalc.nim' }), 'tests/tcalc.nim');
});

test('landing.junit-files.nim-no-classname: clause 2: junitFile(nim, row) returns null for a row without a classname [C7]', () => {
  assert.equal(junitFile('nim', {}), null);
});

test('landing.junit-files.nim-registry-records: clause 3: every nim title in this file has an ID starting landing.junit-files.nim and a record in registry.json [C7]', () => {
  const records = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'registry.json'), 'utf8'));
  const own = Object.keys(records).filter(id => id.startsWith('landing.junit-files.nim'));
  assert.ok(own.length >= 3);
  const titles = [...readFileSync(import.meta.filename, 'utf8').matchAll(/^test\('(landing\.junit-files\.nim[^':\s]*): /gmu)].map(m => m[1]);
  assert.deepEqual(titles.filter(id => !Object.hasOwn(records, id)), []);
});
