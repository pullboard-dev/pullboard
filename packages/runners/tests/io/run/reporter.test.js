/** @pullboard-test-input packages/gate/src/io/run/tests.js */
/** Keep the production runner's report stable across Node versions and caller options [C7]. */
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureChildAsync } from '../../../../gate/tests/fixtures/child.js';
import { awaitNestedRun } from '../../../../gate/index.js';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const runner = fileURLToPath(new URL('../../../../../apps/cli/src/io/run/tests.js', import.meta.url));

/** Create a fixture that observes actual child arguments and returns the runner result. */
function runReporterFixture(t, reporterArgs = [], extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-run-tests-reporter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = join(root, 'reporter.test.js');
  const capture = join(root, 'child-args.json');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(fixture, `import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.PULLBOARD_REPORTER_CAPTURE_FILE, JSON.stringify(process.execArgv));
test('reporter fixture [C7]', () => {});
`);

  const result = spawnSync(process.execPath, [runner, ...reporterArgs, fixture], {
    cwd: root,
    env: {
      ...process.env,
      ...extraEnv,
      PULLBOARD_REPORTER_CAPTURE_FILE: capture,
    },
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const childArgs = JSON.parse(readFileSync(capture, 'utf8'));
  return { result, output, childArgs };
}

test('run-tests prints TAP on every Node version and keeps a caller reporter [C7]', (t) => {
  const defaultReporter = runReporterFixture(t);
  assert.equal(defaultReporter.result.status, 0, defaultReporter.output);
  assert.match(defaultReporter.output, /^TAP version \d+/mu);
  assert.match(defaultReporter.output, /^ok \d+ - reporter fixture \[C7\]/mu);
  assert.ok(!defaultReporter.childArgs.some(arg => arg.startsWith('--test-reporter')),
    'the parent owns the TAP reporter rather than restarting it in each file');

  const callerReporter = runReporterFixture(t, ['--test-reporter=spec']);
  assert.equal(callerReporter.result.status, 0, callerReporter.output);
  assert.ok(!callerReporter.childArgs.some(arg => arg.startsWith('--test-reporter')),
    'the selected spec reporter belongs to the parent');
  assert.ok(!callerReporter.childArgs.includes('--test-reporter=tap'), 'the default does not override a caller reporter');
  assert.doesNotMatch(callerReporter.output, /^TAP version \d+/mu);
  assert.match(callerReporter.output, /reporter fixture \[C7\]/u);

  const splitCallerReporter = runReporterFixture(t, ['--test-reporter', 'spec']);
  assert.equal(splitCallerReporter.result.status, 0, splitCallerReporter.output);
  assert.ok(!splitCallerReporter.childArgs.some(arg => arg.startsWith('--test-reporter')),
    'the separate-value reporter option selects the parent reporter');
  assert.ok(!splitCallerReporter.childArgs.includes('--test-reporter=tap'), 'the default does not override the separate caller option');
  assert.doesNotMatch(splitCallerReporter.output, /^TAP version \d+/mu);
});

test('run-tests never injects timing reporters beside caller reporter options [C7,V10]', (t) => {
  for (const reporterArgs of [
    ['--test-reporter=spec'], ['--test-reporter', 'spec'],
    ['--test-reporter=spec', '--test-reporter-destination=stdout'],
    ['--test-reporter', 'spec', '--test-reporter-destination', 'stdout'],
  ]) {
    const run = runReporterFixture(t, reporterArgs, { PULLBOARD_TEST_TIMING_PROFILE: join(tmpdir(), 'must-not-inject') });
    assert.equal(run.result.status, 0, run.output);
    const preload = run.childArgs.indexOf('--import');
    const bootstrap = decodeURIComponent(run.childArgs[preload + 1]);
    assert.ok(bootstrap.includes(new URL('../../../../../apps/cli/src/io/run/tests.js', import.meta.url).href),
      'the actual worker admission bootstrap imports the ordinary production watchdog');
    assert.ok(!run.childArgs.some(arg => arg.startsWith('--test-reporter')),
      'caller reporters run once in the parent, without injected worker timing reporters');
    assert.match(run.output, /ℹ tests 1/u);
    assert.doesNotMatch(run.output, /gate-profile-reporter|"files":/u);
  }
});

test('multiple dispatched files share one reporter factory and one truthful summary [C7,V10]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-dispatch-reporters-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(root, 'one.test.js'), `import { test } from 'node:test';
test('outer suite', async t => {
  await t.test('nested case', () => { console.log('TAP version 13\\n# pass 999\\n# fail 999'); });
});
test.skip('skipped case', () => {});
test.todo('todo case');
`);
  writeFileSync(join(root, 'two.test.js'), "import { test } from 'node:test';\ntest('other file case', () => {});\n");
  const calls = join(root, 'reporter-calls.jsonl');
  writeFileSync(join(root, 'custom.mjs'), `import { appendFileSync } from 'node:fs';
/** Observe the public structured stream, without manufacturing test outcomes or interpreting stdout. */
export default async function* observe(events) {
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ type: 'start', pid: process.pid }) + '\\n');
  for await (const event of events) {
    if (event.type === 'test:pass') yield event.data.name + '\\n';
    if (event.type === 'test:summary' && !event.data.file) {
      appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ type: 'summary', ...event.data }) + '\\n');
    }
  }
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ type: 'end' }) + '\\n');
}
`);
  const output = join(root, 'custom.txt');
  const result = spawnSync(process.execPath, [runner, '--test-reporter=tap', '--test-reporter=./custom.mjs',
    '--test-reporter-destination=stdout', `--test-reporter-destination=${output}`, 'one.test.js', 'two.test.js'],
  { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
  for (const line of ['# pass 3', '# fail 0', '# skipped 1', '# todo 1']) {
    assert.equal(result.stdout.split('\n').filter(value => value === line).length, 1, `one native aggregate ${line}`);
  }
  assert.match(result.stdout, /pass 999/u, 'embedded TAP remains visible test stdout');
  assert.match(result.stdout, /^ok 4 - other file case$/mu, 'root numbering continues across files');
  assert.match(result.stdout, /^\s+ok 1 - nested case$/mu, 'nested numbering stays local to its suite');
  const events = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.type === 'start').length, 1, 'custom reporter starts once');
  assert.equal(events.filter(event => event.type === 'end').length, 1, 'custom reporter finalizes once');
  const summaries = events.filter(event => event.type === 'summary');
  assert.equal(summaries.length, 1, 'custom reporter receives one aggregate summary');
  assert.deepEqual(summaries[0].counts, { tests: 5, suites: 0, passed: 3, failed: 0,
    cancelled: 0, skipped: 1, todo: 1, topLevel: 4 });
  assert.equal(readFileSync(output, 'utf8').split('\n').filter(name => name === 'other file case').length, 1);
});

/** Record the actual legacy native invocation; watch additionally publishes its own real PID/parent binding. */
function legacyObserver(root, capture, watch) {
  const path = join(root, 'observe-native.mjs');
  writeFileSync(path, `import cp from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
