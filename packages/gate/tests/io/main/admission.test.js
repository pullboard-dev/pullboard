/** @pullboard-test-input packages/gate/src/io/browser/admission.js packages/gate/src/io/run/tests.js */
/** Test files on one machine never outnumber its cores, and the longest files start first [C7]. */
import { executionServices } from '../../../../../apps/cli/tests/fixtures/gate/execution.js';
import { executionServicesSource } from '../../../../../apps/cli/tests/fixtures/gate/execution.js';
import { withGateSlot } from '../../../index.js';
import { awaitNestedRun } from '../../../index.js';
import { waitFor } from '../../../../../apps/cli/tests/fixtures/gate/resource.js';
import { measureFileInflation } from '../../fixtures/p95.js';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runFixtureChild } from '../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureChildAsync } from '../../../../../apps/cli/tests/fixtures/child.js';
import { safeFixtureDiagnostic } from '../../../../../apps/cli/tests/fixtures/child.js';
import { startFixtureChild } from '../../../../../apps/cli/tests/fixtures/child.js';
import { TEST_FILE_CORES_ENV } from '../../../index.js';
import { TEST_FILE_POOL_ENV } from '../../../index.js';
import { occupiedPlaces } from '../../../index.js';
import { GATE_SLOT_HELD_ENV } from '../../../../resources/index.js';
import { GATE_SLOT_POOL_ENV } from '../../../../resources/index.js';
import { GATE_SLOT_TOKEN_ENV } from '../../../../resources/index.js';
import { BROWSER_SLOT_HELD_ENV } from '../../../../resources/index.js';

const runner = fileURLToPath(new URL('../../../../../apps/cli/src/io/run/tests.js', import.meta.url));
// Keep generated launch code as data: this classifier test never launches the browser it describes.
const browserFixtureSource = ["// pullboard: browser\nimport { spawn } from 'node:child_process';\nspawn('Google", " Chrome');\n"].join('');

test('a shell check is admitted by the test files it runs [C7,Q1,Q3]', async (t) => {
  const { root, env } = fixture(t, 2);
  mkdirSync(join(root, 'apps/cli/src/io/run'), { recursive: true });
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'apps/cli/src/io/run/tests.js'), "throw new Error('classification must not execute the runner');\n");
  writeFileSync(join(root, 'test/core.test.js'), "import { test } from 'node:test';\nthrow new Error('classification must not execute tests');\n");
  writeFileSync(join(root, 'test/browser.test.js'), browserFixtureSource);
  const admission = new URL('../../../src/io/browser/admission.js', import.meta.url).href;
  const gate = new URL('../../../index.js', import.meta.url).href;
  const commands = [
    ['browser', 'out=$(node apps/cli/src/io/run/tests.js test/browser.test.js 2>&1); rc=$?; printf "%s\\n" "$out"; [ "$rc" -eq 0 ]', true],
    ['unknown', 'eval "$CHECK"', true],
    ['core', 'out=$(node apps/cli/src/io/run/tests.js test/core.test.js 2>&1); rc=$?; printf "%s\\n" "$out"; [ "$rc" -eq 0 ]', false],
  ];
  const source = `import { checkNeedsBrowser } from ${JSON.stringify(admission)};
import { withGateSlot } from ${JSON.stringify(gate)};
${executionServicesSource(gate)}
const decisions = [];
for (const [name, command] of ${JSON.stringify(commands)}) {
  const fallbacks = [];
  const browser = await checkNeedsBrowser(process.cwd(), command, { onFallback: value => fallbacks.push(value) });
  const actual = await withGateSlot(process.cwd(), lease => {
    if (lease.executionServices.runners.runOnRunner !== executionServices.runners.runOnRunner
      || !Object.isFrozen(lease.executionServices.runners)
      || !Object.isFrozen(lease.executionServices.landing)
      || Object.keys(lease).includes('executionServices')
      || JSON.stringify(lease.runMetadata ?? {}).includes('executionServices')) {
      throw new Error('canonical execution operations must remain immutable process-local lease state');
    }
    return lease.browser;
  }, { executionServices, browser, remote: false, agent: 'admission-fixture', kind: 'check' });
  decisions.push({ name, browser, actual, fallbacks });
}
process.stdout.write(JSON.stringify(decisions));`;
  // Only this private machine fixture drops the outer proof's admission markers.
  for (const key of [GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV, BROWSER_SLOT_HELD_ENV]) delete env[key];
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, env }));
  assert.equal(result.status, 0, result.failure ?? result.stderr);
  const decisions = JSON.parse(result.stdout);
  for (const [index, [name, , expected]] of commands.entries()) {
    assert.equal(decisions[index].name, name);
    assert.equal(decisions[index].actual, expected, `${name} uses its classified machine gate slot`);
    assert.equal(decisions[index].browser, expected, `${name} classifier matches the actual lease`);
  }
  assert.ok(decisions[1].fallbacks.length, 'unparseable shell retains an explicit browser-fallback reason');
  assert.deepEqual(decisions[2].fallbacks, [], 'understood core selection needs no browser fallback');
});

