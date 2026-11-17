/** The cells edge scanner reports an allowedEdges entry no import uses, and stays quiet for one that is used [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  after,
  test,
} from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import {
  cellsEdgeProblems,
  unusedAllowedEdges,
} from '../../../src/io/edges.js';

const made = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A fixture where cell a imports cell b's index, and the plan declares the given edges. */
function fixture(allowedEdges) {
  const inputs = privateFixtureFiles('cells-edges-allowed-');
  made.push(inputs.root);
  const files = {
    'packages/codemap/data/plan/cells.json': JSON.stringify({ cells: [], allowedEdges }),
    'packages/b/index.js': 'export const b = 1;\n',
    'packages/a/index.js': "import { b } from '../b/index.js';\nexport const a = b;\n",
  };
  for (const [file, text] of Object.entries(files)) inputs.write(file, text);
  return inputs.root;
}

test('gate.io-edges-allowed.an-allowededges-entry-no-import-uses: clause 1: an allowedEdges entry no import uses is reported as stale [C7]', () => {
  const root = fixture(['a->b', 'b->a']);
  assert.deepEqual(unusedAllowedEdges(root), ['b->a']);
  const stale = cellsEdgeProblems(root, { ceilings: { files: {}, cells: {} } }).filter(problem => /used by no import/u.test(problem.text));
  assert.equal(stale.length, 1);
  assert.match(stale[0].text, /"b->a"/u);
});

test('gate.io-edges-allowed.an-allowededges-entry-an-import-uses: clause 1: an allowedEdges entry an import uses stays quiet [C7]', () => {
  const root = fixture(['a->b']);
  assert.deepEqual(unusedAllowedEdges(root), []);
  assert.deepEqual(cellsEdgeProblems(root, { ceilings: { files: {}, cells: {} } }).filter(problem => /used by no import/u.test(problem.text)), []);
});

test('gate.io-edges-allowed.the-committed-plan-carries-no-allowededges: clause 1: the committed plan carries no allowedEdges entry that no import uses [C7]', () => {
  const root = new URL('../../../../../', import.meta.url).pathname;
  assert.deepEqual(unusedAllowedEdges(root), []);
});
