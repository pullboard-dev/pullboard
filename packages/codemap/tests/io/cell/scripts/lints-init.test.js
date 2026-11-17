/** @pullboard-test-input packages/codemap/src/io/cell/scripts/lints.js */
/** Initializing the cell lint baseline stages its new shards so the verify can see them [C7,CD64]. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { fixture } from '../../../../../landing/tests/fixtures/plan.js';
import { git } from '../../../../../landing/tests/fixtures/plan.js';

const BIN = fileURLToPath(new URL('../../../../src/io/cell/scripts/lints.js', import.meta.url));

/** Run the lint script's main in a worker thread with the given arguments; no process starts [C7]. */
function runLints(...args) {
  return new Promise((done, fail) => {
    // A worker thread is not a test file: give it no test preload and no test-file pool, or it would claim this file's admission again.
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

test('codemap.lints-init.lints-js-init-stages-the: lints.js --init stages the baseline directory so a fresh baseline verifies without CELL_BASELINE, clause 1 [C7,CD64]', async t => {
  const { root } = fixture(t);
  const initial = await runLints('--init', root);
  assert.equal(initial.status, 0, initial.stderr);
  assert.doesNotMatch(initial.stderr, /CELL_BASELINE/u);
  const tracked = git(root, 'ls-files', 'packages/codemap/data/baselines/lints');
  assert.match(tracked, /baselines\/lints\/index\.json/u, 'the descriptor is staged');
  assert.match(tracked, /baselines\/lints\/.+-\d+\.json/u, 'every shard is staged');
});
