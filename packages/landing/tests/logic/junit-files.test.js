/** @pullboard-test-input source-cell packages/landing */
/** @pullboard-world-pin: the clause 3 cases read this file and the cell's registry.json to check that every title is registered. */
/** The junit-files adapter table: each language row maps one report case to the repo file a person must open [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { junitFile } from '../../src/logic/junit-files.js';

test('landing.junit-files.zig-classname-is-the-file: clause 1: junitFile zig returns the classname of a row whose classname ends in .zig [C7]', () => {
  assert.equal(junitFile('zig', { classname: 'src/calc.zig' }), 'src/calc.zig');
  assert.equal(junitFile('zig', { classname: 'src/calc.cpp' }), null);
});

test('landing.junit-files.zig-no-classname-is-null: clause 2: junitFile zig returns null for a row without a classname [C7]', () => {
  assert.equal(junitFile('zig', {}), null);
  assert.equal(junitFile('zig', { classname: '' }), null);
});

test('landing.junit-files.zig-titles-registered: clause 3: every zig test title here carries an ID starting landing.junit-files.zig with a registry record [C7]', () => {
  const records = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'registry.json'), 'utf8'));
  const source = readFileSync(import.meta.filename, 'utf8');
  const ids = [...source.matchAll(/^test\('(landing\.junit-files\.zig-[^':\s]+): /gmu)].map(match => match[1]);
  assert.ok(ids.length >= 3);
  for (const id of ids) assert.ok(Object.hasOwn(records, id), id);
});
