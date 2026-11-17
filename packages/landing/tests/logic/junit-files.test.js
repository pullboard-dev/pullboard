/** @pullboard-test-input source-cell packages/landing */
/** @pullboard-world-pin: the clause 3 cases read this file and the cell's registry.json to check that every title is registered. */
/** The junit-files adapter table: each language row maps one report case to the repo file a person must open [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { junitFile } from '../../src/logic/junit-files.js';

test('landing.junit-files.ocaml-classname-is-the-test-file: clause 1: junitFile ocaml returns the lowercased classname with the .ml extension under the test folder [C7]', () => {
  assert.equal(junitFile('ocaml', { classname: 'Calc' }), 'test/calc.ml');
});

test('landing.junit-files.ocaml-no-classname-is-null: clause 2: junitFile ocaml returns null for a row without a classname [C7]', () => {
  assert.equal(junitFile('ocaml', {}), null);
  assert.equal(junitFile('ocaml', { classname: '' }), null);
});

test('landing.junit-files.ocaml-titles-registered: clause 3: every ocaml test title here carries an ID starting landing.junit-files.ocaml with a registry record [C7]', () => {
  const records = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'registry.json'), 'utf8'));
  const source = readFileSync(import.meta.filename, 'utf8');
  const ids = [...source.matchAll(/^test\('(landing\.junit-files\.ocaml-[^':\s]+): /gmu)].map(match => match[1]);
  assert.ok(ids.length >= 3);
  for (const id of ids) assert.ok(Object.hasOwn(records, id), id);
});

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
