/** @pullboard-test-input packages/gate/src/io/browser/admission.js packages/gate/src/io/run/tests.js */
/** A test file waiting on a nested run lends its place, and every loan is returned or refused cleanly [C7]. */
import { executionServices } from '../../../../../apps/cli/tests/fixtures/gate/execution.js';
import { withGateSlot } from '../../../index.js';
import { awaitNestedRun } from '../../../index.js';
import { waitFor } from '../../../../../apps/cli/tests/fixtures/gate/resource.js';
import { timedFile } from '../../fixtures/file-pool.js';
import { fixture } from '../../fixtures/file-pool.js';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runFixtureChild } from '../../fixtures/child.js';
import { runFixtureChildAsync } from '../../fixtures/child.js';
import { safeFixtureDiagnostic } from '../../fixtures/child.js';
import { occupiedPlaces } from '../../../index.js';

const runner = fileURLToPath(new URL('../../../../../apps/cli/src/io/run/tests.js', import.meta.url));


test("an interactive marker-phase parent lends its token while it waits on the child's markers [C7]", async t => {
  const { root, env } = fixture(t, 1);
  const ready = join(root, 'interactive-ready'), release = join(root, 'interactive-release');
  const poolModule = new URL('../../../index.js', import.meta.url).href;
  writeFileSync(join(root, 'interactive-child.test.js'), `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
test('child waits for barrier', async () => {
  writeFileSync(${JSON.stringify(ready)}, 'ready');
  while (!existsSync(${JSON.stringify(release)})) await new Promise(done => setTimeout(done, 10));
});\n`);
  writeFileSync(join(root, 'interactive-parent.test.js'), `import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { awaitNestedPhase, occupiedPlaces } from ${JSON.stringify(poolModule)};
test('parent coordinates only its child', { timeout: 30000 }, async () => {
  const child = spawn(process.execPath, [${JSON.stringify(runner)}, 'interactive-child.test.js'], { cwd: ${JSON.stringify(root)}, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  const result = await awaitNestedPhase(child, async () => {
    const deadline = Date.now() + 15000;
    while (!existsSync(${JSON.stringify(ready)}) && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
    assert.ok(existsSync(${JSON.stringify(ready)}), 'the nested file reached its marker');
    assert.equal(await occupiedPlaces(JSON.parse(process.env.PULLBOARD_TEST_FILE_POOL).home), 1);
    writeFileSync(${JSON.stringify(release)}, 'release');
  });
  assert.equal(result.status, 0); assert.equal(result.signal, null);
});\n`);
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, [runner, 'interactive-parent.test.js'], { cwd: root, env }));
  assert.equal(result.status, 0, result.failure ?? result.stdout);
  assert.equal(await occupiedPlaces(env.PULLBOARD_MACHINE_HOME), 0, 'the interactive loan drains before return');
});

test('an interactive group shares one loan and drains all registered children [C7]', async t => {
  const { root, env } = fixture(t, 1);
  const poolModule = new URL('../../../index.js', import.meta.url).href;
  writeFileSync(join(root, 'group-child.test.js'), `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
test('wait for its barrier', async () => {
  writeFileSync(process.env.READY, 'ready');
  while (!existsSync(process.env.RELEASE)) await new Promise(done => setTimeout(done, 10));
});\n`);
  writeFileSync(join(root, 'group-parent.test.js'), `import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { withNestedGroup, awaitNestedRun, occupiedPlaces } from ${JSON.stringify(poolModule)};
test('sequential children share one group', { timeout: 45000 }, async () => {
  const home = JSON.parse(process.env.PULLBOARD_TEST_FILE_POOL).home;
  await withNestedGroup(async add => {
    for (const number of [1, 2]) {
      const ready = ${JSON.stringify(root)} + '/ready-' + number, release = ${JSON.stringify(root)} + '/release-' + number;
      const child = add(spawn(process.execPath, [${JSON.stringify(runner)}, 'group-child.test.js'], { cwd: ${JSON.stringify(root)}, env: { ...process.env, READY: ready, RELEASE: release }, stdio: ['ignore', 'pipe', 'pipe'] }));
      child.stdout.resume(); child.stderr.resume();
      const closed = new Promise(resolve => child.once('close', (status, signal) => resolve({ status, signal })));
      await assert.rejects(awaitNestedRun(child), { code: 'NESTED_RUN_WAIT_REUSED' });
      await assert.rejects(withNestedGroup(async () => {}), { code: 'NESTED_RUN_WAIT_ACTIVE' });
      const deadline = Date.now() + 15000;
      while (!existsSync(ready) && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
      assert.ok(existsSync(ready)); assert.equal(await occupiedPlaces(home), 1);
      writeFileSync(release, 'release'); assert.deepEqual(await closed, { status: 0, signal: null });
    }
  });
  await assert.rejects(withNestedGroup(async add => {
    add(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
    throw new Error('phase failed');
  }), /phase failed/);
  assert.equal(await occupiedPlaces(home), 1, 'only the parent remains after group cleanup');
});\n`);
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, [runner, 'group-parent.test.js'], { cwd: root, env }));
  assert.equal(result.status, 0, result.failure ?? result.stdout);
  assert.equal(await occupiedPlaces(env.PULLBOARD_MACHINE_HOME), 0);
});

