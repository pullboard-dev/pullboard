/** Keep either front door importable first without a setupHelp ReferenceError [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const root = new URL('../../../../', import.meta.url);

/**
 * Import two front doors in order inside a fresh worker thread and resolve with what it reports.
 *
 * Why: a worker has its own module registry, so an import-order bug shows as in a fresh process without a child
 * process launch, which the launch ceiling refuses to grow.
 */
function importInOrder(first, second) {
  const script = `const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  await import(workerData.first); await import(workerData.second);
  parentPort.postMessage('loaded');
})().catch(error => parentPort.postMessage('failed: ' + error.message));`;
  return new Promise((resolve, reject) => {
    const worker = new Worker(script, { eval: true, workerData: {
      first: pathToFileURL(new URL(first, root).pathname).href, second: pathToFileURL(new URL(second, root).pathname).href } });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

test('clause 1: importing the view front door, then the cli one, loads with no ReferenceError [C7]', async () => {
  assert.equal(await importInOrder('apps/view/index.js', 'apps/cli/index.js'), 'loaded');
});

test('clause 2: importing the cli front door, then the view one, loads with no ReferenceError [C7]', async () => {
  assert.equal(await importInOrder('apps/cli/index.js', 'apps/view/index.js'), 'loaded');
});
