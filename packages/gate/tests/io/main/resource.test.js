/** @pullboard-test-loads packages/gate/src/io/browser/admission.js */
/** Real gates and item checks share the machine queue; landing priority and lease behavior stay intact [Q1,Q2,Q4,O5,O6,V18]. */
import { executionServicesSource } from '../../../../../apps/cli/tests/fixtures/gate/execution.js';
import assert from 'node:assert/strict';
import { startFixtureChild as spawn } from '../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureChild as spawnSync } from '../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../../apps/cli/tests/fixtures/child.js';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { quote } from '../../../../../apps/cli/tests/fixtures/gate/resource.js';
import { fixture } from '../../../../../apps/cli/tests/fixtures/gate/resource.js';
import { probeSuite } from '../../../../../apps/cli/tests/fixtures/gate/resource.js';
import { launchTestRunner } from '../../../../../apps/cli/tests/fixtures/gate/resource.js';
import { gateRepo } from '../../../../../apps/cli/tests/fixtures/gate/resource.js';
import { waitFor } from '../../../../../apps/cli/tests/fixtures/gate/resource.js';
import { events } from '../../../../../apps/cli/tests/fixtures/gate/resource.js';
import { RUNNER } from '../../../../../apps/cli/tests/fixtures/gate/resource.js';
import { GATE_MODULE } from '../../../../../apps/cli/tests/fixtures/gate/resource.js';
import { PROBE_PATTERN } from '../../../../../apps/cli/tests/fixtures/gate/resource.js';
import { PROBE_PATH_ENV } from '../../../../../apps/cli/tests/fixtures/gate/resource.js';
import { CHILDREN } from '../../../../../apps/cli/tests/fixtures/gate/resource.js';
import { reapFixtures } from '../../../../../apps/cli/tests/fixtures/gate/resource.js';
import { trackChild } from '../../../../../apps/cli/tests/fixtures/gate/resource.js';

const PROBE_WRITE_TARGET_ENV = 'PULLBOARD_GATE_RESOURCE_WRITE_TARGET';
const PROBE_WRITE_READY_ENV = 'PULLBOARD_GATE_RESOURCE_WRITE_READY';
const PROBE_WRITE_RELEASE_ENV = 'PULLBOARD_GATE_RESOURCE_WRITE_RELEASE';
const BROWSER_ADMISSION_MODULE = pathToFileURL(resolve(import.meta.dirname, '../../../index.js')).href;

after(reapFixtures);

const CONFIG_MODULE = pathToFileURL(resolve(import.meta.dirname, '../../../../config/index.js')).href;

/** The gate command's own engine in a fresh process: the repo's configured gate under the machine queue, printing the wait lines and report the command prints. */
function gateRunScript(box) {
  const script = join(box.dir, 'gate-run.mjs');
  writeFileSync(script, `import { readFileSync } from 'node:fs';
import { runGate, gateReport, gateWaitReporter } from ${JSON.stringify(GATE_MODULE)};
${executionServicesSource(GATE_MODULE)}
const config = JSON.parse(readFileSync('pullboard.json', 'utf8'));
const say = line => console.log(line);
const gate = await runGate(process.cwd(), config, { executionServices, trustStamp: true, agent: 'coordinator', onWait: gateWaitReporter({ say }) });
say(gateReport(gate));
process.exitCode = gate.isGreen ? 0 : 1;
`);
  return script;
}

/** Launch the gate directly in its own process group and collect its output. */
function launch(box, root) {
  return trackChild(spawn(process.execPath, [gateRunScript(box)], { cwd: root, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }));
}

/** Run the gate directly to completion and return its status and output. */
function runGateSync(box, root) {
  return spawnSync(process.execPath, [gateRunScript(box)], { cwd: root, env: box.env, encoding: 'utf8' });
}