test('an explicit async loan refuses duplicate and concurrent waits and preserves child failures [C7]', async (t) => {
  const { root, env } = fixture(t, 1);
  const poolModule = new URL('../../../index.js', import.meta.url).href;
  writeFileSync(join(root, 'inner.test.js'), timedFile('inner.test.js', 0));
  writeFileSync(join(root, 'parent.test.js'), `import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { awaitNestedRun } from ${JSON.stringify(poolModule)};
// A test file runs on a machine home of its own, so the fixture's gateSlots never reach the runs it starts: write the
// slots to the home these nested runs inherit, or two seat tests share two slots and one waits 30 s for the reserve [C7].
mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
writeFileSync(process.env.PULLBOARD_MACHINE_HOME + '/settings.json', JSON.stringify({ gateSlots: 4, browserSlots: 1 }));
test('clause 1: explicit wait contracts finish within the 10 s budget [C7]', { timeout: 10_000 }, async (t) => {
  const start = () => {
    const child = spawn(process.execPath, [${JSON.stringify(runner)}, 'inner.test.js'], { cwd: ${JSON.stringify(root)}, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.resume();
    return child;
  };
  const first = start();
  const waiting = awaitNestedRun(first);
  await assert.rejects(awaitNestedRun(first), { code: 'NESTED_RUN_WAIT_REUSED' });
  const second = start();
  await assert.rejects(awaitNestedRun(second), { code: 'NESTED_RUN_WAIT_ACTIVE' });
  assert.equal((await waiting).status, 0);
  assert.equal((await awaitNestedRun(second)).status, 0);
  const missing = spawn(${JSON.stringify(join(root, 'missing-child'))}, [], { stdio: 'ignore' });
  await assert.rejects(awaitNestedRun(missing), { code: 'ENOENT' });
  const failed = spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
  assert.deepEqual(await awaitNestedRun(failed), { status: 7, signal: null });
  const late = spawn(${JSON.stringify(join(root, 'missing-late-child'))}, [], { stdio: 'ignore' });
  const seen = new Promise(resolve => { late.on('error', () => {}); late.once('close', resolve); });
  await seen;
  await assert.rejects(awaitNestedRun(late), { code: 'ENOENT' });
  const separate = { ...process.env };
  delete separate.PULLBOARD_TEST_FILE_POOL;
  const independent = spawn(${JSON.stringify(join(root, 'missing-independent-child'))}, [], { env: separate, stdio: 'ignore' });
  await assert.rejects(awaitNestedRun(independent), { code: 'ENOENT' });
  const fallback = spawn(process.execPath, [${JSON.stringify(runner)}, 'inner.test.js'], { env: false, detached: true, stdio: 'ignore' });
  let live = true;
  fallback.once('close', () => { live = false; });
  t.after(() => { if (live) { try { process.kill(-fallback.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } });
  assert.equal((await awaitNestedRun(fallback)).status, 0, 'a native falsy-env fallback still borrows in a one-token pool');
});
`);
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, [runner, 'parent.test.js'], { cwd: root, env }));
  assert.equal(result.status, 0, `${result.failure ?? ''}\n${safeFixtureDiagnostic(result.stdout, env)}`);
  assert.equal(await occupiedPlaces(env.PULLBOARD_MACHINE_HOME), 0);
});