test('shell admission preserves opaque suffixes and the existing short-slot boundary [C7,Q1,Q3]', async (t) => {
  const { root, env } = fixture(t, 2);
  mkdirSync(join(root, 'apps/cli/src/io/run'), { recursive: true });
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'apps/cli/src/io/run/tests.js'), "throw new Error('classification must not execute the runner');\n");
  writeFileSync(join(root, 'test/core.test.js'), "import { test } from 'node:test';\n");
  writeFileSync(join(root, 'test/browser.test.js'), browserFixtureSource);
  /** Build the coordinator's literal saved-exit and fail/skip wrapper without executing it. */
  const capture = (file, quote = "'", slashes = 1) => {
    const print = `printf ${quote}%s${'\\'.repeat(slashes)}n${quote} "$out"`;
    return `out=$(node apps/cli/src/io/run/tests.js ${file} 2>&1); rc=$?; ${print}; bad=$(${print} | grep -E '^# (fail|skipped) [1-9]'); [ "$rc" -eq 0 ] && [ -z "$bad" ] && ${print} | grep -Eq '^[[:space:]]*ok [0-9]+ - .*fixture'`;
  };
  const core = capture('test/core.test.js');
  const commands = [
    [core, false], [capture('test/core.test.js', '"', 2), false], [capture('test/browser.test.js'), true],
    [`${core}; node launch-browser.js`, true], [`${core} || true`, true], [`${core} > /dev/null`, true],
    [core.replace('rc=$?;', 'rc=0;'), true], [core.replace('"$rc" -eq', '"$status" -eq'), true],
    [core.replace('[ -z "$bad" ]', '[ -n "$bad" ]'), true],
    [core.replace('.*fixture', '$(node launch-browser.js)'), true],
    [capture('$FILES'), true], [capture('test/core.test.js --unknown'), true],
    [capture('test/core.test.js; node launch-browser.js'), true],
  ];
  const admission = new URL('../../../src/io/browser/admission.js', import.meta.url).href;
  const source = `import { checkNeedsBrowser, explicitCheckFiles } from ${JSON.stringify(admission)};
const decisions = [];
for (const [command] of ${JSON.stringify(commands)}) decisions.push(await checkNeedsBrowser(process.cwd(), command));
const short = await explicitCheckFiles(process.cwd(), ${JSON.stringify(core)});
process.stdout.write(JSON.stringify({ decisions, short }));`;
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, env }));
  assert.equal(result.status, 0, result.failure ?? result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.deepEqual(actual.decisions, commands.map(([, browser]) => browser));
  assert.equal(actual.short, null, 'new browser classification does not grant a short slot');
});

/** A fixture test file that logs when its body starts and ends, holding its token for `ms`. */
function timedFile(name, ms, body = '') {
  return `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
const mark = at => appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ run: process.env.FIXTURE_RUN, file: ${JSON.stringify(name)}, at, t: Date.now() }) + '\\n');
test(${JSON.stringify(name)}, async () => {
  mark('start');
  ${body}
  await new Promise(done => setTimeout(done, ${ms}));
  mark('end');
});
`;
}