/** Set the machine gate capacity through the config cell's writer, as the settings command does; returns the written settings. */
function setGateSlots(box, root, slots) {
  const script = join(box.dir, 'set-gate-slots.mjs');
  writeFileSync(script, `import { setGateSlots } from ${JSON.stringify(CONFIG_MODULE)};\nprocess.stdout.write(JSON.stringify(setGateSlots(Number(process.argv[2]))));\n`);
  const result = spawnSync(process.execPath, [script, String(slots)], { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.failure ?? result.stderr);
  return JSON.parse(result.stdout);
}

/** Set the fixture machine pool to one gate slot before starting holders. */
function setOneGateSlot(box, root) {
  assert.equal(setGateSlots(box, root, 1).gateSlots, 1);
}

/** Launch a real process that holds the production diagnostic resource class until released. */
function launchDiagnostic(box, root, name, started, release, waiting) {
  const script = join(box.dir, `${name}.mjs`);
  writeFileSync(script, `import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { withGateSlot } from ${JSON.stringify(GATE_MODULE)};
${executionServicesSource(GATE_MODULE)}
/** Publish a complete handshake so its visible file always contains its value. */
function publish(file, value) { writeFileSync(file + '.tmp', value); renameSync(file + '.tmp', file); }
await withGateSlot(process.cwd(), async () => {
  publish(${JSON.stringify(started)}, 'started');
  while (!existsSync(${JSON.stringify(release)})) await new Promise(done => setTimeout(done, 10));
}, { executionServices, diagnostic: true, kind: 'main-red', agent: ${JSON.stringify(name)}, onWait: state => publish(${JSON.stringify(waiting)}, String(state.position)) });
`);
  const child = spawn(process.execPath, [script], { cwd: root, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { child.stdoutText += chunk; });
  child.stderr.on('data', chunk => { child.stderrText += chunk; });
  CHILDREN.add(child);
  child.closed = new Promise(resolveClose => child.once('close', (code, signal) => {
    CHILDREN.delete(child);
    resolveClose({ code, signal });
  }));
  return child;
}














test('[Q4,O5,O6] gate processes run one at a time in FIFO order when machine slots are one', async () => {
  const box = fixture();
  const releaseFirst = join(box.dir, 'release-first');
  const roots = ['first', 'second', 'third'].map((name) => gateRepo(box, name, name === 'first' ? 0.1 : 0.2, name === 'first' ? releaseFirst : null));
  assert.equal(setGateSlots(box, roots[0], 1).gateSlots, 1);
  const first = launch(box, roots[0]);
  await waitFor(() => events(box).includes('first start') && !events(box).includes('first end'), 'first gate to remain active', 30_000); // budget: hang ceiling for the private first-gate marker handshake; no throughput claim.
  const second = launch(box, roots[1]);
  await waitFor(() => second.stdoutText.includes('place 1'), 'second gate to enter the FIFO line');
  assert.match(second.stdoutText, /1 running/);
  assert.ok(second.stdoutText.includes(roots[0]), 'wait report names the repo holding the slot');
  const third = launch(box, roots[2]);
  await waitFor(() => third.stdoutText.includes('place 2'), 'third gate to enter behind the second');
  assert.ok(events(box).includes('first start') && !events(box).includes('first end'), 'both successors queued while the first gate still held its slot');
  writeFileSync(releaseFirst, 'release\n');
  const results = await Promise.all([first.closed, second.closed, third.closed]);
  assert.deepEqual(results.map(({ code }) => code), [0, 0, 0], `${first.stderrText}${second.stderrText}${third.stderrText}`);
  const starts = events(box).filter((line) => line.endsWith(' start')).map((line) => line.split(' ')[0]);
  assert.deepEqual(starts, ['first', 'second', 'third']);
  let running = 0;
  let maximum = 0;
  for (const line of events(box)) {
    if (line.endsWith(' start')) running += 1;
    else running -= 1;
    maximum = Math.max(maximum, running);
  }
  assert.equal(maximum, 1);
});

test('[Q4] gates with different PULLBOARD_HOME values share the machine pool unless explicitly separated', async () => {
  const shared = fixture();
  const releaseShared = join(shared.dir, 'release-shared');
  const firstRoot = gateRepo(shared, 'shared-first', 0, releaseShared);
  const otherBoardHome = { ...shared, env: { ...shared.env, PULLBOARD_HOME: join(shared.dir, 'other-board-home') } };
  const secondRoot = gateRepo(otherBoardHome, 'shared-second', 0, releaseShared);
  setGateSlots(shared, firstRoot, 1);
  const first = launch(shared, firstRoot);
  let second;
  try {
    await waitFor(() => events(shared).includes('shared-first start'), 'first shared-pool gate to start');
    second = launch(otherBoardHome, secondRoot);
    await waitFor(
      () => second.stdoutText.includes('place 1') || events(shared).includes('shared-second start'),
      'gate with another board home to queue or start on the shared machine pool',
    );
    assert.ok(second.stdoutText.includes('place 1'), 'the other board home is queued behind the first gate');
    assert.deepEqual(events(shared), ['shared-first start']);
    writeFileSync(releaseShared, 'release');
    const results = await Promise.all([first.closed, second.closed]);
    assert.deepEqual(results.map(({ code }) => code), [0, 0], `${first.stderrText}${second.stderrText}`);
    assert.deepEqual(events(shared), ['shared-first start', 'shared-first end', 'shared-second start', 'shared-second end']);
  } finally {
    writeFileSync(releaseShared, 'release');
    await Promise.all([first, second].filter(Boolean).map((child) => child.closed));
  }

  const separated = fixture();
  const releaseSeparated = join(separated.dir, 'release-separated');
  const firstPool = { ...separated, env: { ...separated.env, PULLBOARD_MACHINE_HOME: join(separated.dir, 'machine-first') } };
  const secondPool = {
    ...separated,
    env: {
      ...separated.env,
      PULLBOARD_MACHINE_HOME: join(separated.dir, 'machine-second'),
    },
  };
  const isolatedFirstRoot = gateRepo(firstPool, 'isolated-first', 0, releaseSeparated);
  const isolatedSecondRoot = gateRepo(secondPool, 'isolated-second', 0, releaseSeparated);
  for (const [box, root] of [[firstPool, isolatedFirstRoot], [secondPool, isolatedSecondRoot]]) {
    setGateSlots(box, root, 1);
  }
  const isolatedFirst = launch(firstPool, isolatedFirstRoot);
  let isolatedSecond;
  try {
    await waitFor(() => events(separated).includes('isolated-first start'), 'first isolated-pool gate to start');
    isolatedSecond = launch(secondPool, isolatedSecondRoot);
    await waitFor(() => events(separated).includes('isolated-second start'), 'explicit private pool to acquire while the first pool is occupied');
    assert.deepEqual(events(separated), ['isolated-first start', 'isolated-second start']);
    writeFileSync(releaseSeparated, 'release');
    const results = await Promise.all([isolatedFirst.closed, isolatedSecond.closed]);
    assert.deepEqual(results.map(({ code }) => code), [0, 0], `${isolatedFirst.stderrText}${isolatedSecond.stderrText}`);
    assert.deepEqual(events(separated).slice(0, 2), ['isolated-first start', 'isolated-second start']);
    assert.deepEqual(events(separated).slice(2).sort(), ['isolated-first end', 'isolated-second end']);
  } finally {
    writeFileSync(releaseSeparated, 'release');
    await Promise.all([isolatedFirst, isolatedSecond].filter(Boolean).map((child) => child.closed));
  }
});

test('[Q4] an exact-tree cached gate starts while another machine gate holds the only slot', async () => {
  const box = fixture();
  const cachedRoot = gateRepo(box, 'cached', 0.1);
  const releaseHolder = join(box.dir, 'release-holder');
  const holderRoot = gateRepo(box, 'holder', 0.1, releaseHolder);
  setGateSlots(box, holderRoot, 1);
  const warm = runGateSync(box, cachedRoot);
  assert.equal(warm.status, 0, warm.stderr);
  const priorCount = events(box).filter((line) => line.startsWith('cached ')).length;
  const holder = launch(box, holderRoot);
  await waitFor(() => events(box).includes('holder start') && !events(box).includes('holder end'), 'uncached holder gate to remain active', 30_000); // budget: hang ceiling for the private holder-gate marker handshake; no throughput claim.
  // A busy equal-capacity write is a no-op; raising capacity is now allowed by #778.
  setGateSlots(box, cachedRoot, 1);
  assert.equal(JSON.parse(readFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), 'utf8')).gateSlots, 1);
  const cached = runGateSync(box, cachedRoot);
  assert.equal(cached.status, 0, cached.stderr);
  assert.match(cached.stdout, /already passed/);
  assert.ok(events(box).includes('holder start') && !events(box).includes('holder end'), 'cached gate returned while the other machine gate still held its slot');
  assert.equal(events(box).filter((line) => line.startsWith('cached ')).length, priorCount, 'cached gate command did not run again');
  writeFileSync(releaseHolder, 'release\n');
  assert.equal((await holder.closed).code, 0, holder.stderrText);
  assert.ok(events(box).includes('holder end'), 'the holder exits only after the test releases it');
});

