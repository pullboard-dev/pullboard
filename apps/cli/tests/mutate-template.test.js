/** The mutation check keeps seeding faults after a template literal that nests another inside a ${} expression [C7,#8292]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { faults } from '../src/logic/mutate/faults.js';
import { masked } from '../src/logic/mutate/faults.js';

const SOURCE = [
  'const note = `seats: ${seats.map(x => `${x.id} (${x.lane})`).join("; ")} and ${a === b}`;',
  'const quoted = `${path.replaceAll("\'", `\'\\\\\'\'`)}`;',
  'export const ok = (s) => s.count === 2 && s.open;',
  'export const next = (s) => s.count > 3;',
].join('\n');

test('clause 1: [C7] faults seeds equality, logic and comparison swaps on the lines after a template that nests a template', () => {
  const found = faults(SOURCE, [3, 4]);
  const kinds = (line) => new Set(found.filter((fault) => fault.line === line).map((fault) => fault.operator));
  assert.deepEqual([...kinds(3)].sort(), ['equality', 'literal', 'logic']);
  assert.deepEqual([...kinds(4)].sort(), ['comparison', 'literal']);
});

test('clause 1: [C7] masked blanks the text of a nested template, keeps its ${} code, and ends the outer template at its own backtick', () => {
  const rows = masked(SOURCE).split('\n');
  assert.equal(rows.length, SOURCE.split('\n').length);
  assert.ok(rows[0].includes('a === b'), 'code inside ${} stays visible');
  assert.ok(!rows[0].includes('seats:'), 'template text is blanked');
  assert.ok(rows[2].includes('s.count === 2 && s.open'), 'the next line is code again');
});