test('async offers preserve spawn argument overloads and Node validation [C7]', async (t) => {
  const { root, env } = fixture(t, 1);
  const poolModule = new URL('../../../index.js', import.meta.url).href;
  const probe = join(root, 'options.sh');
  const marker = join(root, 'options-output');
  writeFileSync(probe, String.raw`#!/bin/sh
printf '%s\n' "$ASYNC_OFFER_MODE" > "$ASYNC_OFFER_DEST"
`);
  chmodSync(probe, 0o755);
  writeFileSync(join(root, 'spawn-cases.mjs'), `import { existsSync, readFileSync, rmSync } from 'node:fs';
const probe = ${JSON.stringify(probe)};
const marker = ${JSON.stringify(marker)};
export const variants = ['undefined-args', 'null-args', 'object-options', 'array-args', 'invalid-args', 'invalid-options', 'null-array-options', 'null-undefined-options', 'null-null-options', 'inherited-env', 'inherited-options', 'false-env', 'zero-env', 'empty-env', 'separate-env', 'own-env-getter', 'separate-env-getter'];
export function startVariant(start, variant) {
  rmSync(marker, { force: true });
  process.env.ASYNC_OFFER_MODE = 'fallback';
  process.env.ASYNC_OFFER_DEST = marker;
  const options = { cwd: ${JSON.stringify(root)}, env: { ...process.env, ASYNC_OFFER_MODE: 'retained-options' }, stdio: 'ignore' };
  if (variant === 'undefined-args') return start(probe, undefined, options);
  if (variant === 'null-args') return start(probe, null, options);
  if (variant === 'object-options') return start(probe, options);
  if (variant === 'array-args') return start(probe, [], options);
  if (variant === 'invalid-args') return start(probe, 'invalid args');
  if (variant === 'invalid-options') return start(probe, [], 'invalid options');
  if (variant === 'null-array-options') return start(probe, [], null);
  if (variant === 'null-undefined-options') return start(probe, undefined, null);
  if (variant === 'null-null-options') return start(probe, null, null);
  if (variant === 'inherited-env') {
    options.env = Object.assign(Object.create({ ASYNC_OFFER_MODE: 'inherited-value' }), {
      PULLBOARD_TEST_FILE_POOL: process.env.PULLBOARD_TEST_FILE_POOL, ASYNC_OFFER_DEST: marker,
    });
  } else if (variant === 'inherited-options') {
    return start(probe, Object.assign(Object.create({ env: { ASYNC_OFFER_MODE: 'ignored' }, cwd: '/missing/inherited-spawn-option' }), { stdio: 'ignore' }));
  } else if (variant === 'false-env') options.env = false;
  else if (variant === 'zero-env') options.env = 0;
  else if (variant === 'empty-env') options.env = '';
  else if (variant === 'separate-env') options.env.PULLBOARD_TEST_FILE_POOL = 'separate-fixture-pool';
  else if (variant === 'own-env-getter' || variant === 'separate-env-getter') {
    let reads = 0;
    Object.defineProperty(options, 'env', { enumerable: true, get() {
      reads++;
      return { ...process.env, ASYNC_OFFER_MODE: 'getter-' + reads,
        ...(variant === 'separate-env-getter' ? { PULLBOARD_TEST_FILE_POOL: 'separate-fixture-pool' } : {}) };
    } });
  }
  return start(probe, [], options);
}
export function observation(result) {
  return { status: result.status, signal: result.signal, mode: existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null };
}
`);
  const oracle = join(root, 'native-oracle.mjs');
  writeFileSync(oracle, `import { spawnSync } from 'node:child_process';
import { variants } from './spawn-cases.mjs';
import { startVariant } from './spawn-cases.mjs';
import { observation } from './spawn-cases.mjs';
const records = variants.map(variant => {
  try { return { variant, observed: observation(startVariant(spawnSync, variant)) }; }
  catch (error) { return { variant, observed: { error: error.code } }; }
});
process.stdout.write(JSON.stringify(records));
`);
  // This private non-test oracle loads no runner/preload, so its primitive is independent of both loan wrappers.
  const oracleEnv = { ...env, NODE_OPTIONS: '' };
  delete oracleEnv.NODE_TEST_CONTEXT;
  const native = runFixtureChild(process.execPath, [oracle], { cwd: root, env: oracleEnv, encoding: 'utf8' });
  assert.equal(native.status, 0, native.failure ?? native.stderr);
  const expected = JSON.parse(native.stdout);
  t.diagnostic('independent Node spawn observations: ' + JSON.stringify(expected));
  writeFileSync(join(root, 'expected.json'), JSON.stringify(expected));
  writeFileSync(join(root, 'parent.test.js'), `import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { awaitNestedRun } from ${JSON.stringify(poolModule)};
import { variants } from './spawn-cases.mjs';
import { startVariant } from './spawn-cases.mjs';
import { observation } from './spawn-cases.mjs';
test('offered spawn matches independently loaded Node', async () => {
  const expected = JSON.parse(readFileSync('expected.json', 'utf8'));
  for (const variant of variants) {
    let observed;
    try { observed = observation(await awaitNestedRun(startVariant(spawn, variant))); }
    catch (error) { observed = { error: error.code }; }
    assert.deepEqual(observed, expected.find(record => record.variant === variant).observed, variant);
  }
});
`);
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, [runner, 'parent.test.js'], { cwd: root, env }));
  assert.equal(result.status, 0, `${result.failure ?? ''}\n${result.stdout}`);
  assert.equal(await occupiedPlaces(env.PULLBOARD_MACHINE_HOME), 0);
});