/** A Git fixture repository with its own machine home, and an environment whose pool has `cores` tokens. */
function fixture(t, cores) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-file-pool-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: root }).status, 0);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  // The runner reads its policy from the checkout's committed HEAD, so the fixture needs one commit.
  runFixtureGit(['add', 'package.json'], { cwd: root });
  runFixtureGit(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'], { cwd: root });
  const machine = join(root, '.machine');
  mkdirSync(machine);
  // Four gate slots, so the four runs overlap and only the file pool can hold them to the cores.
  writeFileSync(join(machine, 'settings.json'), JSON.stringify({ gateSlots: 4, browserSlots: 1 }));
  const env = { ...process.env, PULLBOARD_MACHINE_HOME: machine, [TEST_FILE_CORES_ENV]: String(cores), FIXTURE_LOG: join(root, 'log.jsonl') };
  // This test file holds a token of its own run's pool; the fixture runs get a pool of their own.
  delete env[TEST_FILE_POOL_ENV];
  return { root, env, log: () => readFileSync(env.FIXTURE_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

/** The most file bodies running at one moment in a start/end log. */
function peak(events) {
  let live = 0;
  let most = 0;
  for (const event of [...events].sort((a, b) => a.t - b.t || (a.at === 'end' ? -1 : 1))) {
    live += event.at === 'start' ? 1 : -1;
    most = Math.max(most, live);
  }
  return most;
}

test('four runs never hold more test files than cores, and the longest-recorded file starts first [C7]', async (t) => {
  const { root, env, log } = fixture(t, 4);
  const files = ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js', 'e.test.js', 'z-slow.test.js'];
  for (const file of files) writeFileSync(join(root, file), timedFile(file, 300));
  const runs = await Promise.all([1, 2, 3, 4].map(run => awaitNestedRun(runFixtureChildAsync(process.execPath, [runner, ...files],
    { cwd: root, env: { ...env, FIXTURE_RUN: String(run) } }))));
  for (const result of runs) assert.equal(result.status, 0, `${result.failure ?? ""}\n${result.stdout.slice(-3000)}`);
  const events = log();
  assert.equal(events.filter(event => event.at === 'start').length, 24, 'every file of every run ran');
  assert.ok(peak(events) <= 4, `at most 4 files at once on 4 cores, saw ${peak(events)}`);

  // The last landing timed z-slow longest, so it starts first though it sorts last.
  mkdirSync(join(root, '.git', 'pullboard'), { recursive: true });
  writeFileSync(join(root, '.git', 'pullboard', 'landing-file-times.json'),
    JSON.stringify({ version: 1, files: { 'z-slow.test.js': 9000, 'c.test.js': 500, 'a.test.js': 10 } }));
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ testConcurrency: { files: 1 } }));
  writeFileSync(env.FIXTURE_LOG, '');
  const ordered = runFixtureChild(process.execPath, [runner, ...files], { cwd: root, env: { ...env, FIXTURE_RUN: 'order', PULLBOARD_LANDING_RUN: '1' }, encoding: 'utf8' });
  assert.equal(ordered.status, 0, ordered.failure ?? ordered.stdout);
  assert.deepEqual(log().filter(event => event.at === 'start').map(event => event.file),
    ['z-slow.test.js', 'c.test.js', 'a.test.js', 'b.test.js', 'd.test.js', 'e.test.js'], 'timed files longest first, then the rest in order');
});

test('a file waiting on a nested run lends its place, so saturated parents still run at most cores files [C7]', async (t) => {
  const { root, env, log } = fixture(t, 2);
  for (const file of ['inner-a.test.js', 'inner-b.test.js']) writeFileSync(join(root, file), timedFile(file, 300));
  // Each outer file runs both inner files through run-tests and waits; its own body does no work meanwhile.
  const nested = `const { spawnSync } = await import('node:child_process');
  const inner = spawnSync(process.execPath, [${JSON.stringify(runner)}, 'inner-a.test.js', 'inner-b.test.js'], { cwd: ${JSON.stringify(root)}, env: { ...process.env, FIXTURE_RUN: 'inner-' + process.pid }, encoding: 'utf8' });
  if (inner.status !== 0) throw new Error(inner.stdout + inner.stderr);`;
  for (const file of ['outer-a.test.js', 'outer-b.test.js']) {
    writeFileSync(join(root, file), timedFile(file, 0, nested).replace("mark('start');", '').replace("mark('end');", ''));
  }
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, [runner, 'outer-a.test.js', 'outer-b.test.js'], { cwd: root, env: { ...env, FIXTURE_RUN: 'outer' } }));
  assert.equal(result.status, 0, result.failure ?? result.stdout);
  const events = log();
  assert.equal(events.filter(event => event.at === 'start').length, 4, 'both inner files ran under both outer files');
  assert.ok(peak(events) <= 2, `two saturated outer files with nested runs still run at most 2 files, saw ${peak(events)}`);
});

