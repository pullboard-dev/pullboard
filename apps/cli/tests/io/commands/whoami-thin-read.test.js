/** With read.thinCommands on, pullboard whoami prints what it printed before and loads fewer than 300 modules [C7,#9811]. */
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

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const PRELOAD = fileURLToPath(new URL('../../../journeys/imports/count.js', import.meta.url));
const e2e = createE2eHelpers();
after(e2e.cleanup);

let box = null;
before(() => { box = e2e.project(); });

/** Turn read.thinCommands on or off in the fixture machine's settings file, keeping its other settings. */
function setThin(on) {
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  if (on === null) delete settings.read; else settings.read = { thinCommands: on };
  writeFileSync(file, JSON.stringify(settings));
}

/** `pullboard whoami` through the production dispatch in this process, in the joined seat, with the output and exit code. */
async function whoamiOnce(...args) {
  const run = await box.runLocal(box.web, 'whoami', ...args);
  return { out: run.out, err: run.err, code: run.code };
}

/** The distinct repo files a fresh worker thread loads running `whoami` in the joined seat through the process entry's own composition, counted by count.js: a thread, not a process. */
function modulesLoaded(countFile) {
  const code = `const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      await import(workerData.preload);
      const { main } = await import(workerData.main);
      const { loadNativeBoard, loadProcessPorts, gateWaitReporter } = await import(workerData.ports);
      const sink = { isTTY: false, write: () => true };
      return main(['whoami'], { cwd: workerData.cwd, loadNativeBoard, gateWaitReporter, loadProcessPorts, stdout: sink, stderr: sink, stdin: process.stdin });
    })().then((status) => parentPort.postMessage({ status }), (error) => parentPort.postMessage({ failure: String(error?.stack ?? error) }));`;
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, env: { ...box.env, PULLBOARD_OWN_CLI: '1', PULLBOARD_RESIDENT: '0', PULLBOARD_COUNT_FILE: countFile },
      workerData: { cwd: box.web, preload: pathToFileURL(PRELOAD).href, main: pathToFileURL(`${ROOT}apps/cli/src/io/main.js`).href, ports: pathToFileURL(`${ROOT}apps/cli/src/io/ports/process.js`).href } });
    worker.once('message', (message) => { void worker.terminate(); resolve(message); });
    worker.once('error', reject);
  });
}

/** How many distinct repo files `whoami` loads in a fresh thread with read.thinCommands set as given. */
async function countFor(on) {
  setThin(on);
  const files = privateFixtureFiles('whoami-thin-');
  files.write('seen.txt', '');
  const result = await modulesLoaded(`${files.root}/seen.txt`);
  assert.equal(result.failure, undefined, result.failure);
  assert.equal(result.status, 0);
  return new Set(files.read('seen.txt').toString('utf8').split('\n').filter(Boolean)).size;
}

test('cli.io-commands-whoami-thin-read.with-read-thincommands-on-pullboard-whoami-prints: clause 1: with read.thinCommands on, pullboard whoami prints the same output and exit code as with it off [C7,#9811]', async () => {
  for (const args of [[], ['--json']]) {
    setThin(false);
    const off = await whoamiOnce(...args);
    setThin(true);
    const on = await whoamiOnce(...args);
    assert.equal(off.code, 0, off.err);
    assert.equal(on.code, off.code, on.err);
    assert.equal(on.out, off.out);
    assert.match(off.out, /web-1/u);
  }
  setThin(null);
});

test('cli.io-commands-whoami-thin-read.with-read-thincommands-on-pullboard-whoami-loads: clause 2: with read.thinCommands on, pullboard whoami loads fewer than 300 modules [C7,#9811]', async () => {
  const loaded = await countFor(true);
  setThin(null);
  assert.ok(loaded < 300, `whoami loaded ${loaded} modules with read.thinCommands on`);
});

test('cli.io-commands-whoami-thin-read.with-read-thincommands-on-whoami-never-loads: clause 2: with read.thinCommands on, whoami never loads more modules than with it off [C7,#9811]', async () => {
  const off = await countFor(false);
  const on = await countFor(true);
  setThin(null);
  assert.ok(on <= off, `thin ${on} modules, full ${off}`);
});

test('cli.io-commands-whoami-thin-read.with-read-thincommands-off-the-full-path: clause 3: with read.thinCommands off, the full path serves whoami as today, in a seat and in the main checkout [C7,#9811]', async () => {
  setThin(false);
  const seat = await whoamiOnce();
  assert.equal(seat.code, 0, seat.err);
  assert.match(seat.out, /web-1 \(fixture-model\) \(web lane\)/u);
  const main = await box.runLocal(box.repo, 'whoami');
  assert.equal(main.code, 0, main.err);
  setThin(true);
  const mainOn = await box.runLocal(box.repo, 'whoami');
  assert.equal(mainOn.out, main.out);
  setThin(null);
});