if (process.argv[1] === ${JSON.stringify(runner)}) {
  const original = cp.spawnSync;
  cp.spawnSync = function observe(command, args, options) {
    if (command === process.execPath && args?.includes('--test')) {
      writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ pid: process.pid, args }));
    }
    return original.call(this, command, args, options);
  };
  syncBuiltinESMExports();
} else if (process.execArgv.includes('--watch')) {
  writeFileSync(${JSON.stringify(watch)}, JSON.stringify({ pid: process.pid, parentPid: process.ppid }));
}
`);
  return path;
}

test('watch and aggregate coverage retain their single native orchestrator [C7]', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-native-special-modes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const capture = join(root, 'native.json');
  const watch = join(root, 'watch.json');
  const preload = legacyObserver(root, capture, watch);
  const env = { ...process.env, NODE_OPTIONS: `--import="${preload}"` };
  await t.test('coverage is merged before applying its threshold', () => {
    writeFileSync(join(root, 'shared.mjs'), 'export const alpha = () => 1;\nexport const beta = () => 2;\n');
    for (const name of ['alpha', 'beta']) writeFileSync(join(root, `${name}.test.mjs`),
      `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${name} } from './shared.mjs';\ntest('${name}', () => assert.equal(${name}(), ${name === 'alpha' ? 1 : 2}));\n`);
    const result = spawnSync(process.execPath, [runner, '--experimental-test-coverage',
      '--test-coverage-functions=100', '--test-coverage-include=shared.mjs', 'alpha.test.mjs', 'beta.test.mjs'],
    { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.context);
    const observed = JSON.parse(readFileSync(capture, 'utf8'));
    assert.ok(observed.args.includes('--test') && observed.args.includes('--test-coverage-functions=100'));
    assert.ok(observed.args.includes('alpha.test.mjs') && observed.args.includes('beta.test.mjs'),
      'one native invocation receives both files before the aggregate threshold');
    assert.match(result.stdout, /^# pass 2$/mu);
    assert.match(result.stdout, /shared\.mjs/u);
  });
  await t.test('watch executes its first real case and stops through its observed owner', async () => {
    writeFileSync(join(root, 'watch.test.mjs'), `import { test } from 'node:test';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(watch)}, JSON.stringify({ pid: process.ppid, workerPid: process.pid }));\ntest('watch cell passed', () => {});\n`);
    const run = runFixtureChildAsync(process.execPath, [runner, '--watch', 'watch.test.mjs'], { cwd: root, env });
    let stopped = false;
    /** Signal only the observed watcher while its current parent is this exact owned live runner. */
    const stop = () => {
      if (stopped) return;
      let owned;
      if (existsSync(watch)) owned = JSON.parse(readFileSync(watch, 'utf8'));
      else {
        // Failure cleanup still targets only an actual native watcher of this live owned runner.
        const census = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
        const children = census.stdout.split('\n').map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/u))
          .filter(row => row && Number(row[2]) === run.child.pid && row[3].includes('--watch') && row[3].includes('watch.test.mjs'));
        assert.equal(children.length, 1, 'one owned native watcher is available for normal termination');
        owned = { pid: Number(children[0][1]) };
      }
      assert.ok(Number.isSafeInteger(owned.pid) && owned.pid > 0);
      const current = spawnSync('ps', ['-p', String(owned.pid), '-o', 'ppid=,command='], { encoding: 'utf8' });
      if (current.status !== 0) return;
      assert.match(current.stdout, new RegExp(`^\\s*${run.child.pid}\\s+`), 'the watcher still belongs to our runner');
      assert.match(current.stdout, /--watch/u);
      process.kill(owned.pid, 'SIGTERM');
      stopped = true;
    };
    let output = '';
    const control = new Promise((resolve, reject) => {
      const ceiling = setTimeout(() => { try { stop(); } catch (error) { reject(error); } reject(new Error('watch fixture did not publish its first native green summary')); }, 10_000); // budget: owned watch fixture setup ceiling, not a performance bar.
      run.child.stdout.on('data', chunk => {
        output += chunk;
        if (!/^# pass 1$/mu.test(output)) return;
        try { stop(); clearTimeout(ceiling); resolve(); }
        catch (error) { clearTimeout(ceiling); reject(error); }
      });
      run.child.once('close', () => {
        clearTimeout(ceiling);
        if (!stopped) reject(new Error('watch ended before the owned first-pass control'));
      });
    });
    control.catch(() => {});
    const waiting = awaitNestedRun(run);
    let controlError;
    try { await control; } catch (error) { controlError = error; stop(); }
    const result = await waiting;
    if (controlError) throw controlError;
    assert.ok(stopped, 'normal termination targeted the observed native watcher');
    assert.ok(result.status === 0 || result.signal === 'SIGTERM', 'only normal owned watch termination is accepted');
    assert.match(result.stdout, /watch cell passed/u);
    const observed = JSON.parse(readFileSync(capture, 'utf8'));
    assert.equal(observed.pid, run.child.pid);
    assert.ok(observed.args.includes('--watch') && observed.args.includes('--test'));
    assert.equal(observed.args.filter(arg => arg === 'watch.test.mjs').length, 1);
  });
});