test('a caller keeps its place while its synchronous call is open, so no other file takes it [C7]', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pullboard-file-pool-race-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  /** A live process to stand in for one pool row; the pool prunes rows of processes that have gone. */
  const live = () => {
    const child = startFixtureChild('sleep', ['30']);
    t.after(() => child.kill('SIGKILL'));
    return child.pid;
  };
  assert.equal(await occupiedPlaces(home), 0);
  const db = new DatabaseSync(join(home, 'test-file-pool.sqlite'));
  t.after(() => db.close());
  const [parent, unrelated, child] = [live(), live(), live()];
  const hold = (pid, lender = null, call = null) => db.prepare('INSERT INTO file_holder(pid, since, lender, call) VALUES (?, ?, ?, ?)').run(pid, Date.now(), lender, call);
  hold(parent);
  hold(unrelated);
  db.prepare('INSERT INTO file_call(call, lender) VALUES (?, ?)').run('call-1', parent);
  assert.equal(await occupiedPlaces(home), 2, 'a caller with no file of its call yet keeps its place');
  hold(child, parent, 'call-1');
  assert.equal(await occupiedPlaces(home), 2, 'the file of its call runs in that place');
  db.prepare('UPDATE file_call SET closing = 1 WHERE call = ?').run('call-1');
  assert.equal(await occupiedPlaces(home), 2, 'a closing call still counts its file in the caller\'s place');
  db.prepare('DELETE FROM file_holder WHERE pid = ?').run(child);
  assert.equal(await occupiedPlaces(home), 2, 'that file gone, the place is the caller\'s again, not free');
  db.prepare('DELETE FROM file_call WHERE call = ?').run('call-1');
  assert.equal(await occupiedPlaces(home), 2, 'the call returned, the caller runs in its own place');
});

test('a parent that starts its nested run asynchronously keeps its own token, so its nested files take separate ones [C7]', { cpuLoad: true }, async (t) => {
  const { root, env, log } = fixture(t, 2);
  for (const file of ['inner-a.test.js', 'inner-b.test.js']) writeFileSync(join(root, file), timedFile(file, 400));
  // The parent starts its nested run without blocking on it and spins the CPU until the run ends.
  writeFileSync(join(root, 'busy.test.js'), `import { spawn } from 'node:child_process';
import { test } from 'node:test';
test('busy parent', async () => {
  const child = spawn(process.execPath, [${JSON.stringify(runner)}, 'inner-a.test.js', 'inner-b.test.js'], { cwd: ${JSON.stringify(root)}, env: { ...process.env, FIXTURE_RUN: 'inner' }, stdio: 'ignore' });
  let done = false;
  child.on('exit', () => { done = true; });
  while (!done) {
    const until = Date.now() + 40;
    while (Date.now() < until) { /* computing */ }
    await new Promise(next => setImmediate(next));
  }
});
`);
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, [runner, 'busy.test.js'], { cwd: root, env: { ...env, FIXTURE_RUN: 'outer' } }));
  assert.equal(result.status, 0, result.failure ?? result.stdout);
  const events = log();
  assert.equal(events.filter(event => event.at === 'start').length, 2, 'both nested files ran');
  assert.equal(peak(events), 1, 'with the busy parent holding one of 2 places, its nested files share the one left');
});

