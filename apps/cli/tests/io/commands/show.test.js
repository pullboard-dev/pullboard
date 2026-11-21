/** @pullboard-test-input apps/cli/journeys/imports/count.js */
/** show prints the after-gate ids beside the after line only when the list is not empty, and the measured minutes and rebuilds under it [C7,#11802,#12327]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { fixtureAdd } from '../../fixtures/testkit.js';
import { pinDerivedStateOff } from '../../fixtures/thin-door.js';
import { largeBoard } from '../../fixtures/board/large.js';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { thinShowFacts } from '../../../src/io/show/thin.js';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const PRELOAD = fileURLToPath(new URL('../../../journeys/imports/count.js', import.meta.url));
const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Files an item with the given wait flag on a fresh prerequisite and returns the text of its show. */
async function shownAfter(flag, notes = []) {
  const box = helpers.project();
  const base = ['--criterion', '1. the page renders [test]', '--check', 'node --test web/page.test.js'];
  const first = await box.inProcess(box.repo, 'add', 'web', 'Prerequisite', ...base, '--json');
  assert.equal(first.code, 0, first.err + first.out);
  const firstId = JSON.parse(first.out).item.item_id;
  for (const text of notes) {
    const noted = await box.inProcess(box.repo, 'fact', String(firstId), 'note', text.replace('#7', `#${firstId}`));
    assert.equal(noted.code, 0, noted.err + noted.out);
  }
  const second = await box.inProcess(box.repo, 'add', 'web', 'Waiting item', ...base, flag, String(firstId), '--json');
  assert.equal(second.code, 0, second.err + second.out);
  const shown = await box.inProcess(box.repo, 'show', String(JSON.parse(second.out).item.item_id));
  assert.equal(shown.code, 0, shown.err + shown.out);
  return { text: shown.out, firstId };
}

test('cli.commands-show.after-gate-line: clause 2: show prints an after-gate line naming the ids for an item filed with --after-gate [C7,#11802]', async () => {
  const { text, firstId } = await shownAfter('--after-gate');
  assert.match(text, new RegExp(`^after-gate #${firstId}$`, 'mu'));
});

test('cli.commands-show.no-after-gate-line: clause 2: show prints no after-gate line for an item filed with a plain --after [C7,#11802]', async () => {
  const { text } = await shownAfter('--after');
  assert.doesNotMatch(text, /after-gate/u);
});

test('cli.commands-show.after-gate-measure-line: clause 1: show prints the minutes saved and rebuilds summed from the after-gate parent notes right after the after-gate line [C7,#12327]', async () => {
  const { text, firstId } = await shownAfter('--after-gate', ['after-gate saved: #7 12 min', 'after-gate rebuild: #7 goes back and is rebuilt']);
  assert.match(text, new RegExp(`^after-gate #${firstId}\\nafter-gate: 12 min saved, 1 rebuilds$`, 'mu'));
});

test('cli.commands-show.no-after-gate-measure-line: clause 2: show prints no minutes line for a plain --after or for an after-gate parent with no after-gate notes [C7,#12327]', async () => {
  assert.doesNotMatch((await shownAfter('--after')).text, /min saved/u);
  assert.doesNotMatch((await shownAfter('--after-gate')).text, /min saved/u);
});

/** Turn read.thinCommands on or off in the fixture machine's settings file, keeping its other settings. */
function setThin(box, on) {
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  settings.read = { thinCommands: on };
  writeFileSync(file, JSON.stringify(settings));
}

/** The text and exit code of `pullboard show <id>` with read.thinCommands on or off. */
async function shownThin(box, id, on) {
  setThin(box, on);
  const shown = await box.runLocal(box.repo, 'show', String(id));
  return { out: shown.out, err: shown.err, code: shown.code };
}

test('cli.commands-show.thin-equal: clause 1: [C7,#12413] with read.thinCommands on, show of a fixture item with no receipt, refusal or thread prints the same lines and exit code as with it off', async (t) => {
  const box = helpers.project();
  t.after(pinDerivedStateOff(box));
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Thin show plain item');
  assert.equal(added.code, 0, added.err);
  assert.ok(await thinShowFacts({ cwd: box.repo, id: 1 }), 'the thin door serves this plain item');
  const off = await shownThin(box, 1, false);
  const on = await shownThin(box, 1, true);
  assert.equal(off.code, 0, off.err);
  assert.equal(on.code, off.code, on.err);
  assert.equal(on.out, off.out);
  assert.match(off.out, /Thin show plain item/u);
});

test('cli.commands-show.thin-null-falls-back: clause 2: [C7,#12413] with read.thinCommands on, show of an item with a receipt or a thread entry prints the full path lines, the thin door returning null', async (t) => {
  const box = helpers.project();
  t.after(pinDerivedStateOff(box));
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Thin show noted item');
  assert.equal(added.code, 0, added.err);
  const noted = await box.runLocal(box.repo, 'fact', '1', 'note', 'a thread entry the thin door leaves to the full path');
  assert.equal(noted.code, 0, noted.err);
  assert.equal(await thinShowFacts({ cwd: box.repo, id: 1 }), null, 'the thin door steps aside for an item with a thread entry');
  const off = await shownThin(box, 1, false);
  const on = await shownThin(box, 1, true);
  assert.equal(on.code, off.code, on.err);
  assert.equal(on.out, off.out);
  assert.match(on.out, /a thread entry the thin door leaves to the full path/u);
});

