/** @pullboard-test-input source-tree */
/** Exercise the production test runner against files that will not exit and focused-pool admission [C7]. */
import { copyPackageFiles } from '../../../../index.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFixtureChild } from '../../../../../../apps/cli/tests/fixtures/child.js';
import { withNestedGroup } from '../../../../../gate/index.js';
import { runFixtureChild } from '../../../../../../apps/cli/tests/fixtures/child.js';
import { focusedPoolSnapshot } from '../../../fixtures/pool.js';

const runner = fileURLToPath(new URL('../../../../../gate/src/io/run/tests.js', import.meta.url));
const fixtureExitCeilingMs = '500';
const fixtureCleanupMs = '100';

/** Build an isolated production-runner fixture with the source imports it needs. */
function makeFileExitFixture(t, source) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-test-file-exit-')));
  const tests = join(root, 'test');
  mkdirSync(tests);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  copyPackageFiles(resolve(import.meta.dirname, '../../../../../..'), root);
  const testFile = join(tests, 'file-exit.test.js');
  writeFileSync(testFile, source);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root, runner: join(root, 'packages/gate/src/io/run/tests.js'), testFile,
    cleanupFile: join(root, 'cleanup.txt'), portFile: join(root, 'port.txt'),
  };
}

/** Run one fixture file with a bounded ceiling and clean up its process group if it hangs. */
function runFileExitFixture(fixture) {
  const result = runFixtureChild(process.execPath, [fixture.runner, fixture.testFile], {
    cwd: fixture.root,
    detached: true,
    encoding: 'utf8',
    env: {
      ...process.env,
      PULLBOARD_TEST_FILE_TIMEOUT_MS: fixtureExitCeilingMs,
      PULLBOARD_FILE_EXIT_CLEANUP: fixture.cleanupFile,
      PULLBOARD_FILE_EXIT_PORT: fixture.portFile,
    },
    timeout: 6_000,
  });
  if (result.error?.code === 'ETIMEDOUT' && result.pid) {
    try { process.kill(-result.pid, 'SIGKILL'); } catch { /* The owned fixture process group already exited. */ }
  }
  return result;
}