test('an async parent lends its token through awaitNestedRun [C7]', async (t) => {
  const poolModule = new URL('../../../index.js', import.meta.url).href;
  const api = await import('../../../index.js');
  assert.equal(typeof api.awaitNestedRun, 'function', 'an explicit yielding-wait helper is available');
  const { root, env, log } = fixture(t, 1);
  writeFileSync(join(root, 'inner.test.js'), timedFile('inner.test.js', 0));
  writeFileSync(join(root, 'parent.test.js'), `import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { awaitNestedRun } from ${JSON.stringify(poolModule)};
test('yielding parent', async () => {
  const child = spawn(process.execPath, [${JSON.stringify(runner)}, 'inner.test.js'], { cwd: ${JSON.stringify(root)}, env: { ...process.env, FIXTURE_RUN: 'inner' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume();
  child.stderr.resume();
  const result = await awaitNestedRun(child);
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
});
`);
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, [runner, 'parent.test.js'], { cwd: root, env: { ...env, FIXTURE_RUN: 'outer' } }));
  assert.equal(result.status, 0, result.failure ?? result.stdout);
  assert.equal(log().filter(event => event.at === 'start').length, 1, 'the nested file ran despite a one-token pool');
  assert.equal(await occupiedPlaces(env.PULLBOARD_MACHINE_HOME), 0, 'no holder remains after the parent exits');
  const db = new DatabaseSync(join(env.PULLBOARD_MACHINE_HOME, 'test-file-pool.sqlite'));
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM file_call').get().n, 0, 'the explicit loan drained and closed'); }
  finally { db.close(); }

  const blocked = fixture(t, 1);
  writeFileSync(join(blocked.root, 'inner.test.js'), timedFile('inner.test.js', 0));
  writeFileSync(join(blocked.root, 'parent.test.js'), `import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
test('parent without the explicit wait', { timeout: 10_000 }, async (t) => {
  const child = spawn(process.execPath, [${JSON.stringify(runner)}, 'inner.test.js'], { cwd: ${JSON.stringify(blocked.root)}, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let live = true;
  t.after(() => { if (live) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } });
  let text = '';
  const closed = new Promise(resolve => child.once('close', code => { live = false; resolve(code); }));
  await new Promise(resolve => {
    const sample = chunk => { text += chunk; if (text.includes('holding its token while nested files wait')) resolve(); };
    child.stdout.on('data', sample); child.stderr.on('data', sample);
  });
  const home = JSON.parse(process.env.PULLBOARD_TEST_FILE_POOL).home;
  const db = new DatabaseSync(join(home, 'test-file-pool.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM file_holder WHERE pid = ?').get(process.pid).n, 1);
    assert.ok(db.prepare('SELECT count(*) AS n FROM file_waiter').get().n > 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM file_call').get().n, 0);
  } finally { db.close(); }
  assert.ok(text.includes('use awaitNestedRun(child) only while yielding'));
  process.kill(-child.pid, 'SIGTERM');
  await closed;
});
`);
  const noLoan = await awaitNestedRun(runFixtureChildAsync(process.execPath, [runner, 'parent.test.js'], { cwd: blocked.root, env: blocked.env }));
  assert.equal(noLoan.status, 0, `${noLoan.failure ?? ''}\n${noLoan.stdout}`);
  assert.equal(await occupiedPlaces(blocked.env.PULLBOARD_MACHINE_HOME), 0, 'the bounded negative control cleaned its real processes');
});

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
import { test } from 'node:test';
import { awaitNestedRun } from ${JSON.stringify(poolModule)};
test('explicit wait contracts', { timeout: 10_000 }, async (t) => {
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
  // The parent's shell call starts a detached run and returns at once; the parent then works on in its own place.
  const detached = `const { execSync } = await import('node:child_process');
  execSync(${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(runner)} inner-a.test.js inner-b.test.js > /dev/null 2>&1 &`)}, { cwd: ${JSON.stringify(root)}, env: { ...process.env, FIXTURE_RUN: 'inner' } });
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


test('four concurrent runs start only token-owned file processes and keep p95 below twice standalone [C7]', async t => {
  for (const mode of ['native', 'landing']) await t.test(mode, async scope => {
    const measurement = await measureFileInflation(scope, mode);
    scope.diagnostic('P95_MEASUREMENT=' + JSON.stringify(measurement));
    assert.equal(measurement.peakConcurrentRuns, 4, 'all four actual private gate leases overlapped');
    await scope.test('only token-owned file processes start', () => {
      assert.ok(measurement.peakFileProcesses <= measurement.cores,
        `a two-token machine must not spawn files that wait for a token; saw ${measurement.peakFileProcesses}`);
    });
    await scope.test('p95 stays below twice standalone', () => {
      assert.ok(measurement.p95 < 2, `p95 process-lifetime ratio ${measurement.p95} must be below2x standalone`); // budget: #1091 requires p95<2x under four concurrent runs.
    });
  });
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
