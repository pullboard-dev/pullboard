/** With list.thinRead on, the thin list door loads neither the board barrel nor the outbox barrel; the failure names each importing file [C7,#9278]. @pullboard-test-input source-cell apps/cli packages/board packages/outbox packages/store packages/git packages/sandbox */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { before } from 'node:test';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { fixtureAdd } from '../../fixtures/testkit.js';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const PRELOAD = fileURLToPath(new URL('../../../journeys/imports/count.js', import.meta.url));
const BARRELS = [`${ROOT}packages/board/index.js`, `${ROOT}packages/outbox/index.js`];
const e2e = createE2eHelpers();
after(e2e.cleanup);

let box = null;
before(async () => {
  box = e2e.project();
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Thin graph item');
  assert.equal(added.code, 0, added.err);
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  settings.list = { thinRead: true };
  writeFileSync(file, JSON.stringify(settings));
});

/** The repo files a fresh worker thread loads running `list` through the process entry's own composition, read from count.js's file-URL log. */
function loadedFiles(countFile) {
  const code = `const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      await import(workerData.preload);
      const { main } = await import(workerData.main);
      const { loadNativeBoard, loadProcessPorts, gateWaitReporter } = await import(workerData.ports);
      const sink = { isTTY: false, write: () => true };
      return main(['list'], { cwd: workerData.cwd, loadNativeBoard, gateWaitReporter, loadProcessPorts, stdout: sink, stderr: sink, stdin: process.stdin });
    })().then((status) => parentPort.postMessage({ status }), (error) => parentPort.postMessage({ failure: String(error?.stack ?? error) }));`;
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(code, { eval: true, env: { ...box.env, PULLBOARD_OWN_CLI: '1', PULLBOARD_RESIDENT: '0', PULLBOARD_COUNT_FILE: countFile },
      workerData: { cwd: box.repo, preload: pathToFileURL(PRELOAD).href, main: pathToFileURL(`${ROOT}apps/cli/src/io/main.js`).href, ports: pathToFileURL(`${ROOT}apps/cli/src/io/ports/process.js`).href } });
    worker.once('message', (message) => { void worker.terminate(); resolvePromise(message); });
    worker.once('error', reject);
  });
}

/** The loaded files whose static import or export specifiers resolve to the barrel, so a failure names who pulled it in. */
function importersOf(barrel, loaded) {
  return loaded.filter((file) => {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:import|export)\s[^;'"]*?from\s*['"](\.[^'"]+)['"]|import\s*['"](\.[^'"]+)['"]/gu)) {
      if (resolve(dirname(file), match[1] ?? match[2]) === barrel) return true;
    }
    return false;
  });
}

test('clause 1: with list.thinRead on, the thin list door loads neither the board barrel nor the outbox barrel [C7,#9278]', async () => {
  const files = privateFixtureFiles('thin-graph-');
  files.write('seen.txt', '');
  const result = await loadedFiles(`${files.root}/seen.txt`);
  assert.equal(result.failure, undefined, result.failure);
  assert.equal(result.status, 0);
  const loaded = [...new Set(files.read('seen.txt').toString('utf8').split('\n').filter(Boolean).map((url) => fileURLToPath(url)))];
  const found = BARRELS.filter((barrel) => loaded.includes(barrel));
  const report = found.map((barrel) => `${barrel.slice(ROOT.length)} imported by ${importersOf(barrel, loaded).map((file) => file.slice(ROOT.length)).join(', ') || 'a dynamic import'}`);
  assert.deepEqual(report, [], `the thin list door loaded a barrel: ${report.join('; ')}`);
});

test('clause 2: the importer finder names the file that imports a barrel it is given [C7,#9278]', () => {
  const loaded = [`${ROOT}apps/lib/light.js`, `${ROOT}apps/cli/src/io/list/thin.js`];
  assert.ok(importersOf(`${ROOT}packages/store/light.js`, loaded).includes(`${ROOT}apps/cli/src/io/list/thin.js`));
  assert.deepEqual(importersOf(`${ROOT}packages/nothing.js`, loaded), []);
});
