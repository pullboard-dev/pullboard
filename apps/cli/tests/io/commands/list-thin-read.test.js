/** @pullboard-test-input apps/cli/journeys/imports/count.js */
/** With list.thinRead on, pullboard list prints what it printed before and loads far fewer modules [C7,#9089]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
const e2e = createE2eHelpers();
after(e2e.cleanup);

let box = null;
before(async () => {
  box = e2e.project();
  for (const title of ['First thin item', 'Second thin item', 'Third thin item']) {
    const added = await fixtureAdd(box.runLocal, box.repo, 'web', title);
    assert.equal(added.code, 0, added.err);
  }
});

/** Turn list.thinRead on or off in the fixture machine's settings file, keeping its other settings. */
function setThinRead(on) {
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  if (on === null) delete settings.list; else settings.list = { thinRead: on };
  writeFileSync(file, JSON.stringify(settings));
}

/** `pullboard list` through the production dispatch in this process, with the output and exit code. */
async function listOnce(...args) {
  const run = await box.runLocal(box.repo, 'list', ...args);
  return { out: run.out, err: run.err, code: run.code };
}

/** The distinct repo files a fresh worker thread loads running `list` through the process entry's own composition, counted by count.js: a thread, not a process. */
function modulesLoaded(countFile) {
  const code = `const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      await import(workerData.preload);
      const { main } = await import(workerData.main);
      const { loadNativeBoard, loadProcessPorts, gateWaitReporter } = await import(workerData.ports);
      const sink = { isTTY: false, write: () => true };
      return main(['list'], { cwd: workerData.cwd, loadNativeBoard, gateWaitReporter, loadProcessPorts, stdout: sink, stderr: sink, stdin: process.stdin });
    })().then((status) => parentPort.postMessage({ status }), (error) => parentPort.postMessage({ failure: String(error?.stack ?? error) }));`;
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, env: { ...box.env, PULLBOARD_OWN_CLI: '1', PULLBOARD_RESIDENT: '0', PULLBOARD_COUNT_FILE: countFile },
      workerData: { cwd: box.repo, preload: pathToFileURL(PRELOAD).href, main: pathToFileURL(`${ROOT}apps/cli/src/io/main.js`).href, ports: pathToFileURL(`${ROOT}apps/cli/src/io/ports/process.js`).href } });
    worker.once('message', (message) => { void worker.terminate(); resolve(message); });
    worker.once('error', reject);
  });
}

/** How many distinct repo files `list` loads in a fresh thread with list.thinRead set as given. */
async function countFor(on) {
  setThinRead(on);
  const files = privateFixtureFiles('list-thin-');
  files.write('seen.txt', '');
  const result = await modulesLoaded(`${files.root}/seen.txt`);
  assert.equal(result.failure, undefined, result.failure);
  assert.equal(result.status, 0);
  return new Set(files.read('seen.txt').toString('utf8').split('\n').filter(Boolean)).size;
}

test('cli.io-commands-list-thin-read.with-list-thinread-on-pullboard-list-prints: clause 1: with list.thinRead on, pullboard list prints the same output and exit code as with it off [C7]', async () => {
  for (const args of [[], ['--all'], ['--json'], ['web']]) {
    setThinRead(false);
    const off = await listOnce(...args);
    setThinRead(true);
    const on = await listOnce(...args);
    assert.equal(off.code, 0, off.err);
    assert.equal(on.code, off.code, on.err);
    assert.equal(on.out, off.out);
    assert.match(off.out, /Third thin item|"items"/u);
  }
  setThinRead(null);
});

test('cli.io-commands-list-thin-read.with-list-thinread-on-pullboard-list-loads: clause 2: with list.thinRead on, pullboard list loads fewer than 300 modules [C7]', async () => {
  const loaded = await countFor(true);
  setThinRead(null);
  assert.ok(loaded < 300, `list loaded ${loaded} modules with list.thinRead on`);
});

test('cli.io-commands-list-thin-read.with-list-thinread-on-list-never-loads: clause 2: with list.thinRead on, list never loads more modules than with it off [C7]', async () => {
  const off = await countFor(false);
  const on = await countFor(true);
  setThinRead(null);
  assert.ok(on <= off, `thin ${on} modules, full ${off}`);
});