test('[Q4] SIGKILL during a gate releases its machine slot for the next process', async () => {
  const box = fixture();
  const deadRoot = gateRepo(box, 'dead', 20);
  const nextRoot = gateRepo(box, 'next', 0.1);
  setGateSlots(box, deadRoot, 1);
  const dead = launch(box, deadRoot);
  await waitFor(() => events(box).includes('dead start'), 'gate to hold a slot before it is killed');
  const next = launch(box, nextRoot);
  await waitFor(() => next.stdoutText.includes('place 1'), 'successor gate to queue');
  process.kill(-dead.pid, 'SIGKILL');
  assert.equal((await dead.closed).signal, 'SIGKILL');
  const result = await Promise.race([
    next.closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('successor did not acquire the freed slot')), 5_000)), // budget: hang ceiling for a freed slot acquisition; no throughput claim.
  ]);
  assert.equal(result.code, 0, next.stderrText);
  assert.ok(events(box).includes('next start'));
});


test('[Q1,Q2] an older diagnostic stays ahead of a later ordinary gate', async () => {
  const box = fixture();
  const holderRelease = join(box.dir, 'release-diagnostic-holder');
  const diagnosticRelease = join(box.dir, 'release-diagnostic');
  const diagnosticStarted = join(box.dir, 'older-diagnostic.started');
  const diagnosticWaiting = join(box.dir, 'older-diagnostic.waiting');
  const holderRoot = gateRepo(box, 'diagnostic-holder', 0.1, holderRelease);
  const ordinaryRoot = gateRepo(box, 'later-ordinary-gate', 0.1);
  setOneGateSlot(box, holderRoot);
  const holder = launch(box, holderRoot);
  let diagnostic;
  let ordinary;
  try {
    await waitFor(() => events(box).includes('diagnostic-holder start'), 'the holder to acquire the only gate slot');
    diagnostic = launchDiagnostic(box, holderRoot, 'older-diagnostic', diagnosticStarted, diagnosticRelease, diagnosticWaiting);
    await waitFor(() => existsSync(diagnosticWaiting) || diagnostic.exitCode !== null, 'the older diagnostic to enter the queue');
    assert.equal(readFileSync(diagnosticWaiting, 'utf8'), '1', 'diagnostic is first in the waiting line');
    ordinary = launch(box, ordinaryRoot);
    await waitFor(() => ordinary.stdoutText.includes('place 2') || ordinary.exitCode !== null, 'the later ordinary gate to join behind the diagnostic');
    assert.ok(ordinary.stdoutText.includes('place 2'), 'the ordinary gate is physically second in the queue');
    writeFileSync(holderRelease, 'release\n');
    await waitFor(() => existsSync(diagnosticStarted), 'the older diagnostic to acquire the released slot');
    assert.equal(events(box).includes('later-ordinary-gate start'), false, 'the later ordinary gate stays queued while diagnostics hold the slot');
    writeFileSync(diagnosticRelease, 'release\n');
    await waitFor(() => events(box).includes('later-ordinary-gate start'), 'the ordinary gate to start after diagnostics release');
    const [holderResult, diagnosticResult, ordinaryResult] = await Promise.all([holder.closed, diagnostic.closed, ordinary.closed]);
    assert.equal(holderResult.code, 0, holder.stderrText);
    assert.equal(diagnosticResult.code, 0, diagnostic.stderrText + diagnostic.stdoutText);
    assert.equal(ordinaryResult.code, 0, ordinary.stderrText);
    assert.deepEqual(events(box), ['diagnostic-holder start', 'diagnostic-holder end', 'later-ordinary-gate start', 'later-ordinary-gate end']);
  } finally {
    writeFileSync(holderRelease, 'release\n');
    writeFileSync(diagnosticRelease, 'release\n');
    await Promise.all([holder, diagnostic, ordinary].filter(Boolean).map(child => child.closed));
  }
});

