/** The edge ratchet lists the six durable cells and refuses any backwards edge between them [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import {
  DURABLE_CELLS,
  cellsEdgeProblems,
  cellsEdgeReport,
  ceilingsOf,
  durableEdgeProblems,
} from '../../../src/io/edges.js';

const REPO = join(import.meta.dirname, '../../../../..');
const made = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/**
 * A fixture tree of the six durable cells, each with an index, an optional plan of allowed edges, and extra files.
 *
 * @param {Record<string, string>} files - Extra repo-relative files and their text.
 * @param {string[]} [allowedEdges] - The plan's declared edges.
 * @returns {string} the fixture root
 */
function fixture(files, allowedEdges) {
  const inputs = privateFixtureFiles('durable-cells-');
  made.push(inputs.root);
  const cells = Object.fromEntries(Object.keys(DURABLE_CELLS).map(cell => [`packages/${cell}/index.js`, `export const ${cell} = 1;\n`]));
  const all = { 'packages/codemap/data/plan/cells.json': JSON.stringify({ cells: [], ...(allowedEdges ? { allowedEdges } : {}) }), ...cells, ...files };
  for (const [file, text] of Object.entries(all)) inputs.write(file, text);
  return inputs.root;
}

test('gate.io-edges-durable.the-edge-ratchet-lists-the-six: clause 1: the edge ratchet lists the six durable cells and refuses any backwards edge between them, even a declared one [C7]', () => {
  assert.deepEqual(Object.keys(DURABLE_CELLS), ['jobs', 'drive', 'transport', 'receipt', 'pin', 'land'], 'the ratchet lists the six cells');
  assert.deepEqual(durableEdgeProblems(REPO), [], 'today\'s tree keeps the durable table');

  const downward = {
    'packages/land/src/finish.js': "import { receipt } from '../../receipt/index.js';\nimport { jobs } from '../../jobs/index.js';\nimport { pin } from '../../pin/index.js';\nexport const finish = receipt + jobs + pin;\n",
    'packages/drive/src/loop.js': "import { transport } from '../../transport/index.js';\nexport const loop = transport;\n",
    'packages/receipt/src/judge.js': "import { pin } from '../../pin/index.js';\nexport const judge = pin;\n",
    'packages/transport/src/send.js': "import { pin } from '../../pin/index.js';\nexport const send = pin;\n",
  };
  assert.deepEqual(durableEdgeProblems(fixture(downward)), [], 'every edge the table allows passes');

  const backwards = {
    'packages/pin/src/up.js': "import { land } from '../../land/index.js';\nexport const up = land;\n",
    'packages/jobs/src/up.js': "import { drive } from '../../drive/index.js';\nexport const up = drive;\n",
    'packages/receipt/src/up.js': "import { transport } from '../../transport/index.js';\nexport const up = transport;\n",
    'packages/land/src/up.js': "import { drive } from '../../drive/index.js';\nexport const up = drive;\n",
  };
  const declared = ['pin->land', 'jobs->drive', 'receipt->transport', 'land->drive'];
  const root = fixture(backwards, declared);
  const text = durableEdgeProblems(root).map(row => `${row.path}:${row.line}: ${row.text}`).join('\n');
  assert.match(text, /packages\/pin\/src\/up\.js:1: backwards edge between durable cells: pin imports land/u);
  assert.match(text, /packages\/jobs\/src\/up\.js:1: backwards edge between durable cells: jobs imports drive/u);
  assert.match(text, /packages\/receipt\/src\/up\.js:1: backwards edge between durable cells: receipt imports transport/u);
  assert.match(text, /packages\/land\/src\/up\.js:1: backwards edge between durable cells: land imports drive/u);
  assert.equal(durableEdgeProblems(root).length, 4, 'each backwards edge is refused once, though the plan declares all four');

  const ceilings = ceilingsOf(cellsEdgeReport(root));
  const ratchet = cellsEdgeProblems(root, { ceilings }).map(row => row.text);
  assert.equal(ratchet.filter(line => line.startsWith('backwards edge between durable cells')).length, 4, 'the ratchet itself refuses them');
  const preCommit = cellsEdgeProblems(root, { ceilings, files: ['packages/pin/src/up.js'] });
  assert.deepEqual(preCommit.map(row => row.path), ['packages/pin/src/up.js'], 'the changed-file run refuses the one backwards file');
});