/** The distinct repo files a fresh worker thread loads running `show 1` through the process entry's own composition, counted by count.js. */
function filesLoaded(box, countFile) {
  const code = `const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      await import(workerData.preload);
      const { main } = await import(workerData.main);
      const { loadNativeBoard, loadProcessPorts, gateWaitReporter } = await import(workerData.ports);
      const sink = { isTTY: false, write: () => true };
      return main(['show', '1'], { cwd: workerData.cwd, loadNativeBoard, gateWaitReporter, loadProcessPorts, stdout: sink, stderr: sink, stdin: process.stdin });
    })().then((status) => parentPort.postMessage({ status }), (error) => parentPort.postMessage({ failure: String(error?.stack ?? error) }));`;
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, env: { ...box.env, PULLBOARD_OWN_CLI: '1', PULLBOARD_RESIDENT: '0', PULLBOARD_COUNT_FILE: countFile },
      workerData: { cwd: box.repo, preload: pathToFileURL(PRELOAD).href, main: pathToFileURL(`${ROOT}apps/cli/src/io/main.js`).href, ports: pathToFileURL(`${ROOT}apps/cli/src/io/ports/process.js`).href } });
    worker.once('message', (message) => { void worker.terminate(); resolve(message); });
    worker.once('error', reject);
  });
}

test('cli.commands-show.thin-never-imported-off: clause 3: [C7,#12413] with read.thinCommands off, show never imports the thin door, and with it on it does', async () => {
  const box = helpers.project();
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Thin show import item');
  assert.equal(added.code, 0, added.err);
  const seen = async (on) => {
    setThin(box, on);
    const files = privateFixtureFiles('show-thin-');
    files.write('seen.txt', '');
    const result = await filesLoaded(box, `${files.root}/seen.txt`);
    assert.equal(result.failure, undefined, result.failure);
    assert.equal(result.status, 0);
    return files.read('seen.txt').toString('utf8').split('\n').filter(Boolean);
  };
  assert.equal((await seen(false)).some((file) => file.endsWith('apps/cli/src/io/show/thin.js')), false, 'thin.js stays unloaded with the setting off');
  assert.equal((await seen(true)).some((file) => file.endsWith('apps/cli/src/io/show/thin.js')), true, 'thin.js loads with the setting on');
});

/** The wall-time budget for a warm show on the real-size board, and how many warm runs the median takes. */
const BUDGET_MS = 500;
const RUNS = 5;

/** The id of the first seeded item on a large board. */
function firstSeededId(box) {
  const db = new DatabaseSync(box.board, { readOnly: true });
  try { return Number(db.prepare("SELECT item_id AS id FROM item WHERE item_title LIKE 'Seeded item %' ORDER BY item_id LIMIT 1").get().id); } finally { db.close(); }
}

/** Runs one `show` in this process with a git shim on the PATH, and returns the exit code with the git argument lines the process spawned. */
async function showCountingGit(box, id) {
  const files = privateFixtureFiles('show-git-');
  files.write('git.log', '');
  const log = `${files.root}/git.log`;
  const real = box.env.PATH.split(':').map((dir) => `${dir}/git`).find((path) => { try { return readFileSync(path).length > 0; } catch { return false; } });
  files.write('bin/git', `#!/bin/sh\necho "$@" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(`${files.root}/bin/git`, 0o755);
  const before = process.env.PATH;
  const boxBefore = box.env.PATH;
  process.env.PATH = `${files.root}/bin:${before}`;
  box.env.PATH = process.env.PATH;
  try {
    const shown = await box.inProcess(box.web, 'show', String(id));
    return { code: shown.code, err: shown.err, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  } finally { process.env.PATH = before; box.env.PATH = boxBefore; }
}

/** The git calls that are startup policy, pinned-tool-build or rowOrigins reads: a `git show` of a committed file or a `git blame`. */
function startupReads(calls) {
  return calls.filter((line) => /(^| )(show|blame) /u.test(line));
}

test('cli.io-commands-show.startup-reads-cached: clause 1: [C7,#3281] a repeat show at an unchanged main tip and HEAD runs none of the policyGit, pinned-tool-build or rowOrigins git reads', async (t) => {
  const box = largeBoard(t);
  const id = firstSeededId(box);
  const first = await showCountingGit(box, id);
  assert.equal(first.code, 0, first.err);
  const second = await showCountingGit(box, id);
  assert.equal(second.code, 0, second.err);
  console.log(`# git calls: first show ${first.calls.length}, second show ${second.calls.length}`);
  assert.deepEqual(startupReads(second.calls), [], 'the second show asks git for no committed file and runs no blame');
  assert.ok(second.calls.length <= first.calls.length, `the second show makes no more git calls (${second.calls.length}) than the first (${first.calls.length}): ${second.calls.join(' | ')}`);
});

test('cli.io-commands-show.real-size-under-500ms: clause 2: [C7,#3281] show on the real-size fixture board finishes under 500 ms wall with warm caches', async (t) => {
  const box = largeBoard(t);
  const id = firstSeededId(box);
  const warm = await box.inProcess(box.web, 'show', String(id));
  assert.equal(warm.code, 0, warm.err);
  const samples = [];
  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now();
    const shown = await box.inProcess(box.web, 'show', String(id));
    samples.push(performance.now() - started);
    assert.equal(shown.code, 0, shown.err);
  }
  const middle = [...samples].sort((a, b) => a - b)[Math.floor(RUNS / 2)];
  console.log(`# warm show median ${middle.toFixed(0)} ms (${samples.map((ms) => ms.toFixed(0)).join(', ')})`);
  assert.ok(middle < BUDGET_MS, `warm show median ${middle.toFixed(0)} ms over ${BUDGET_MS} ms`);
});