test('a raw full-suite run takes a machine gate slot [Q4]', async () => {
  const modes = [
    [],
    ['--test-name-pattern', PROBE_PATTERN, '--test-reporter', 'tap', '--test-concurrency', '1', '--test-shard', '1/1', '--experimental-test-isolation', 'process'],
    ['--disable-warning', 'ExperimentalWarning', '--title', 'pullboard-slot-probe', '--max-http-header-size', '16384'],
  ];
  for (const args of modes) {
    const box = fixture();
    const release = join(box.dir, 'release-full-suite-holder');
    const releaseProbe = join(box.dir, 'release-running-probe');
    const holderRoot = gateRepo(box, 'full-suite-holder', 0.1, release);
    const nextRoot = gateRepo(box, 'after-full-suite');
    const suiteRoot = probeSuite(box, 'raw-full-suite');
    const marker = join(box.dir, 'raw-full-suite.started');
    setOneGateSlot(box, holderRoot);
    const holder = launch(box, holderRoot);
    let fullRun;
    let followingGate;
    try {
      await waitFor(() => events(box).includes('full-suite-holder start'), 'the fixture gate to hold its only machine slot');
      fullRun = launchTestRunner(box, suiteRoot, args, marker, releaseProbe);
      const outcome = await waitFor(() => { // budget: hang ceiling for the raw runner to announce its actual queue state; no throughput claim.
        if (fullRun.stderrText.includes('waiting for a gate slot:')) return 'waiting';
        if (existsSync(marker)) return 'ran';
        return false;
      }, 'the raw full runner to announce its queued slot', 15_000);
      assert.equal(outcome, 'waiting', 'both bare and option-only discovery must queue without a test file');
      assert.match(fullRun.stderrText, /waiting for a gate slot: 1 of 1 in use/u);
      assert.equal(existsSync(marker), false, 'the probe has not run while the other process owns the slot');
      writeFileSync(release, 'release\n');
      assert.equal((await holder.closed).code, 0, holder.stderrText);
      await waitFor(() => existsSync(marker), 'the admitted full-suite probe to start');
      assert.equal(readFileSync(marker, 'utf8'), '1', 'the runner marks its child only after acquiring its machine slot');
      followingGate = launch(box, nextRoot);
      const holding = await waitFor(() => {
        if (followingGate.stdoutText.includes('gate waiting:')) return 'waiting';
        if (events(box).includes('after-full-suite start')) return 'ran';
        return false;
      }, 'the following gate to wait for the full test process');
      assert.equal(holding, 'waiting', 'the full runner holds its slot until its test process exits');
      assert.equal(events(box).includes('after-full-suite start'), false);
      writeFileSync(releaseProbe, 'release\n');
      const [fullResult, followingResult] = await Promise.all([fullRun.closed, followingGate.closed]);
      assert.equal(fullResult.code, 0, `${fullRun.stderrText}${fullRun.stdoutText}`);
      assert.equal(followingResult.code, 0, `${followingGate.stderrText}${followingGate.stdoutText}`);
      assert.equal((fullRun.stderrText.match(/waiting for a gate slot:/g) ?? []).length, 1, 'one wait line per full run');
    } finally {
      writeFileSync(release, 'release\n');
      writeFileSync(releaseProbe, 'release\n');
      await Promise.all([holder, fullRun, followingGate].filter(Boolean).map(child => child.closed));
    }
  }
});

