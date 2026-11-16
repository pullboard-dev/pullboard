/** @pullboard-test-input packages/codemap/src/io/cells/scripts/plan.js */
/** plan.js --cuts-all sweeps every cell strictly and names each hidden edge by file [C7,D3]. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { computePlan } from '../../../../index.js';
import { writePlan } from '../../../../index.js';
import { fixture } from '../../../../../landing/tests/fixtures/plan.js';
import { git } from '../../../../../landing/tests/fixtures/plan.js';

const BIN = fileURLToPath(new URL('../../../../src/io/cells/scripts/plan.js', import.meta.url));

/** Run the plan script's main in a worker thread with the given arguments; no process starts [C7]. */
function runPlan(...args) {
  return new Promise((done, fail) => {
    // A worker thread is not a test file: give it no test preload and no test-file pool.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.PULLBOARD_TEST_FILE_POOL;
    const worker = new Worker(BIN, { argv: args, stderr: true, env, execArgv: [] });
    let stderr = '';
    worker.stderr.on('data', chunk => { stderr += chunk; });
    worker.on('error', error => { stderr += error.stack ?? String(error); });
    worker.on('exit', status => done({ status, stderr }));
    worker.on('messageerror', fail);
  });
}

test('clause 1: --cuts-all runs the strict check for every cell and prints every hidden edge by file [C7,D3]', async t => {
  const { root, put } = fixture(t);
  writePlan(root, computePlan(root));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'plan');
  // Two earlier cells each reach a later cell; each hidden edge is named, in the cell that holds it.
  put('src/refused.js', "import { stats } from './stats.js';\nexport class Refused extends Error {}\nexport const hidden = stats;\n");
  put('src/board.js', "import { Refused } from './refused.js';\nimport { claims } from './claims.js';\nimport { flow } from './stats-flow.js';\nexport const board = () => [Refused, claims, flow];\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'hidden edges');
  const swept = await runPlan('--cuts-all', root);
  assert.equal(swept.status, 1, swept.stderr);
  assert.match(swept.stderr, /kernel --cuts-all: kernel still imports later stats: src\/refused\.js -> src\/stats\.js/u);
  assert.match(swept.stderr, /store --cuts-all: store still imports later items: src\/board\.js -> src\/claims\.js/u, 'the fixture cycle between store and items is named too');
  assert.match(swept.stderr, /store --cuts-all: store still imports later stats: src\/board\.js -> src\/stats-flow\.js/u);
});
