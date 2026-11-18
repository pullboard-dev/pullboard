/** The cells edge scanner refuses an allowedEdges entry that points up the cell order, and a grandfather list names the existing ones [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  after,
  test,
} from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import {
  cellsEdgeProblems,
  upwardAllowedEdges,
} from '../../../src/io/edges.js';

const made = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
const CEILINGS = { ceilings: { files: {}, cells: {} } };

/** A fixture plan ordering cells low (1) and high (2); high imports low, low imports high, and the plan declares the given edges. */
function fixture(allowedEdges, extra = {}) {
  const inputs = privateFixtureFiles('cells-edges-order-');
  made.push(inputs.root);
  const plan = { cells: [{ order: 1, name: 'low' }, { order: 2, name: 'high' }], allowedEdges, ...extra };
  const files = {
    'packages/codemap/data/plan/cells.json': JSON.stringify(plan),
    'packages/low/index.js': "import { high } from '../high/index.js';\nexport const low = high;\n",
    'packages/high/index.js': "import { low } from '../low/index.js';\nexport const high = low;\n",
  };
  for (const [file, text] of Object.entries(files)) inputs.write(file, text);
  return inputs.root;
}

const upward = root => cellsEdgeProblems(root, CEILINGS).filter(problem => /points up the cell order/u.test(problem.text));

test('gate.io-edges-order.an-allowededges-entry-to-a-higher: clause 1: an allowedEdges entry to a higher cell is refused, naming the entry and both orders [C7]', () => {
  const refused = upward(fixture(['low->high']));
  assert.equal(refused.length, 1);
  assert.match(refused[0].text, /"low->high"/u);
  assert.match(refused[0].text, /low is order 1, high is order 2/u);
});

test('gate.io-edges-order.an-allowededges-entry-to-a-same: clause 1: an allowedEdges entry to a same-order cell or a deep entry to a higher cell is refused too [C7]', () => {
  assert.equal(upward(fixture(['low->high/src'])).length, 1);
  assert.equal(upward(fixture(['low->low'])).length, 1);
});

test('gate.io-edges-order.an-allowededges-entry-to-a-lower: clause 1: an allowedEdges entry to a lower cell passes [C7]', () => {
  assert.deepEqual(upward(fixture(['high->low'])), []);
  assert.deepEqual(upwardAllowedEdges(fixture(['high->low'])), []);
});

test('gate.io-edges-order.an-upward-entry-named-in-the: clause 3: an upward entry named in the grandfather list passes and the committed plan has no ungrandfathered one [C7]', () => {
  assert.deepEqual(upward(fixture(['low->high'], { upwardEdgesGrandfathered: ['low->high'] })), []);
  const root = new URL('../../../../../', import.meta.url).pathname;
  assert.deepEqual(upwardAllowedEdges(root), []);
});