test("the slot probe's marker is never seen half-written [Q4]", async () => {
  const box = fixture();
  const root = probeSuite(box, 'atomic-marker');
  const marker = join(box.dir, 'atomic-marker.started');
  const ready = join(box.dir, 'atomic-marker.write-ready');
  const release = join(box.dir, 'atomic-marker.write-release');
  const preload = join(box.dir, 'pause-probe-write.cjs');
  writeFileSync(preload, `const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const target = process.env.${PROBE_WRITE_TARGET_ENV};
const ready = process.env.${PROBE_WRITE_READY_ENV};
const release = process.env.${PROBE_WRITE_RELEASE_ENV};
const originalWriteFileSync = fs.writeFileSync;
let paused = false;
/** Pause the probe after creating its marker path but before writing its value. */
fs.writeFileSync = function pauseProbeWrite(file, data, options) {
  const path = String(file);
  if (!paused && (path === target || path === target + '.tmp')) {
    paused = true;
    const fd = fs.openSync(path, 'w');
    originalWriteFileSync.call(fs, ready, 'ready');
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    try {
      if (!fs.existsSync(release)) throw new Error('parent did not release delayed probe write');
      return fs.writeSync(fd, data, 0, typeof options === 'string' ? options : options?.encoding ?? 'utf8');
    } finally { fs.closeSync(fd); }
  }
  return originalWriteFileSync.apply(this, arguments);
};
syncBuiltinESMExports();
`);
  const env = {
    [PROBE_WRITE_TARGET_ENV]: marker,
    [PROBE_WRITE_READY_ENV]: ready,
    [PROBE_WRITE_RELEASE_ENV]: release,
    NODE_OPTIONS: `${box.env.NODE_OPTIONS ? `${box.env.NODE_OPTIONS} ` : ''}--require=${JSON.stringify(preload)}`,
  };
  const runner = launchTestRunner(box, root, [], marker, null, env);
  let assertionError;
  try {
    await waitFor(() => existsSync(ready), 'the probe write to pause after creating its destination', 30_000); // budget: hang ceiling for the private paused-write marker handshake; no throughput claim.
    if (existsSync(marker)) assert.equal(readFileSync(marker, 'utf8'), '1', 'a visible marker already has its complete slot value');
  } catch (error) {
    assertionError = error;
  } finally {
    writeFileSync(release, 'release\n');
    const result = await runner.closed;
    assert.equal(result.code, 0, `${runner.stderrText}${runner.stdoutText}`);
  }
  if (assertionError) throw assertionError;
  await waitFor(() => existsSync(marker), 'the atomically published probe marker');
  assert.equal(readFileSync(marker, 'utf8'), '1', 'the final marker contains the complete slot value');
});

