/** openBoard composes its store ports lazily: a write board opens without the provider packages its ports defer [C7,#7033]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';

const NATIVE = new URL('../../../src/logic/native.js', import.meta.url).href;

/** Provider packages no board open calls: their ports, and rigor's proof and draft runners, load them at first use. */
const DEFERRED = ['blueprints', 'flakes', 'gate', 'github', 'health', 'landing', 'runners', 'sentinels'];

/**
 * The package front doors a fresh worker thread has loaded after opening an in-memory write board and running `steps`.
 * Why a worker thread: it has its own module cache, so this test's own imports must not count as the board's loads, and it starts no process.
 */
async function doorsLoaded(steps = '') {
  const script = `
const { registerHooks } = require('node:module');
const { parentPort } = require('node:worker_threads');
const loaded = new Set();
registerHooks({ load(url, context, next) { loaded.add(url); return next(url, context); } });
(async () => {
  const native = await import(${JSON.stringify(NATIVE)});
  const board = native.openBoard(':memory:');
  ${steps}
  native.closeBoard(board);
  parentPort.postMessage([...loaded].map(url => /\\/packages\\/(\\w+)\\/index\\.js$/u.exec(url)?.[1]).filter(Boolean));
})().catch(error => { parentPort.postMessage({ error: String(error?.stack ?? error) }); });`;
  const worker = new Worker(script, { eval: true, stdout: true, stderr: true });
  const message = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  await worker.terminate();
  assert.ok(Array.isArray(message), message?.error);
  return new Set(message);
}

test('clause 1: openBoard composes its provider modules lazily: a write board opens loading none of the deferred provider packages [C7,#7033]', async () => {
  const loaded = await doorsLoaded();
  assert.ok(loaded.has('store') && loaded.has('rigor'), 'the board opened and warmed its rigor counters');
  assert.deepEqual(DEFERRED.filter(name => loaded.has(name)), [], 'no deferred provider package loads at open');
});

test('clause 1: a deferred port loads its own package at its first call, and only that package [C7,#7033]', async () => {
  const loaded = await doorsLoaded('try { board.nativePorts.landingEnvironment.requireTrunk(); } catch { /* Only the load matters here. */ }');
  assert.ok(loaded.has('landing'), 'the first landing check loads the landing package');
  assert.deepEqual(['blueprints', 'github', 'sentinels'].filter(name => loaded.has(name)), [], 'packages no call reached stay unloaded');
});
