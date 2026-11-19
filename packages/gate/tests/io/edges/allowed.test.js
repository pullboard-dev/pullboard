/** The cells edge scanner reports an allowedEdges entry no import uses, and stays quiet for one that is used [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  after,
  test,
} from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import {
  EDGE_FILES,
  cellsEdgeProblems,
  declaredEdges,
  unusedAllowedEdges,
} from '../../../src/io/edges.js';

const made = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A fixture where cell a imports cell b's index, the plan declares the given edges, and `edgeFiles` maps a name in the edge folder to its text. */
function fixture(allowedEdges, edgeFiles = {}) {
  const inputs = privateFixtureFiles('cells-edges-allowed-');
  made.push(inputs.root);
  const files = {
    'packages/codemap/data/plan/cells.json': JSON.stringify({ cells: [], allowedEdges }),
    'packages/b/index.js': 'export const b = 1;\n',
    'packages/a/index.js': "import { b } from '../b/index.js';\nexport const a = b;\n",
  };
  for (const [name, text] of Object.entries(edgeFiles)) files[`${EDGE_FILES}/${name}`] = text;
  for (const [file, text] of Object.entries(files)) inputs.write(file, text);
  return inputs.root;
}

const NO_CEILINGS = { ceilings: { files: {}, cells: {} } };

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

test('gate.io-edges-allowed.an-edge-file-declares-its-edge: clause 1: an edge file declares its edge like an allowedEdges entry, and an unused one is reported naming the file [C7]', () => {
  const root = fixture([], { 'a__b.json': '{"edge": "a->b"}\n', 'b__a.json': '{"edge": "b->a"}\n' });
  assert.equal(declaredEdges(root).has('a->b'), true);
  const problems = cellsEdgeProblems(root, NO_CEILINGS);
  assert.deepEqual(problems.filter(problem => /gains an edge|cross-cell import/u.test(problem.text)), [], 'the file declares a->b, so a importing b is no new edge');
  const stale = problems.filter(problem => /used by no import/u.test(problem.text));
  assert.equal(stale.length, 1);
  assert.equal(stale[0].path, `${EDGE_FILES}/b__a.json`);
  assert.match(stale[0].text, /"b->a".*delete packages\/codemap\/data\/edges\/b__a\.json/u);
});

test('gate.io-edges-allowed.a-bad-or-twice-declared-edge-file-is-refused: clause 2: an edge file that declares no edge, is not named after its edge, or repeats an allowedEdges entry is refused [C7]', () => {
  const root = fixture(['a->b'], { 'a__b.json': '{"edge": "a->b"}\n', 'empty.json': '{}\n', 'wrong.json': '{"edge": "a->b/src"}\n' });
  const texts = cellsEdgeProblems(root, NO_CEILINGS).filter(problem => problem.path.startsWith(`${EDGE_FILES}/`) && !/used by no import/u.test(problem.text))
    .map(problem => `${problem.path}: ${problem.text}`);
  assert.deepEqual(texts, [
    `${EDGE_FILES}/a__b.json: edge "a->b" is declared twice, here and in allowedEdges of the cells plan; delete this file`,
    `${EDGE_FILES}/empty.json: edge file declares no edge; write {"edge": "<from>-><to>"} in it`,
    `${EDGE_FILES}/wrong.json: edge file for "a->b/src" must be named ${EDGE_FILES}/a__b.src.json`,
  ]);
  assert.deepEqual(cellsEdgeProblems(fixture([], { 'a__b.json': '{"edge": "a->b"}\n' }), NO_CEILINGS), [], 'a well-named file alone stands');
});
