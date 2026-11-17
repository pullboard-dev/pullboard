/** @pullboard-test-input source-cell packages/gate packages/codemap */
/** @pullboard-world-pin reads the gate sources and the committed plan to prove the freeze.js and freeze-paths.js moves. */
/** The gate logic freeze.js and freeze-paths.js sit in the shell cell under distinct names, with importers repointed [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const GATE = new URL('../../', import.meta.url);
const PLAN = new URL('../../../codemap/data/plan/', import.meta.url);
const read = (base, path) => readFileSync(new URL(path, base), 'utf8');

test('clause 1: gate freeze.js and freeze-paths.js sit in the shell cell in the cells plan with importers repointed [C7]', () => {
  // The shell cell already owns io/test/freeze.js, so the moved plan module takes a distinct name beside it.
  for (const moved of ['src/io/test/freeze/plan.js', 'src/io/test/freeze/paths.js', 'src/io/test/freeze.js']) assert.ok(existsSync(new URL(moved, GATE)), moved);
  for (const gone of ['src/logic/test/freeze.js', 'src/logic/test/freeze-paths.js']) assert.ok(!existsSync(new URL(gone, GATE)), gone);
  const shell = read(GATE, 'src/io/test/freeze.js');
  assert.match(shell, /from '\.\/freeze\/plan\.js'/u);
  assert.match(shell, /from '\.\/freeze\/paths\.js'/u);
  assert.doesNotMatch(shell, /logic\/test\/freeze/u);
  const plan = `${read(PLAN, 'renames.tsv')}${read(PLAN, 'path-map/freeze.json')}${read(PLAN, '34-gate.json')}`;
  assert.ok(!plan.includes('gate/src/logic/test/freeze'));
});
