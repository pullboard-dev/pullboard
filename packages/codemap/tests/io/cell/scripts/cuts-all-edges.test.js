/** @pullboard-test-input packages/codemap/src/io/cells/scripts/plan.js packages/codemap/data/plan/cells.json */
/** @pullboard-world-pin: clause 1 runs the strict cells sweep over this repository's committed tree. */
/** The four hidden upward edges measured on 31 Oct stay removed under the strict sweep [C7,D3]. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';

const BIN = fileURLToPath(new URL('../../../../src/io/cells/scripts/plan.js', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));

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

test('codemap.cuts-all-edges.cuts-all-reports-none-of: clause 2: --cuts-all reports none of the four hidden upward edges measured 31 Oct [C7,D3]', async () => {
  const swept = await runPlan('--cuts-all', ROOT);
  // The sweep itself ran: it names other findings, so an empty report cannot pass by never looking.
  assert.match(swept.stderr, / --cuts-all: /u, swept.stderr.slice(0, 400));
  // Each edge is the importing file and its target exactly as the sweep prints them.
  const edges = [
    'packages/commits/src/logic/import-only-change.js -> packages/codemap/src/io/module/imports.js',
    'packages/store/src/io/board/ports.js -> packages/health/index.js',
    'apps/runner/src/io/shell.js -> apps/runner/src/io/custody.js',
    'apps/runner/src/io/controller.js -> apps/runner/src/io/private/guard.js',
  ];
  for (const edge of edges) assert.ok(!swept.stderr.includes(edge), `the sweep still reports ${edge}`);
});