test('an async loan whose cleanup fails exits without resuming its parent [C7]', async (t) => {
  const { root, env } = fixture(t, 1);
  const poolModule = new URL('../../../index.js', import.meta.url).href;
  writeFileSync(join(root, 'inner.test.js'), `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
test('borrowed child', async () => {
  writeFileSync('inner-ready', 'ready');
  while (!existsSync('release-inner')) await new Promise(next => setTimeout(next, 10));
});
`);
  writeFileSync(join(root, 'parent.test.js'), `import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { waitFor } from ${JSON.stringify(new URL('../../../../../apps/cli/tests/fixtures/gate/resource.js', import.meta.url).href)};
import { awaitNestedRun } from ${JSON.stringify(poolModule)};
test('a broken private pool must not return a live loan', async () => {
  const child = spawn(process.execPath, [${JSON.stringify(runner)}, 'inner.test.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  const waiting = awaitNestedRun(child);
  await waitFor(() => existsSync('inner-ready'), 'the inner marker');
  const home = JSON.parse(process.env.PULLBOARD_TEST_FILE_POOL).home;
  const db = new DatabaseSync(join(home, 'test-file-pool.sqlite'));
  db.exec('DROP TABLE file_call');
  db.close();
  writeFileSync('release-inner', 'release');
  try { await waiting; } catch { writeFileSync('parent-resumed', 'caught'); }
  writeFileSync('parent-resumed', 'returned');
});
`);
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, [runner, 'parent.test.js'], { cwd: root, env }));
  assert.equal(result.status, 1, `${result.failure ?? ''}\n${result.stdout}`);
  assert.match(result.stdout + result.stderr, /cannot close the nested loan safely/);
  assert.equal(existsSync(join(root, 'parent-resumed')), false, 'neither return nor catch resumed the parent');
  assert.equal(await occupiedPlaces(env.PULLBOARD_MACHINE_HOME), 0);
});

test('a run a synchronous call leaves behind lends nothing once the call returns [C7]', { cpuLoad: true }, async (t) => {
  const { root, env, log } = fixture(t, 1);
  for (const file of ['inner-a.test.js', 'inner-b.test.js']) writeFileSync(join(root, file), timedFile(file, 200));
  // The detached run keeps its own temp folder: under the outer run's, the outer cleanup removes the run's sandbox mid-start under load.
  const spare = join(root, 'detached-tmp');
  mkdirSync(spare);
  // The parent's shell call starts a detached run and returns at once; the parent then works on in its own place.
  const detached = `const { execSync } = await import('node:child_process');
  execSync(${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(runner)} inner-a.test.js inner-b.test.js > /dev/null 2>&1 &`)}, { cwd: ${JSON.stringify(root)}, env: { ...process.env, FIXTURE_RUN: 'inner', TMPDIR: ${JSON.stringify(spare)}, TMP: ${JSON.stringify(spare)}, TEMP: ${JSON.stringify(spare)} } });
  const until = Date.now() + 1500;
  while (Date.now() < until) { /* computing in its own place */ }`;
  writeFileSync(join(root, 'parent.test.js'), timedFile('parent.test.js', 0, detached));
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, [runner, 'parent.test.js'], { cwd: root, env: { ...env, FIXTURE_RUN: 'outer' } }));
  assert.equal(result.status, 0, result.failure ?? result.stdout);
  await waitFor(() => !(log().filter(event => event.run === 'inner' && event.at === 'end').length < 2), 'the nested file to finish').catch(() => {});
  const events = log();
  const parentEnd = events.find(event => event.file === 'parent.test.js' && event.at === 'end').t;
  const innerStarts = events.filter(event => event.run === 'inner' && event.at === 'start').map(event => event.t);
  assert.equal(innerStarts.length, 2, 'the detached run finished both files');
  assert.ok(innerStarts.every(at => at >= parentEnd), 'on 1 core, the detached run waited for the parent instead of borrowing its place');
});

test('a synchronous call returns only after the file it lent its place to has exited [C7]', async (t) => {
  const { root, env, log } = fixture(t, 1);
  writeFileSync(join(root, 'inner.test.js'), timedFile('inner.test.js', 2000));
  // The shell starts a run and returns only once its file has logged its start: it was admitted inside the open call.
  const started = `until grep -q 'inner.test.js","at":"start' ${JSON.stringify(env.FIXTURE_LOG)} 2>/dev/null; do sleep 0.05; done`;
  const lingering = `const { execSync } = await import('node:child_process');
  execSync(${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(runner)} inner.test.js > /dev/null 2>&1 & ${started}`)}, { cwd: ${JSON.stringify(root)}, env: { ...process.env, FIXTURE_RUN: 'inner' } });
  mark('resume');`;
  writeFileSync(join(root, 'parent.test.js'), timedFile('parent.test.js', 0, lingering));
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, [runner, 'parent.test.js'], { cwd: root, env: { ...env, FIXTURE_RUN: 'outer' } }));
  assert.equal(result.status, 0, result.failure ?? result.stdout);
  await waitFor(() => log().some(event => event.file === 'inner.test.js' && event.at === 'end'), 'the nested file to finish').catch(() => {});
  const events = log();
  const innerEnd = events.find(event => event.file === 'inner.test.js' && event.at === 'end')?.t;
  const resumed = events.find(event => event.at === 'resume').t;
  assert.ok(innerEnd, 'the nested file ran inside the call');
  assert.ok(resumed >= innerEnd, 'on 1 core, the caller resumed only after the file in its place exited');
});

