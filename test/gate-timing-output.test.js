/** @pullboard-test-input source-tree */
/** Timing profiles parse the caller's unchanged TAP or JUnit output [C7,V10]. */
import { copyFixtureRunner } from './fixture-runner-copy.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { gateReport, runProfiledShell } from '../src/gate.js';

const TEMP = [];
const savedContext = process.env.NODE_TEST_CONTEXT;
const savedOptions = process.env.NODE_OPTIONS;
test.before(() => { delete process.env.NODE_TEST_CONTEXT; delete process.env.NODE_OPTIONS; });
test.after(() => { if (savedContext === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = savedContext; if (savedOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = savedOptions; });

test('timing profile reads direct and native TAP without inventing file rows [C7,V10]', async t => {
  const repo = makeRepo();
  const caseFile = join(repo, 'timed', 'slow.test.mjs');
  mkdirSync(join(repo, 'timed'));
  writeFileSync(caseFile, "import { test } from 'node:test'; test('slow direct sample', async () => new Promise(resolve => setTimeout(resolve, 130)));");

  await t.test('direct node execution keeps its printed duration [C7,V10]', () => {
    const direct = runProfiledShell(repo, 'node timed/slow.test.mjs', { artifactDirectory: join(repo, 'artifacts'), persistLog: true, waitMs: 17 });
    assert.equal(direct.isGreen, true, direct.output);
    assert.match(direct.output, /slow direct sample/);
    if (/^TAP version \d+/mu.test(direct.output)) {
      assert.ok(direct.profile.tests.some(entry => entry.name.includes('slow direct sample') && entry.durationMs >= 100)); // budget: declared 130ms slow sample must appear in the measured duration.
      assert.equal(direct.profile.format, 'tap');
      assert.equal(direct.profile.unavailable, null);
    } else {
      assert.equal(direct.profile.format, 'none');
      assert.equal(direct.profile.unavailable, 'per-test timing unavailable: output was not TAP or JUnit');
    }
    assert.deepEqual(direct.profile.files, [], 'test timing without a file timing must not become a file row');
    assert.equal(direct.profile.waitMs, 17); // budget: declared synthetic waitMs=17 input is retained exactly.
    assert.ok(direct.profile.wallMs >= 100); // budget: declared 130ms slow sample contributes to measured wall time.
  });

  await t.test('native default output preserves caller argv and execArgv [C7,V10]', () => {
    const trace = join(repo, 'invocation.json');
    const script = join(repo, 'timed', 'invocation.test.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs'; import { test } from 'node:test'; writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ argv: process.argv.slice(1), execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? '' })); test('native default sample', () => {});`);
    const command = 'node --test timed/invocation.test.mjs';
    const bareOutput = execFileSync('/bin/sh', ['-c', command], { cwd: repo, encoding: 'utf8' });
    assert.match(bareOutput, /native default sample/);
    const callerInvocation = JSON.parse(readFileSync(trace, 'utf8'));
    assert.deepEqual(callerInvocation.argv, [script]);
    assert.equal(callerInvocation.nodeOptions, '');
    // Node may supply default child flags; profiling must preserve the bare command's invocation.
    const native = runProfiledShell(repo, command, { artifactDirectory: join(repo, 'artifacts'), persistLog: true, waitMs: 17 });
    assert.equal(native.isGreen, true, native.output);
    assert.match(native.output, /native default sample/);
    assert.equal(/^TAP version \d+/mu.test(native.output), /^TAP version \d+/mu.test(bareOutput), 'profiling preserves the caller-selected output format');
    assert.deepEqual(JSON.parse(readFileSync(trace, 'utf8')), callerInvocation);
    assert.deepEqual(native.profile.files, [], 'default TAP does not provide a trustworthy file-duration row');
    if (/^TAP version \d+/mu.test(native.output)) assert.ok(native.profile.tests.some(entry => entry.name.includes('native default sample')));
    else assert.equal(native.profile.unavailable, 'per-test timing unavailable: output was not TAP or JUnit');
    assert.equal(native.profile.waitMs, 17); // budget: declared synthetic waitMs=17 input is retained exactly.
  });

  await t.test('explicit TAP reporter remains caller-selected and retains its timing [C7,V10]', () => {
    const command = 'node --test-reporter=tap --test timed/slow.test.mjs';
    const explicit = runProfiledShell(repo, command, { artifactDirectory: join(repo, 'artifacts'), persistLog: true, waitMs: 17 });
    assert.equal(explicit.isGreen, true, explicit.output);
    assert.match(explicit.output, /TAP version 13/);
    assert.match(explicit.output, /slow direct sample/);
    assert.ok(explicit.profile.tests.some(entry => entry.name.includes('slow direct sample') && entry.durationMs >= 100)); // budget: declared 130ms slow sample must appear in the measured duration.
    assert.deepEqual(explicit.profile.files, []);
  });
});

test('timing profile reads caller-selected native JUnit stdout [C7,V10]', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'junit.test.mjs'), "import {test} from 'node:test'; test('native JUnit slow sample', async()=>new Promise(resolve=>setTimeout(resolve,130)));\n");
  const run = runProfiledShell(repo, 'node --test --test-reporter=junit junit.test.mjs', {artifactDirectory:join(repo,'artifacts'),persistLog:true,waitMs:17});
  assert.equal(run.isGreen,true,run.output);
  assert.equal(run.profile.format,'junit');
  assert.ok(run.profile.tests.some(value=>value.name==='native JUnit slow sample' && value.durationMs>=100)); // budget: declared 130ms slow sample must appear in the measured duration.
  assert.deepEqual(run.profile.files,[],'native JUnit supplies no explicit file duration');
});

test('timing profile uses only actual JUnit file and test metadata [C7,V10]', () => {
  const repo = makeRepo();
  const commandFile = join(repo, 'emit-junit.mjs');
  writeFileSync(commandFile, `import { writeFileSync } from 'node:fs'; const start = Date.now(); await new Promise(resolve => setTimeout(resolve, 130)); const seconds = ((Date.now() - start) / 1000).toFixed(3); process.stdout.write('<testsuite name="suite" file="timed/suite.test.js" time="' + seconds + '"><testcase name="slow &amp; measured" file="timed/suite.test.js" time="' + seconds + '"><failure message="expected red"/></testcase></testsuite>\\n'); process.exitCode = 1;`);
  const command = 'node emit-junit.mjs';
  const failed = runProfiledShell(repo, command, { artifactDirectory: join(repo, 'artifacts'), persistLog: true, waitMs: 17 });
  assert.equal(failed.isGreen, false);
  assert.match(failed.output, /testsuite/);
  assert.ok(failed.profile.wallMs >= 100); // budget: declared 130ms JUnit fixture sleep contributes to wall time.
  assert.equal(failed.profile.format, 'junit');
  assert.ok(failed.profile.files.some(file => file.path === 'timed/suite.test.js' && file.durationMs >= 100)); // budget: declared 130ms JUnit fixture sleep is emitted as file duration.
  assert.ok(failed.profile.tests.some(entry => entry.file === 'timed/suite.test.js' && entry.name === 'slow & measured' && entry.durationMs >= 100 && !entry.passed)); // budget: declared 130ms JUnit fixture sleep is emitted as test duration.
  assert.equal(failed.profile.waitMs, 17); // budget: declared synthetic waitMs=17 input is retained exactly.
  assert.match(gateReport({ ...failed, log: failed.logPath }), /slowest test files:[\s\S]*timed\/suite\.test\.js/);
});

test('timing profile leaves unsupported runner commands and destinations untouched [C7,V10]', () => {
  const repo = makeRepo();
  const testFile = join(repo, 'one.test.mjs');
  writeFileSync(testFile, "import { test } from 'node:test'; test('unsupported runner sample', () => {});\n");
  const spec = runProfiledShell(repo, 'node --test-reporter=spec --test one.test.mjs', {artifactDirectory:join(repo,'artifacts'),persistLog:true,waitMs:17});
  assert.equal(spec.isGreen,true,spec.output);
  assert.match(spec.output,/unsupported runner sample/u);
  assert.equal(spec.profile.format,'none');
  assert.equal(spec.profile.unavailable,'per-test timing unavailable: output was not TAP or JUnit');
  const destination = join(repo, 'caller-junit.xml');
  const command = `node --test-reporter=junit --test-reporter-destination=${shellWord(destination)} --test one.test.mjs`;
  const result = runProfiledShell(repo, command, { artifactDirectory: join(repo, 'artifacts'), persistLog: true, waitMs: 17 });
  assert.equal(result.isGreen, true, result.output);
  assert.deepEqual(result.profile.files, []);
  assert.deepEqual(result.profile.tests, []);
  assert.equal(result.profile.format, 'none');
  assert.match(result.profile.runner, /node/);
  assert.equal(result.profile.unavailable, 'per-test timing unavailable: output was not TAP or JUnit');
  assert.equal(result.profile.waitMs, 17); // budget: declared synthetic waitMs=17 input is retained exactly.
  assert.ok(result.profile.wallMs >= 0);
  assert.match(gateReport({ ...result, log: result.logPath }), /per-test timing unavailable: output was not TAP or JUnit/);
  assert.match(gateReport({ ...result, log: result.logPath }), /node/);
  assert.match(readFileSync(destination, 'utf8'), /testsuite/);
});

/** Initialize a real temporary Git checkout for the public profiling API. */
function makeRepo() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-timing-output-')));
  TEMP.push(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  return repo;
}

/** Quote one path for the shell command passed unchanged to the profiler. */
function shellWord(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

test.after(() => { for (const path of TEMP) rmSync(path, { recursive: true, force: true }); });

test('a gate receipt splits waiting from running [C7,V10]', async t => {
  const { createE2eHelpers } = await import('./e2e-helpers.js');
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  // A check the runner can classify: this repo's own runner and one named file that never launches a browser.
  copyFixtureRunner(resolve(import.meta.dirname, '..'), box.repo);
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test/quick.test.js'), "import { test } from 'node:test'; test('quick', () => new Promise(done => setTimeout(done, 200)));\n");
  box.git(box.repo, 'add', '.');
  box.git(box.repo, 'commit', '-q', '-m', 'test: add a browser-free named check');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 1, gate: { browserFreeChecks: true } }));
  assert.equal(box.run(box.repo, 'add', 'web', 'Timed check', '--criterion', 'the check runs', '--check', 'node bin/run-tests.js test/quick.test.js').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  // A stand-in holds the only slot for HOLD_MS, then lets the check in.
  const HOLD_MS = 3000; // budget: long enough that the wait cannot be confused with the 200 ms test.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `import { takeResource } from ${JSON.stringify(resolve(import.meta.dirname, '../src/resources.js'))};
const lease = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: ${JSON.stringify(box.repo)}, agent: 'receipt-stand-in' });
console.log('ready'); setTimeout(() => { lease.release(); process.exit(0); }, ${HOLD_MS});`], { cwd: box.repo, env: box.env, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill());
  await new Promise(ready => holder.stdout.once('data', ready));
  const checked = box.run(box.web, 'check', '1', '--yes', '--json');
  assert.equal(checked.code, 0, checked.out + checked.err);
  const receipt = JSON.parse(checked.out).result?.receipt ?? JSON.parse(checked.out).receipt;
  assert.ok(receipt, checked.out);
  assert.ok(receipt.waitMs >= HOLD_MS - 1000, `the wait covers the stand-in's hold: ${JSON.stringify(receipt)}`);
  assert.ok(receipt.runMs >= 150 && receipt.runMs < HOLD_MS - 1000, `the run time covers only the test: ${JSON.stringify(receipt)}`);
  for (const field of ['admissionMs', 'setupMs', 'evidenceMs']) assert.ok(Number.isFinite(receipt[field]) && receipt[field] >= 0, field);
  assert.deepEqual(receipt.slot, { kind: 'ordinary', reason: 'it launches no browser' }, 'the slot kind and why');
  const stats = box.run(box.repo, 'stats');
  assert.match(stats.out, /gate waits, last day:\n {2}check: 1 run; wait median \d+\.\d{2}s, slowest \d+\.\d{2}s; run median \d+\.\d{2}s/u, stats.out);
});
