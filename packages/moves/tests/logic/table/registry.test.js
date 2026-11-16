/** @pullboard-test-input source-cell packages/moves */
/** The moves cell's generated table tests each carry a stable ID and one record naming the table row they own [C7,U148,#8392]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tableTestRegistryProblems } from '../../../index.js';

const DIR = import.meta.dirname;
const records = { 'moves.hop.rows-fire': { proves: { move: 'hop:*' } } };
const file = (title) => [{ file: 'hop-generated.test.js', source: `test('${title}', () => {});\n` }];

test('moves.registry.id-required: clause 1: a generated table test with no stable ID before its first colon is reported [C7]', () => {
  const problems = tableTestRegistryProblems(file('generated: every row fires [C7]'), records);
  assert.ok(problems.some((line) => /hop-generated\.test\.js: test .* has no stable ID/u.test(line)), problems.join('\n'));
  assert.deepEqual(tableTestRegistryProblems(file('moves.hop.rows-fire: generated: every row fires'), records), []);
});

test('moves.registry.record-names-row: clause 2: an ID with no record, or a record without a table:row, is reported [C7]', () => {
  assert.match(tableTestRegistryProblems(file('moves.hop.other: x'), records)[0], /moves\.hop\.other has no registry record/u);
  const bare = { 'moves.hop.rows-fire': { proves: {} } };
  assert.match(tableTestRegistryProblems(file('moves.hop.rows-fire: x'), bare)[0], /does not name the table row/u);
  assert.match(tableTestRegistryProblems(file('moves.hop.rows-fire: x'), { 'moves.hop.rows-fire': { proves: { move: 'hop' } } })[0], /does not name the table row/u);
});

test('moves.registry.generated-complete: clause 3: every generated table test has an ID and a record naming its table row, and no record is orphaned [C7]', () => {
  const dir = join(DIR);
  const files = readdirSync(dir).filter((name) => name.endsWith('-generated.test.js')).sort().map((name) => ({ file: name, source: readFileSync(join(dir, name), 'utf8') }));
  const all = JSON.parse(readFileSync(join(DIR, '../../registry.json'), 'utf8'));
  assert.ok(files.length >= 10, 'the generated table test files were found');
  assert.deepEqual(tableTestRegistryProblems(files, all), []);
});