test('a call waits for every file under it, even when a file in between dies [C7]', async (t) => {
  const { root, env, log } = fixture(t, 1);
  writeFileSync(join(root, 'd.test.js'), timedFile('d.test.js', 2000));
  // C starts D inside its own call, waits until D is admitted, and is then killed while D still runs.
  const startD = `${JSON.stringify(process.execPath)} ${JSON.stringify(runner)} d.test.js > /dev/null 2>&1 & until grep -q 'd.test.js","at":"start' ${JSON.stringify(env.FIXTURE_LOG)} 2>/dev/null; do sleep 0.05; done; kill -9 \${PPID_C}`;
  writeFileSync(join(root, 'c.test.js'), `import { execSync } from 'node:child_process';
import { test } from 'node:test';
test('c', () => { execSync(${JSON.stringify(startD)}, { cwd: ${JSON.stringify(root)}, env: { ...process.env, PPID_C: String(process.pid), FIXTURE_RUN: 'd' } }); });
`);
  const runC = `const { execSync } = await import('node:child_process');
  try { execSync(${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(runner)} c.test.js`)}, { cwd: ${JSON.stringify(root)}, env: { ...process.env, FIXTURE_RUN: 'c' }, stdio: 'ignore' }); }
  catch { /* C was killed, so its run fails; P only resumes. */ }
  mark('resume');`;
  writeFileSync(join(root, 'p.test.js'), timedFile('p.test.js', 0, runC));
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, [runner, 'p.test.js'], { cwd: root, env: { ...env, FIXTURE_RUN: 'p' } }));
  assert.equal(result.status, 0, `${result.failure ?? ''}\n${result.stdout.slice(-3000)}`);
  await waitFor(() => log().some(event => event.file === 'd.test.js' && event.at === 'end'), 'the nested file to finish').catch(() => {});
  const events = log();
  const dEnd = events.find(event => event.file === 'd.test.js' && event.at === 'end')?.t;
  assert.ok(dEnd, 'D ran to its end after C died');
  assert.ok(events.find(event => event.at === 'resume').t >= dEnd, 'on 1 core, P resumed only after D, the file under its call, ended');
});


/** Missing providers refuse before any workspace read, queued lease or caller action can begin. */
test('gate admission requires explicit complete execution providers before work [C7,Q1]', async () => {
  let called = false;
  const root = '/missing-core714-execution-provider-fixture';
  const action = () => { called = true; };
  for (const services of [undefined,
    { ...executionServices, runners: { ...executionServices.runners, runOnRunnerAsync: undefined } },
    { ...executionServices, landing: { ...executionServices.landing, captureReleaseQueue: undefined } }]) {
    await assert.rejects(withGateSlot(root, action, { remote: false, executionServices: services }),
      { name: 'TypeError', message: 'gate execution needs explicit canonical runner and landing services' });
  }
  assert.equal(called, false, 'incomplete providers cannot start admitted work');
});