/** Combine native test output and the production runner's file-exit diagnostic. */
function outputOf(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

test('a test file that won\'t exit fails by name [C7]', (t) => {
  const fixture = makeFileExitFixture(t, `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { after, test } from 'node:test';
const server = createServer((_request, response) => response.end('ok'));
test('leave cleanup active [C7]', () => {});
/** Open the listener only after watchdog arming, then leave the root cleanup hook stuck. */
after(async () => {
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  writeFileSync(process.env.PULLBOARD_FILE_EXIT_PORT, String(server.address().port));
  await new Promise(() => {});
});
`);
  const result = runFileExitFixture(fixture);
  const output = outputOf(result);
  const port = readFileSync(fixture.portFile, 'utf8').trim();
  assert.equal(result.status, 1, result.context);
  assert.ok(result.elapsedMs >= Number(fixtureExitCeilingMs), `the process remains through its ${fixtureExitCeilingMs}ms file ceiling: ${result.elapsedMs}ms`);
  assert.ok(result.elapsedMs < 5_000, `the runner terminates the stuck cleanup within the 5-second bound: ${result.elapsedMs}ms`); // budget: 500ms file ceiling plus Node startup and CI scheduling allowance.
  assert.match(output, /test file ".*file-exit\.test\.js" failed: its process did not exit within 500ms file-exit timeout/u);
  assert.match(output, /live-handle snapshot age: [0-9]+ms \((?:latest responsive snapshot|fallback; main thread did not answer)\)/u);
  assert.ok(output.includes(`127.0.0.1:${port}`), `the diagnostic names its listening port ${port}: ${output}`);
  assert.match(output, /live handles:.*Server/u);
  assert.match(output, /leave cleanup active \[C7\]/u);
});

test('a file that exits cleanly is not touched [C7]', (t) => {
  const fixture = makeFileExitFixture(t, `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { after, test } from 'node:test';
const server = createServer((_request, response) => response.end('ok'));
test('clean test file exits [C7]', () => {});
after(async () => {
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  writeFileSync(process.env.PULLBOARD_FILE_EXIT_PORT, String(server.address().port));
  await new Promise((ready, reject) => server.close((error) => error ? reject(error) : ready()));
  await new Promise((ready) => setTimeout(ready, ${fixtureCleanupMs}));
  writeFileSync(process.env.PULLBOARD_FILE_EXIT_CLEANUP, 'done');
});
`);
  const result = runFileExitFixture(fixture);
  const output = outputOf(result);
  assert.equal(result.status, 0, result.context);
  assert.equal(result.signal, null, 'a clean test file is never killed by the watchdog');
  assert.equal(readFileSync(fixture.cleanupFile, 'utf8'), 'done', 'asynchronous cleanup within the ceiling completes normally');
  assert.ok(readFileSync(fixture.portFile, 'utf8').trim(), 'the cleanup listener was opened after watchdog arming');
  assert.doesNotMatch(output, /file-exit timeout/u);
});

test('a nested suite cleanup cannot hold a completed file open [C7]', (t) => {
  const fixture = makeFileExitFixture(t, `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { after, describe, test } from 'node:test';
describe('outer suite [C7]', () => {
  describe('inner suite [C7]', () => {
    test('last nested leaf finished [C7]', () => {
      writeFileSync(process.env.PULLBOARD_FILE_EXIT_CLEANUP, 'leaf finished');
    });
    after(async () => {
      const server = createServer((_request, response) => response.end('ok'));
      await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
      writeFileSync(process.env.PULLBOARD_FILE_EXIT_PORT, String(server.address().port));
      await new Promise(() => {});
    });
  });
});
`);
  const result = runFileExitFixture(fixture);
  const output = outputOf(result);
  const port = readFileSync(fixture.portFile, 'utf8').trim();
  assert.equal(readFileSync(fixture.cleanupFile, 'utf8'), 'leaf finished');
  assert.equal(result.status, 1, result.context);
  assert.ok(result.elapsedMs >= Number(fixtureExitCeilingMs), `nested cleanup reaches the ${fixtureExitCeilingMs}ms ceiling: ${result.elapsedMs}ms`);
  assert.ok(result.elapsedMs < 5_000, `nested cleanup is terminated before the independent fixture bound: ${result.elapsedMs}ms`); // budget: 500ms ceiling plus Node startup and CI scheduling allowance.
  assert.match(output, /test file ".*file-exit\.test\.js" failed: its process did not exit within 500ms file-exit timeout/u);
  assert.ok(output.includes(`127.0.0.1:${port}`), `nested cleanup diagnostic names the actual listening port ${port}: ${output}`);
  assert.match(output, /live handles:.*Server/u);
  assert.match(output, /ok [0-9]+ - last nested leaf finished \[C7\]/u);
});

test('clean nested cleanup and a later active test keep their own time [C7]', (t) => {
  const fixture = makeFileExitFixture(t, `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { after, describe, test } from 'node:test';
describe('clean suite [C7]', () => {
  test('first nested leaf finished [C7]', () => {});
  after(async () => {
    const server = createServer((_request, response) => response.end('ok'));
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
    writeFileSync(process.env.PULLBOARD_FILE_EXIT_PORT, String(server.address().port));
    await new Promise((ready, reject) => server.close((error) => error ? reject(error) : ready()));
    await new Promise((ready) => setTimeout(ready, ${fixtureCleanupMs}));
    writeFileSync(process.env.PULLBOARD_FILE_EXIT_CLEANUP, 'done');
  });
});

test('later active body uses its per-test ceiling [C7]', async () => {
  await new Promise((ready) => setTimeout(ready, 650)); // budget: exceed the 500ms file-exit ceiling while a real test body is active.
});
`);
  const result = runFileExitFixture(fixture);
  const output = outputOf(result);
  assert.equal(result.status, 0, result.context);
  assert.equal(result.signal, null, 'normal nested cleanup and the next body are never killed');
  assert.equal(readFileSync(fixture.cleanupFile, 'utf8'), 'done', 'nested cleanup completes normally within its ceiling');
  assert.ok(readFileSync(fixture.portFile, 'utf8').trim(), 'the nested cleanup opens a real listener');
  assert.match(output, /ok [0-9]+ - later active body uses its per-test ceiling \[C7\]/u);
  assert.doesNotMatch(output, /file-exit timeout/u);
});

/** Wait for an observable fixture state; the bound is a hang ceiling, not a timing claim. */
async function waitForFocusedPoolState(predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${description} [C7 hang ceiling ${timeoutMs}ms]`);
}

/** Create fixture files that exercise direct and nested focused runner processes. */
function makeFocusedPoolFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-focused-pool-')));
  const tests = join(root, 'test');
  const machine = join(root, 'machine');
  mkdirSync(tests);
  mkdirSync(machine);
  writeFileSync(join(machine, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  copyPackageFiles(resolve(import.meta.dirname, '../../../../../..'), root);
  const ready = join(root, 'first-ready');
  const nestedDone = join(root, 'nested-done');
  const release = join(root, 'release-first');
  const firstDone = join(root, 'first-done');
  const secondStarted = join(root, 'second-started');
  writeFileSync(join(tests, 'nested.test.js'), `import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
test('nested focused run inherits the held slot [C7]', () => {
  if (process.env.PULLBOARD_GATE_SLOT_HELD !== '1') throw new Error('nested run lost its held-slot marker');
  writeFileSync(process.env.PULLBOARD_C7_NESTED_DONE, 'nested completed');
});
`);
  writeFileSync(join(tests, 'hold.test.js'), `import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
test('focused holder remains live through nested run [C7]', async () => {
  writeFileSync(process.env.PULLBOARD_C7_FIRST_READY, 'ready');
  const env = { ...process.env, PULLBOARD_MACHINE_HOME: process.env.PULLBOARD_C7_POOL };
  const nested = spawnSync(process.execPath, [process.env.PULLBOARD_C7_RUNNER, 'test/nested.test.js'], {
    cwd: process.env.PULLBOARD_C7_ROOT, env, encoding: 'utf8', timeout: 10000,
  });
  if (nested.error || nested.status !== 0) throw new Error('nested focused runner failed: ' + (nested.error?.message ?? nested.stderr));
  if (!existsSync(process.env.PULLBOARD_C7_NESTED_DONE)) throw new Error('nested run produced no completion marker');
  while (!existsSync(process.env.PULLBOARD_C7_RELEASE)) await new Promise(resolve => setTimeout(resolve, 10));
  writeFileSync(process.env.PULLBOARD_C7_FIRST_DONE, 'first completed');
});
`);
  writeFileSync(join(tests, 'second.test.js'), `import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
test('second focused run starts after the slot is released [C7]', () => {
  writeFileSync(process.env.PULLBOARD_C7_SECOND_STARTED, 'second started');
});
`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, runner: join(root, 'packages/gate/src/io/run/tests.js'), machine, ready, nestedDone, release, firstDone, secondStarted };
}

/** Launch one direct fixture runner with an explicit, cleared inherited-slot marker. */
function launchFocusedPoolRunner(fixture, testFile, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv, PULLBOARD_MACHINE_HOME: fixture.machine };
  delete env.PULLBOARD_GATE_SLOT_HELD;
  delete env.PULLBOARD_AGENT;
  const child = startFixtureChild(process.execPath, [fixture.runner, testFile], {
    cwd: fixture.root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout?.setEncoding('utf8').on('data', (part) => { child.stdoutText += part; });
  child.stderr?.setEncoding('utf8').on('data', (part) => { child.stderrText += part; });
  child.closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  return child;
}

test('a legacy held marker alone cannot bypass focused test admission [C7]', t => {
  const fixture = makeFocusedPoolFixture(t);
  const env = {
    ...process.env,
    PULLBOARD_MACHINE_HOME: fixture.machine,
    PULLBOARD_GATE_SLOT_HELD: '1',
    PULLBOARD_C7_SECOND_STARTED: fixture.secondStarted,
  };
  for (const key of ['PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  const result = runFixtureChild(process.execPath, [fixture.runner, 'test/second.test.js'], {
    cwd: fixture.root, env, encoding: 'utf8',
  });
  assert.equal(result.status, 1, 'a self-declared legacy marker does not prove a live reservation');
  assert.match(result.stderr, /live machine gate lease/u);
  assert.equal(existsSync(fixture.secondStarted), false, 'the unadmitted test never starts');
});

/** Stop only children owned by this test, releasing the held test before signaling its process group. */
async function stopFocusedPoolChild(child, fixture) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    try { writeFileSync(fixture.release, 'release'); } catch { /* The fixture may already be removed during teardown. */ }
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch {
      try { child.kill('SIGTERM'); } catch { /* The owned process already exited. */ }
    }
    const deadline = Date.now() + 1000; // [C7] cleanup ceiling for an owned fixture process group.
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch {
        try { child.kill('SIGKILL'); } catch { /* The owned process already exited. */ }
      }
    }
  }
  await focusedPoolCloseWithin(child, 'owned fixture process cleanup', 2000);
}

/** Bound completion waits and always clear the watchdog timer. */
async function focusedPoolCloseWithin(child, label, timeoutMs = 30_000) {
  let timer;
  try {
    return await Promise.race([
      child.closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not close [C7 hang ceiling ${timeoutMs}ms]`)), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

