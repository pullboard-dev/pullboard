/** Timing profiles parse the caller's unchanged TAP or JUnit output [C7,V10]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
      assert.ok(direct.profile.tests.some(entry => entry.name.includes('slow direct sample') && entry.durationMs >= 100));
      assert.equal(direct.profile.format, 'tap');
      assert.equal(direct.profile.unavailable, null);
    } else {
      assert.equal(direct.profile.format, 'none');
      assert.equal(direct.profile.unavailable, 'per-test timing unavailable: output was not TAP or JUnit');
    }
    assert.deepEqual(direct.profile.files, [], 'test timing without a file timing must not become a file row');
    assert.equal(direct.profile.waitMs, 17);
    assert.ok(direct.profile.wallMs >= 100);
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
    assert.equal(native.profile.waitMs, 17);
  });

  await t.test('explicit TAP reporter remains caller-selected and retains its timing [C7,V10]', () => {
    const command = 'node --test-reporter=tap --test timed/slow.test.mjs';
    const explicit = runProfiledShell(repo, command, { artifactDirectory: join(repo, 'artifacts'), persistLog: true, waitMs: 17 });
    assert.equal(explicit.isGreen, true, explicit.output);
    assert.match(explicit.output, /TAP version 13/);
    assert.match(explicit.output, /slow direct sample/);
    assert.ok(explicit.profile.tests.some(entry => entry.name.includes('slow direct sample') && entry.durationMs >= 100));
    assert.deepEqual(explicit.profile.files, []);
  });
});

test('timing profile reads caller-selected native JUnit stdout [C7,V10]', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'junit.test.mjs'), "import {test} from 'node:test'; test('native JUnit slow sample', async()=>new Promise(resolve=>setTimeout(resolve,130)));\n");
  const run = runProfiledShell(repo, 'node --test --test-reporter=junit junit.test.mjs', {artifactDirectory:join(repo,'artifacts'),persistLog:true,waitMs:17});
  assert.equal(run.isGreen,true,run.output);
  assert.equal(run.profile.format,'junit');
  assert.ok(run.profile.tests.some(value=>value.name==='native JUnit slow sample' && value.durationMs>=100));
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
  assert.ok(failed.profile.wallMs >= 100);
  assert.equal(failed.profile.format, 'junit');
  assert.ok(failed.profile.files.some(file => file.path === 'timed/suite.test.js' && file.durationMs >= 100));
  assert.ok(failed.profile.tests.some(entry => entry.file === 'timed/suite.test.js' && entry.name === 'slow & measured' && entry.durationMs >= 100 && !entry.passed));
  assert.equal(failed.profile.waitMs, 17);
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
  assert.equal(result.profile.waitMs, 17);
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
