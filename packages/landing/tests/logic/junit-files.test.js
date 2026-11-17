/** @pullboard-test-input source-cell packages/landing */
/** @pullboard-world-pin: the clause 3 cases read this file and the cell's registry.json to check that every title is registered. */
/** The junit-files adapter table: each language row maps one report case to the repo file a person must open [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { junitFile } from '../../src/logic/junit-files.js';

test('landing.junit-files.crystal-classname-is-the-spec-file: clause 1: junitFile crystal returns the classname of a row whose classname ends in .cr [C7]', () => {
  assert.equal(junitFile('crystal', { classname: 'spec/calc_spec.cr' }), 'spec/calc_spec.cr');
});

test('landing.junit-files.crystal-non-cr-classname-is-null: clause 2: junitFile crystal returns null for a row whose classname does not end in .cr [C7]', () => {
  assert.equal(junitFile('crystal', { classname: 'Calc' }), null);
  assert.equal(junitFile('crystal', {}), null);
});

test('landing.junit-files.crystal-titles-registered: clause 3: every crystal test title here carries an ID starting landing.junit-files.crystal with a registry record [C7]', () => {
  const records = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'registry.json'), 'utf8'));
  const source = readFileSync(import.meta.filename, 'utf8');
  const ids = [...source.matchAll(/^test\('(landing\.junit-files\.crystal-[^':\s]+): /gmu)].map(match => match[1]);
  assert.ok(ids.length >= 3);
  for (const id of ids) assert.ok(Object.hasOwn(records, id), id);
});
