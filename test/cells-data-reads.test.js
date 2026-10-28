/** Exact generated-data declarations never turn a moved repository source into fixture data [C7,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureSourceEdits } from '../bin/cells-move-fixtures.js';

const FILE = 'test/example.test.js';
const SOURCE = "import { readFileSync } from 'node:fs';\nconst generated = process.env.GENERATED_HOOK;\nreadFileSync(generated, 'utf8');\n";
const ROW = { file: FILE, line: 3, expression: 'generated', kind: 'hook', why: 'The fixture receives its generated installed hook path through its private environment.' };

test('an exact listed generated-data operand is accepted without rewriting source [C7,CD64]', () => {
  const result = fixtureSourceEdits(SOURCE, { file: FILE, moves: [['src/hooks.js', 'packages/commits/src/shell/hooks.js']], dataReads: [ROW] });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.edits, []);
  assert.deepEqual(result.matchedDataReads, [ROW]);
  assert.ok(result.excluded.some(line => line.includes('manifest') && line.includes('hook')));
});
