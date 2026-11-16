/** @pullboard-test-input packages/gate/src/io/browser/admission.js packages/gate/src/io/run/tests.js */
/** Test files on one machine never outnumber its cores, and the longest files start first [C7]. */
import { executionServices } from '../../../../../apps/cli/tests/fixtures/gate/execution.js';
import { executionServicesSource } from '../../../../../apps/cli/tests/fixtures/gate/execution.js';
import { withGateSlot } from '../../../index.js';
import { awaitNestedRun } from '../../../index.js';
import { timedFile } from '../../fixtures/file-pool.js';
import { fixture } from '../../fixtures/file-pool.js';
import { peak } from '../../fixtures/file-pool.js';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runFixtureChild } from '../../fixtures/child.js';
import { runFixtureChildAsync } from '../../fixtures/child.js';
import { startFixtureChild } from '../../fixtures/child.js';
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
    if (lease.executionServices.runners.runOnRunnerAsync !== executionServices.runners.runOnRunnerAsync
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
