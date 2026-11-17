/** The mutation check turns changed lines into single-line seeded faults, purely and deterministically [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { faults } from '../src/logic/mutate/faults.js';
import { changedLines } from '../src/logic/mutate/lines.js';

const SOURCE = [
  '// a === b is only a comment',
  'export function f(a, b) {',
  "  const text = 'x && y';",
  '  if (a === b && a > 2) return true;',
  '  return a + b - 1;',
  '}',
].join('\n');

test('cli.mutate-faults.faults-seeds-comparison-logic-boolean-arithmetic-and: clause 1: [C7] faults seeds comparison, logic, boolean, arithmetic and literal swaps with line and operator', () => {
  const found = faults(SOURCE, [4, 5]);
  const operators = new Set(found.map((fault) => fault.operator));
  for (const name of ['equality', 'comparison', 'logic', 'boolean', 'arithmetic', 'literal']) assert.ok(operators.has(name), name);
  const equality = found.find((fault) => fault.operator === 'equality');
  assert.equal(equality.line, 4);
  assert.equal(equality.after, '  if (a !== b && a > 2) return true;');
  assert.ok(equality.mutated.includes('a !== b'));
  assert.ok(found.some((fault) => fault.operator === 'arithmetic' && fault.after === '  return a - b - 1;'));
});

test('cli.mutate-faults.faults-never-edits-a-line-outside-the: clause 1: [C7] faults never edits a line outside the set and keeps every other line byte for byte', () => {
  const rows = SOURCE.split('\n');
  for (const fault of faults(SOURCE, [4])) {
    const after = fault.mutated.split('\n');
    assert.equal(fault.line, 4);
    assert.equal(after.length, rows.length);
    rows.forEach((row, at) => { if (at !== 3) assert.equal(after[at], row); });
    assert.notEqual(after[3], rows[3]);
  }
  assert.deepEqual(faults(SOURCE, []), []);
  assert.deepEqual(faults(SOURCE, [99]), []);
});

test('cli.mutate-faults.faults-skips-comments-and-string-contents-and: clause 1: [C7] faults skips comments and string contents and is deterministic', () => {
  assert.deepEqual(faults(SOURCE, [1, 3]), []);
  assert.deepEqual(faults(SOURCE, [1, 2, 3, 4, 5, 6]), faults(SOURCE, [6, 5, 4, 3, 2, 1]));
  assert.deepEqual(faults('const g = (a) => a;\nconst h = a >> 1;', [1, 2]).filter((fault) => fault.operator === 'comparison'), []);
});

test('cli.mutate-faults.changedlines-reads-new-side-lines-per-file: clause 1: [C7] changedLines reads new-side lines per file from a zero-context diff', () => {
  const diff = ['diff --git a/x.js b/x.js', '--- a/x.js', '+++ b/x.js', '@@ -3,0 +4,2 @@', '+a', '+b', '@@ -9 +11 @@', '-c', '+d', '@@ -20,2 +21,0 @@', '-e', '-f', '--- a/gone.js', '+++ /dev/null', '@@ -1,2 +0,0 @@'].join('\n');
  assert.deepEqual(changedLines(diff), { 'x.js': [4, 5, 11] });
  assert.deepEqual(changedLines(''), {});
});