test('a focused test run holds a gate slot [C7]', async (t) => {
  const fixture = makeFocusedPoolFixture(t);
  const commonEnv = {
    PULLBOARD_C7_POOL: fixture.machine,
    PULLBOARD_C7_ROOT: fixture.root,
    PULLBOARD_C7_RUNNER: fixture.runner,
    PULLBOARD_C7_FIRST_READY: fixture.ready,
    PULLBOARD_C7_NESTED_DONE: fixture.nestedDone,
    PULLBOARD_C7_RELEASE: fixture.release,
    PULLBOARD_C7_FIRST_DONE: fixture.firstDone,
    PULLBOARD_C7_SECOND_STARTED: fixture.secondStarted,
  };
  let first;
  let second;
  let testFailure;
  await withNestedGroup(async add => {
    try {
      first = add(launchFocusedPoolRunner(fixture, 'test/hold.test.js', commonEnv));
      await waitForFocusedPoolState(() => existsSync(fixture.ready), 'the first focused test readiness marker');
      const firstPool = focusedPoolSnapshot(fixture.machine);
      assert.ok(firstPool, 'the focused run creates the machine gate resource');
      assert.equal(firstPool.capacity, 1);
      assert.deepEqual(firstPool.holders.map(({ agent }) => agent), [`pid-${first.pid}`],
        'the direct focused-runner process is the actual gate holder');
      await waitForFocusedPoolState(() => existsSync(fixture.nestedDone), 'the nested held-slot focused run');
      assert.equal(first.exitCode, null, 'the first focused run still owns its slot after nested completion');
      assert.deepEqual(focusedPoolSnapshot(fixture.machine).holders.map(({ agent }) => agent), [`pid-${first.pid}`],
        'the nested run did not acquire a second lease or displace its parent');

      second = add(launchFocusedPoolRunner(fixture, 'test/second.test.js', commonEnv));
      const observed = await waitForFocusedPoolState(() => {
        const pool = focusedPoolSnapshot(fixture.machine);
        const waiter = pool?.line.find(({ agent }) => agent === `pid-${second.pid}`);
        return waiter || existsSync(fixture.secondStarted);
      }, 'the second runner to enter the queue or expose an unexpected execution marker');
      assert.equal(typeof observed, 'object', 'a second direct focused run must become an actual queue waiter');
      assert.equal(existsSync(fixture.secondStarted), false, 'the queued second test has not executed while the first holds the slot');
      await waitForFocusedPoolState(() => second.stderrText.includes('waiting for a gate slot: 1 of 1 in use'),
        'the second runner wait announcement');
      assert.match(second.stderrText, /waiting for a gate slot: 1 of 1 in use/u,
        'the focused runner reports its actual slot wait');
      assert.deepEqual(focusedPoolSnapshot(fixture.machine).holders.map(({ agent }) => agent), [`pid-${first.pid}`]);

      writeFileSync(fixture.release, 'release');
      const firstResult = await focusedPoolCloseWithin(first, 'first focused run');
      const secondResult = await focusedPoolCloseWithin(second, 'second focused run');
      assert.equal(firstResult.code, 0, `${first.stderrText}${first.stdoutText}`);
      assert.equal(firstResult.signal, null);
      assert.equal(secondResult.code, 0, `${second.stderrText}${second.stdoutText}`);
      assert.equal(secondResult.signal, null);
      assert.equal(readFileSync(fixture.firstDone, 'utf8'), 'first completed');
      assert.equal(readFileSync(fixture.secondStarted, 'utf8'), 'second started');
    } catch (error) {
      testFailure = error;
    }
  });
  let cleanupFailure;
  for (const child of [first, second]) {
    try { await stopFocusedPoolChild(child, fixture); }
    catch (error) { cleanupFailure ??= error; }
  }
  if (testFailure) throw testFailure;
  if (cleanupFailure) throw cleanupFailure;
});

test('a test name pattern after the file selects only its case [C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-pattern-after-')); try {
    writeFileSync(join(root, 'pattern.test.mjs'), "import { test } from 'node:test';\ntest('alpha case runs', () => {});\ntest('beta case runs', () => {});\n");
    for (const args of [['pattern.test.mjs', '--test-name-pattern', 'alpha'], ['pattern.test.mjs', '--test-name-pattern=alpha']]) {
      const result = runFixtureChild(process.execPath, [runner, ...args], { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.context);
      assert.match(result.stdout, /ok [0-9]+ - alpha case runs[\s\S]*# tests 1\b/u, `${args.join(' ')} selects one case`); assert.doesNotMatch(result.stdout, /beta case runs/u, `${args.join(' ')} ran the unselected case`); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
