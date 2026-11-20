/** The row reader keeps a row's stakes field: low, team or critical, team when none is written [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpec } from '../../src/logic/grammar.js';

const spec = rows => parseSpec(`# T\n\n## G · Goals\n\n${rows.join('\n')}\n`);

test('spec.logic-grammar.stakes-field: clause 1: parseSpec reads stakes low, team or critical, gives team when none is written, and reports any other value as a row problem [C7]', () => {
  const parsed = spec([
    '- G1 [approved, must] Low row. | gate: a test | stakes: low',
    '- G2 [approved, must] Team row. | gate: a test | stakes: team',
    '- G3 [approved, must] Critical row. | gate: a test | stakes: critical',
    '- G4 [approved, must] Plain row. | gate: a test',
    '- G5 [approved, must] Odd row. | gate: a test | stakes: huge',
  ]);
  const stakes = Object.fromEntries(parsed.rows.map(row => [row.id, row.stakes]));
  assert.deepEqual(stakes, { G1: 'low', G2: 'team', G3: 'critical', G4: 'team', G5: 'team' });
  assert.deepEqual(parsed.rows.find(row => row.id === 'G5').unknown, ['stakes must be low, team or critical: stakes: huge']);
  assert.deepEqual(parsed.rows.find(row => row.id === 'G1').unknown, []);
  assert.equal(parsed.rows.find(row => row.id === 'G1').gate, 'a test');
});

test('spec.logic-grammar.stakes-keeps-others: clause 1: a row without stakes parses its gate, serves and signers as before [C7]', () => {
  const [row] = spec(['- G1 [approved, must] Plain row. | gate: a test | serves: F1 | signers: CO']).rows;
  assert.equal(row.gate, 'a test');
  assert.deepEqual(row.serves, ['F1']);
  assert.deepEqual(row.signers, ['CO']);
  assert.deepEqual(row.unknown, []);
});