test('a short slot is offered only to a literal runner call over regular test files [C7]', async () => {
  const { explicitCheckFiles } = await import(BROWSER_ADMISSION_MODULE);
  const root = process.cwd();
  const named = `${quote(process.execPath)} packages/gate/src/io/run/tests.js packages/gate/tests/io/main/resource.test.js`;
  assert.deepEqual(await explicitCheckFiles(root, named), ['packages/gate/tests/io/main/resource.test.js']);
  assert.deepEqual(await explicitCheckFiles(root, `out=$(${named} 2>&1); printf '%s\\n' "$out"; printf '%s\\n' "$out" | grep -Eq '^[[:space:]]*ok [0-9]+ - .*probe' && printf '%s\\n' "$out" | grep -Eq '^# fail 0$'`), ['packages/gate/tests/io/main/resource.test.js'], 'the frozen-check capture form names its files');
  assert.equal(await explicitCheckFiles(root, `${quote(process.execPath)} packages/gate/src/io/run/tests.js`), null, 'a whole suite is not short');
  assert.equal(await explicitCheckFiles(root, `${quote(process.execPath)} packages/gate/src/io/run/tests.js test/`), null, 'a directory is not short');
  assert.equal(await explicitCheckFiles(root, 'npm test packages/gate/tests/io/main/resource.test.js'), null, 'an opaque runner is not short');
  assert.equal(await explicitCheckFiles(root, 'node packages/gate/src/io/run/tests.js packages/gate/tests/../../../test/cells.test.js'), null, 'path traversal is not a package test');
  assert.equal(await explicitCheckFiles(root, 'node packages/gate/src/io/run/tests.js $(printf packages/gate/tests/io/main/resource.test.js)'), null, 'shell expansion is not short');
  assert.equal(await explicitCheckFiles(root, 'node packages/gate/src/io/run/tests.js --unknown packages/gate/tests/io/main/resource.test.js'), null, 'an unknown option is not short');
  assert.equal(await explicitCheckFiles(root, 'node packages/gate/src/io/run/tests.js test/short-missing.test.js'), null, 'a missing file is not short');
  assert.equal(await explicitCheckFiles(root, named, { env: { ...process.env, NODE_OPTIONS: '--trace-warnings' } }), null, 'NODE_OPTIONS is not short');
  const head = runFixtureChild('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(head.status, 0, head.stderr);
  assert.deepEqual(await explicitCheckFiles(root, named, { commit: head.stdout.trim() }), ['packages/gate/tests/io/main/resource.test.js'], 'a review reads the files from the submitted tree');
});

test('short slots behave the same with gate.browserByLaunch on [C7]', async () => {
  // With gate.browserByLaunch on, the runner adds its launch guard to NODE_OPTIONS for its children (#808). The
  // short-slot offer for the same named file must match under either setting: each run gets the environment the
  // runner gives its children for that setting, and both name the file. A foreign NODE_OPTIONS still refuses.
  const { explicitCheckFiles } = await import(BROWSER_ADMISSION_MODULE);
  const root = process.cwd();
  const named = `${quote(process.execPath)} packages/gate/src/io/run/tests.js packages/gate/tests/io/main/resource.test.js`;
  const guard = pathToFileURL(resolve(root, 'packages/gate/src/io/browser/guard.js')).href;
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_OPTIONS'));
  assert.deepEqual(await explicitCheckFiles(root, named, { env: base }), ['packages/gate/tests/io/main/resource.test.js'], 'with gate.browserByLaunch off');
  assert.deepEqual(await explicitCheckFiles(root, named, { env: { ...base, NODE_OPTIONS: `--import=${guard}` } }), ['packages/gate/tests/io/main/resource.test.js'], 'with gate.browserByLaunch on');
  assert.equal(await explicitCheckFiles(root, named, { env: { ...base, NODE_OPTIONS: '--import=file:///elsewhere/unclassified.js' } }), null, 'a foreign NODE_OPTIONS is not short');
});


test('a focused run queues behind a held gate slot [Q4,C7]', async () => {
  const box = fixture();
  const release = join(box.dir, 'release-focused-holder');
  const holderRoot = gateRepo(box, 'focused-holder', 0.1, release);
  const suiteRoot = probeSuite(box, 'focused-suite');
  const marker = join(box.dir, 'focused-suite.started');
  setOneGateSlot(box, holderRoot);
  const holder = launch(box, holderRoot);
  let focusedRun;
  try {
    await waitFor(() => events(box).includes('focused-holder start'), 'the fixture gate to hold its only machine slot');
    focusedRun = launchTestRunner(box, suiteRoot, [
      '--test-name-pattern', PROBE_PATTERN,
      '--disable-warning', 'ExperimentalWarning', '--title', 'focused-slot-probe',
      'test/probe.test.js',
    ], marker);
    const outcome = await waitFor(() => { // budget: hang ceiling for the focused runner to announce its actual start state; no throughput claim.
      if (focusedRun.stderrText.includes('waiting for a gate slot:')) return 'waiting';
      if (existsSync(marker)) return 'ran';
      return false;
    }, 'the focused test to queue behind the held machine gate slot', 15_000);
    assert.equal(outcome, 'waiting', 'a named test file is queued even when test options have separate values');
    assert.equal(existsSync(marker), false, 'the focused test does not execute while the original holder owns the only slot');
    assert.deepEqual(events(box), ['focused-holder start'], 'the original gate still owns its slot while the focused run waits');
    writeFileSync(release, 'release\n');
    const focusedResult = await focusedRun.closed;
    assert.equal(focusedResult.code, 0, `${focusedRun.stderrText}${focusedRun.stdoutText}`);
    assert.equal(readFileSync(marker, 'utf8'), '1', 'the focused run propagates its public held-slot marker to the test process');
    assert.deepEqual(events(box), ['focused-holder start', 'focused-holder end'], 'the original holder releases before the focused run proceeds');
  } finally {
    writeFileSync(release, 'release\n');
    await Promise.all([holder, focusedRun].filter(Boolean).map(child => child.closed));
  }
});

test('a full run nested under a held gate does not take a second slot [Q4]', async () => {
  const box = fixture();
  const gateRoot = gateRepo(box, 'nested-full-suite');
  probeSuite(box, 'nested-full-suite');
  const marker = join(box.dir, 'nested-full-suite.started');
  const output = join(box.dir, 'nested-full-suite-runner.log');
  const command = `${quote(process.execPath)} ${quote(RUNNER)} --test-name-pattern ${quote(PROBE_PATTERN)} > ${quote(output)} 2>&1`;
  writeFileSync(join(gateRoot, 'pullboard.json'), JSON.stringify({ gate: command }));
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: gateRoot, env: box.env }).status, 0);
  const policyCommit = spawnSync('git', ['commit', '-q', '-m', 'chore: add nested runner probe'], { cwd: gateRoot, env: box.env, encoding: 'utf8' });
  assert.equal(policyCommit.status, 0, policyCommit.failure ?? policyCommit.stderr);
  setOneGateSlot(box, gateRoot);
  const nestedGate = launch({ ...box, env: { ...box.env, [PROBE_PATH_ENV]: marker } }, gateRoot);
  try {
    const outcome = await waitFor(() => { // budget: hang ceiling for the nested runner marker handshake; no throughput claim.
      if (existsSync(marker)) return 'completed';
      if (existsSync(output) && readFileSync(output, 'utf8').includes('waiting for a gate slot:')) return 'queued';
      return false;
    }, 'the nested runner to complete or expose a second-slot wait', 15_000);
    const runnerOutput = existsSync(output) ? readFileSync(output, 'utf8') : '';
    assert.equal(outcome, 'completed', `the child must inherit the held parent slot, not wait on its own slot; output=${runnerOutput}`);
    assert.equal(readFileSync(marker, 'utf8'), '1', 'the nested test child inherited the actual parent-held-slot marker');
    const result = await nestedGate.closed;
    assert.equal(result.code, 0, `${nestedGate.stderrText}${nestedGate.stdoutText}`);
  } finally {
    if (nestedGate.exitCode === null && nestedGate.signalCode === null) {
      try { process.kill(-nestedGate.pid, 'SIGKILL'); } catch { /* The gate already exited. */ }
    }
    await nestedGate.closed;
  }
});
