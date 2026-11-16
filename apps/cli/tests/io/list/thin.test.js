/** The thin list door returns the full path's rows and loads none of the board barrel [C7,#9091]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { fixtureAdd } from '../../fixtures/testkit.js';
import { thinListRows } from '../../../src/io/list/thin.js';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const PRELOAD = fileURLToPath(new URL('../../../journeys/imports/count.js', import.meta.url));
const DOOR = fileURLToPath(new URL('../../../src/io/list/thin.js', import.meta.url));
/** The board barrel and its door: what the full list path loads through apps/cli/src/io/ports/process.js. */
const BARREL = ['packages/board/index.js', 'apps/lib/light.js'];

test('clause 1: the thin door returns the same rows as the full list path for 20 items in mixed states [C7]', async (t) => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project();
  for (let n = 1; n <= 20; n++) {
    const added = await fixtureAdd(box.runLocal, box.repo, 'web', `Thin list item ${n}`);
    assert.equal(added.code, 0, added.err);
  }
  assert.equal((await box.runLocal(box.web, 'claim', '1')).code, 0);
  for (const id of ['2', '3']) assert.equal((await box.runLocal(box.repo, 'hold', id, 'held for the thin list test')).code, 0);
  for (const all of [false, true]) {
    const full = await box.runLocal(box.repo, 'list', ...(all ? ['--all'] : []), '--json');
    assert.equal(full.code, 0, full.err);
    const expected = JSON.parse(full.out);
    const thin = thinListRows({ cwd: box.repo, all });
    assert.ok(thin, 'the door served a current board');
    assert.equal(thin.items.length, expected.items.length);
    assert.deepEqual(JSON.parse(JSON.stringify(thin.items)), expected.items);
    assert.deepEqual(JSON.parse(JSON.stringify(thin.needsRescope)), expected.needsRescope);
  }
});

/** Load the door in a fresh worker thread with count.js recording every file the thread loads: a thread, not a process, so no launch is paid. */
function loadedByDoor(countFile) {
  const code = `const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.preload).then(() => import(workerData.door)).then(() => parentPort.postMessage('loaded'), (error) => parentPort.postMessage(String(error?.stack ?? error)));`;
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, env: { ...process.env, PULLBOARD_COUNT_FILE: countFile }, workerData: { preload: pathToFileURL(PRELOAD).href, door: pathToFileURL(DOOR).href } });
    worker.once('message', (message) => { void worker.terminate(); resolve(message); });
    worker.once('error', reject);
  });
}

test('clause 2: loading the thin door pulls in none of the board barrel modules [C7]', async () => {
  const files = privateFixtureFiles('thin-list-');
  files.write('seen.txt', '');
  assert.equal(await loadedByDoor(`${files.root}/seen.txt`), 'loaded');
  const seen = files.read('seen.txt').toString('utf8').split('\n').filter(Boolean).map(url => fileURLToPath(url).slice(ROOT.length));
  assert.ok(seen.some(path => path.endsWith('apps/cli/src/io/list/thin.js')), 'the door itself loaded');
  assert.deepEqual(seen.filter(path => BARREL.includes(path) || path.startsWith('packages/board/')), []);
});
