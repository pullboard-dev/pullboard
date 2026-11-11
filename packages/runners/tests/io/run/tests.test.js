/** @pullboard-test-input source-tree */
/** Exercise native test-file sharding through the production test runner [C7]. */
import { copyPackageFiles } from '../../../index.js';
import assert from 'node:assert/strict';
import {
  execFileSync,
  spawn,
} from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  join,
  resolve,
} from 'node:path';
import {
  fileURLToPath,
  pathToFileURL,
} from 'node:url';
import { test } from 'node:test';
import {
  startFixtureChild,
  runFixtureChild,
  runFixtureGit,
} from '../../../../../apps/cli/tests/fixtures/child.js';
import { focusedPoolSnapshot } from '../../fixtures/pool.js';
import { stageFixtureTests } from '../../fixtures/tests.js';

const runner = fileURLToPath(new URL('../../../../gate/src/io/run/tests.js', import.meta.url));
const shardFileCount = 9;

/** Treat a reaped or zombie fixture PID as drained while waiting for it to stop executing. */
async function waitForFixtureProcessDrain(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
      if (!state || state.startsWith('Z')) return true;
    } catch { return true; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

/** Wait until a fixture PID is executing rather than stopped or reaped. */
async function waitForFixtureProcessRunning(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
      if (state && !state.startsWith('Z')) return true;
    } catch { return false; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

/** Capture a fixture's PID, process group, and start identity for safe later cleanup. */
function fixtureProcessIdentity(pid) {
  let output;
  try { output = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,pgid=,stat=,lstart='], { encoding: 'utf8' }).trim(); }
  catch (error) { if (error.status === 1) return null; throw error; }
  const match = output.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u);
  if (!match) return null;
  return { pid: Number(match[1]), pgid: Number(match[2]), state: match[3], started: match[4] };
}

/** Signal a fixture only while its captured PID, process group, and start identity still match. */
function signalFixtureProcess(identity, signal) {
  try {
    const current = fixtureProcessIdentity(identity.pid);
    if (!current) return;
    if (current.pid === identity.pid && current.pgid === identity.pgid && current.started === identity.started && !current.state.startsWith('Z')) {
      process.kill(identity.pid, signal);
    }
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

/** Treat disappearance, a zombie, or a changed process identity as drained. */
async function waitForFixtureIdentityDrain(identity, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const current = fixtureProcessIdentity(identity.pid);
      if (!current) return true;
      if (current.pgid !== identity.pgid || current.started !== identity.started || current.state.startsWith('Z')) return true;
    } catch (error) { if (error.code === 'ESRCH' || error.status === 1) return true; throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

/** Wait for a fixture's causal file handshake, with a ceiling used only to expose a hung child. */
async function waitForFixtureMarker(path, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(existsSync(path), `${label} before the fixture hang ceiling`);
}

/** Read only a bounded journal tail and discard partial rows at either edge. */
function readFixtureJournalTail(path, maxBytes = 65536) {
  const descriptor = openSync(path, 'r');
  try {
    const size = fstatSync(descriptor).size;
    const start = Math.max(0, size - maxBytes);
    const bytes = Buffer.alloc(size - start);
    readSync(descriptor, bytes, 0, bytes.length, start);
    let text = bytes.toString('utf8');
    if (start > 0) {
      const firstBreak = text.indexOf('\n');
      text = firstBreak < 0 ? '' : text.slice(firstBreak + 1);
    }
    if (!text.endsWith('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1);
    return text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  } finally { closeSync(descriptor); }
}

/** Build a private runner checkout whose tests record the files Node actually selects. */
function makeShardFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-test-shards-')));
  const bin = join(root, 'bin');
  const source = join(root, 'src');
  const tests = join(root, 'test');
  mkdirSync(bin);
  mkdirSync(tests);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), root);
  const capture = join(root, 'selected-files.txt');
  const expected = [];
  for (let number = 1; number <= shardFileCount; number += 1) {
    const name = `shard-${String(number).padStart(2, '0')}.test.js`;
    expected.push(name);
    writeFileSync(join(tests, name), `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
/** Record the actual file Node assigned to this shard. */
function recordSelectedFile() { appendFileSync(process.env.PULLBOARD_SHARD_CAPTURE, '${name}\\n'); }
test('record ${name} [C7]', recordSelectedFile);
`);
  }
  stageFixtureTests(root, expected.map(name => `test/${name}`));
  /** Remove the private runner tree after its child processes exit. */
  function cleanupFixture() {
    rmSync(root, { recursive: true, force: true });
  }
  t.after(cleanupFixture);
  return { root, capture, expected, runner: join(root, 'packages/gate/src/io/run/tests.js') };
}

/** Build a fixture with one held sibling, one failure, and queued sentinels beyond worker capacity. */
function makeLandingStopFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-landing-stop-')));
  const bin = join(root, 'bin');
  const tests = join(root, 'test');
  mkdirSync(bin);
  mkdirSync(tests);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), root);
  writeFileSync(join(tests, '01-sibling.test.js'), `import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
test('long sibling begins and remains active', async (t) => {
  const child = spawn(process.execPath, ['-e', "const fs=require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(process.env.PULLBOARD_C7_CHILD_DRAINED, 'drained'); setTimeout(() => process.exit(0), 10); }); fs.writeFileSync(process.env.PULLBOARD_C7_CHILD_READY, 'ready'); setInterval(() => {}, 1000);"], { detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(process.env.PULLBOARD_C7_CHILD_PID, String(child.pid));
  t.after(() => { try { process.kill(child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  const childDeadline = Date.now() + 10000;
  while (!existsSync(process.env.PULLBOARD_C7_CHILD_READY) && Date.now() < childDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (!existsSync(process.env.PULLBOARD_C7_CHILD_READY)) throw new Error('detached child never became ready');
  writeFileSync(process.env.PULLBOARD_C7_SIBLING_STARTED, 'started');
  const releaseDeadline = Date.now() + 10000;
  while (!existsSync(process.env.PULLBOARD_C7_RELEASE) && Date.now() < releaseDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (!existsSync(process.env.PULLBOARD_C7_RELEASE)) throw new Error('queued sentinel did not release the sibling');
  writeFileSync(process.env.PULLBOARD_C7_SIBLING_FINISHED, 'finished');
});
`);
  const lateChildCode = `const fs=require('node:fs'); process.on('SIGTERM',()=>{fs.writeFileSync(process.env.PULLBOARD_C7_LATE_CHILD_DRAINED,'drained')}); fs.writeFileSync(process.env.PULLBOARD_C7_LATE_CHILD_READY,'ready'); setInterval(()=>{if(fs.existsSync(process.env.PULLBOARD_C7_LATE_CHILD_RELEASE))process.exit(0)},10);`;
  const failingChildCode = `const fs=require('node:fs'); const {spawn}=require('node:child_process'); let lateSpawned=false; process.on('SIGTERM', () => { fs.writeFileSync(process.env.PULLBOARD_C7_FAIL_CHILD_DRAINED, 'drained'); if (process.env.PULLBOARD_C7_SPAWN_LATE_CHILD_ON_TERM === '1') { if (lateSpawned) return; lateSpawned=true; const late = spawn(process.execPath, ['-e', ${JSON.stringify(lateChildCode)}], {detached:true,stdio:'ignore'}); late.unref(); fs.writeFileSync(process.env.PULLBOARD_C7_LATE_CHILD_PID, String(late.pid)); const wait=setInterval(()=>{if(fs.existsSync(process.env.PULLBOARD_C7_LATE_CHILD_READY)&&fs.existsSync(process.env.PULLBOARD_C7_FAIL_CHILD_RELEASE)){clearInterval(wait);process.exit(0)}},10); return; } if (process.env.PULLBOARD_C7_HOLD_FAIL_CHILD === '1') { const wait=setInterval(() => { if (fs.existsSync(process.env.PULLBOARD_C7_FAIL_CHILD_RELEASE)) { clearInterval(wait); process.exit(0); } }, 10); } else setTimeout(() => process.exit(0), 10); }); fs.writeFileSync(process.env.PULLBOARD_C7_FAIL_CHILD_READY, 'ready'); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 15000);`;
  writeFileSync(join(tests, '02-failing.test.js'), `import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
test('later file fails after sibling starts', async () => {
  writeFileSync(process.env.PULLBOARD_C7_WORKER_MARKER, process.env.PULLBOARD_LANDING_RUN ?? '<unset>');
  const deadline = Date.now() + 10000;
  while (!existsSync(process.env.PULLBOARD_C7_SIBLING_STARTED) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (!existsSync(process.env.PULLBOARD_C7_SIBLING_STARTED)) throw new Error('sibling never started');
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(failingChildCode)}], { detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(process.env.PULLBOARD_C7_FAIL_CHILD_PID, String(child.pid));
  const childDeadline = Date.now() + 10000;
  while (!existsSync(process.env.PULLBOARD_C7_FAIL_CHILD_READY) && Date.now() < childDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (!existsSync(process.env.PULLBOARD_C7_FAIL_CHILD_READY)) throw new Error('failing worker detached child never became ready');
  writeFileSync(process.env.PULLBOARD_C7_FAILURE, 'failed');
  assert.fail('intentional landing stop [C7]');
});
`);
  const queuedFiles = [];
  for (let number = 3; number <= 8; number += 1) {
    const name = `${String(number).padStart(2, '0')}-queued.test.js`;
    queuedFiles.push(`test/${name}`);
    writeFileSync(join(tests, name), `import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
test('queued sentinel ${number} releases ordinary sibling', () => {
  writeFileSync(process.env.PULLBOARD_C7_QUEUED, '${number}');
  writeFileSync(process.env.PULLBOARD_C7_RELEASE, 'released');
});
`);
  }
  // Without a commit, native discovery would also run every copied gate source file under a test/ folder.
  stageFixtureTests(root, ['test/01-sibling.test.js', 'test/02-failing.test.js', ...queuedFiles]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root, runner: join(root, 'packages/gate/src/io/run/tests.js'),
    siblingStarted: join(root, 'sibling-started'), siblingFinished: join(root, 'sibling-finished'),
    failure: join(root, 'failure'), queued: join(root, 'queued'), queuedFiles, workerMarker: join(root, 'worker-marker'),
    release: join(root, 'release'),
    childReady: join(root, 'child-ready'), childPid: join(root, 'child-pid'), childDrained: join(root, 'child-drained'),
    failChildReady: join(root, 'fail-child-ready'), failChildPid: join(root, 'fail-child-pid'), failChildDrained: join(root, 'fail-child-drained'),
    failChildRelease: join(root, 'fail-child-release'),
    lateChildReady: join(root, 'late-child-ready'), lateChildPid: join(root, 'late-child-pid'),
    lateChildDrained: join(root, 'late-child-drained'), lateChildRelease: join(root, 'late-child-release'),
  };
}

/** Emulate a reused worker PID in ps output without changing any real process identity. */
function installLandingPidReusePsShim(fixture, unrelatedPid) {
  const bin = join(fixture.root, 'pid-reuse-bin');
  mkdirSync(bin);
  const realPs = execFileSync('which', ['ps'], { encoding: 'utf8' }).trim();
  const source = `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const realPs = ${JSON.stringify(realPs)};
const args = process.argv.slice(2);
const target = '-axo pid=,ppid=,pgid=,stat=,lstart=,command=';
const output = execFileSync(realPs, args, { encoding: 'utf8' });
if (args.join(' ') !== target) { process.stdout.write(output); process.exit(0); }
function parse(line) {
  const match = line.match(/^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(.+)$/u);
  if (!match) return null;
  const fields = match[5].trim().split(/\\s+/u);
  return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), state: match[4],
    started: fields.slice(0, 5).join(' '), command: fields.slice(5).join(' ') };
}
function format(row) { return [row.pid, row.ppid, row.pgid, row.state, row.started, row.command].join(' '); }
let rows = output.split(/\\r?\\n/u).map(parse).filter(Boolean);
const starts = process.env.PULLBOARD_LANDING_WORKER_STARTS;
const outsiderPid = ${Number(unrelatedPid)};
if (starts) {
  let receipts = [];
  try { receipts = readFileSync(starts, 'utf8').split(/\\r?\\n/u).filter(Boolean).map(line => JSON.parse(line)); } catch {}
  for (const receipt of receipts) {
    if (receipt.type !== 'worker' || receipt.attempt !== process.env.PULLBOARD_LANDING_ATTEMPT) continue;
    const live = rows.find(row => row.pid === receipt.pid);
    const same = live && receipt.pgid !== undefined && live.pgid === receipt.pgid && live.started === receipt.started;
    if (same) continue;
    rows = rows.filter(row => row.pid !== receipt.pid);
    rows.push({ pid: receipt.pid, ppid: 1, pgid: receipt.pid, state: 'S',
      started: 'Tue Oct 13 07:00:00 2026', command: 'fixture-reused-worker-pid' });
    const outsider = rows.find(row => row.pid === outsiderPid);
    if (outsider) outsider.ppid = receipt.pid;
    const injected = process.env.PULLBOARD_C7_PID_REUSE_INJECTED;
    if (injected && !existsSync(injected)) writeFileSync(injected, 'injected');
  }
}
process.stdout.write(rows.map(format).join('\\n') + '\\n');
`;
  const path = join(bin, 'ps');
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return bin;
}

/** Fail one owned SIGTERM in the gate runner, then let later retries reach the real child. */
function installLandingSignalFailureShim(fixture) {
  const path = join(fixture.root, 'fail-one-owned-signal.mjs');
  writeFileSync(path, `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
if (process.argv[1] === process.env.PULLBOARD_C7_RUNNER_PATH) {
  const original = process.kill.bind(process);
  let failed = false;
  process.kill = (pid, signal) => {
    const pidFile = process.env.PULLBOARD_C7_FAIL_CHILD_PID;
    if (!failed && signal === 'SIGTERM' && pidFile && existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8').trim()) === Number(pid)) {
      failed = true;
      writeFileSync(process.env.PULLBOARD_C7_SIGNAL_FAILURE, 'injected');
      const gone = process.env.PULLBOARD_C7_SIGNAL_GONE;
      // #850: the child is really gone (killed and reaped) before the kill answers, as under load.
      if (gone) for (const end = Date.now() + 3000; Date.now() < end && (() => { try { return original(pid, 'SIGKILL') ?? true; } catch { return false; } })();) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      const error = new Error('injected one-shot signal failure');
      error.code = gone || 'EPERM';
      throw error;
    }
    return original(pid, signal);
  };
}
`);
  return path;
}

test('a green landing run retries transient process snapshot timeouts [C7,V4]', async t => {
  const fixture = makeShardFixture(t);
  const ready = join(fixture.root, 'snapshot-ready');
  const sampled = join(fixture.root, 'sample-timeout');
  const drained = join(fixture.root, 'drain-timeout');
  const childReady = join(fixture.root, 'child-ready');
  const childDrained = join(fixture.root, 'child-drained');
  const childIdentity = join(fixture.root, 'child-identity.json');
  t.after(() => {
    if (existsSync(childIdentity)) signalFixtureProcess(JSON.parse(readFileSync(childIdentity, 'utf8')), 'SIGKILL');
  });
  const preload = join(fixture.root, 'snapshot-timeout.mjs');
  writeFileSync(preload, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
if (process.argv[1] === ${JSON.stringify(fixture.runner)}) {
  const original = childProcess.execFileSync;
  childProcess.execFileSync = (command, args, options) => {
    if (command === 'ps' && args?.[0] === '-axo' && existsSync(${JSON.stringify(ready)})) {
      const duringDrain = new Error().stack.includes('at snapshot ');
      const marker = duringDrain ? ${JSON.stringify(drained)} : ${JSON.stringify(sampled)};
      if (!existsSync(marker)) {
        writeFileSync(marker, 'injected');
        const error = new Error('injected process snapshot timeout');
        error.code = 'ETIMEDOUT';
        throw error;
      }
    }
    return original(command, args, options);
  };
  syncBuiltinESMExports();
}
`);
  const childCode = `const {writeFileSync}=require('node:fs'); const {execFileSync}=require('node:child_process');
const fields=execFileSync('ps',['-p',String(process.pid),'-o','pid=,pgid=,stat=,lstart='],{encoding:'utf8'}).trim().split(/\\s+/);
writeFileSync(${JSON.stringify(childIdentity)},JSON.stringify({pid:Number(fields[0]),pgid:Number(fields[1]),state:fields[2],started:fields.slice(3).join(' ')}));
process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(childDrained)},'drained');process.exit(0)});
writeFileSync(${JSON.stringify(childReady)},'ready');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),20000);`;
  writeFileSync(join(fixture.root, 'test/shard-01.test.js'), `import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
test('green file waits for the injected observation', async () => {
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { detached: true, stdio: 'ignore' });
  child.unref();
  const childDeadline = Date.now() + 10000;
  while (!existsSync(${JSON.stringify(childReady)}) && Date.now() < childDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(existsSync(${JSON.stringify(childReady)}), 'owned detached child is ready');
  writeFileSync(${JSON.stringify(ready)}, 'ready');
  const deadline = Date.now() + 10000;
  while (!existsSync(${JSON.stringify(sampled)}) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(existsSync(${JSON.stringify(sampled)}), 'the monitor snapshot timeout was injected');
  assert.equal(existsSync(${JSON.stringify(childDrained)}), false, 'a failed snapshot authorizes no signal while the test is active');
});
`);
  const env = { ...process.env, PULLBOARD_LANDING_RUN: '1',
    PULLBOARD_MACHINE_HOME: join(fixture.root, 'machine'),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(preload).href].filter(Boolean).join(' ') };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  const result = runFixtureChild(process.execPath, [fixture.runner, 'test/shard-01.test.js'], {
    cwd: fixture.root, env, encoding: 'utf8', timeout: 15000,
  });
  assert.ok(existsSync(sampled), 'a live monitor observation failed once');
  assert.ok(existsSync(drained), 'the final ownership census failed once and was retried');
  assert.equal(result.status, 0, `${result.context}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.match(result.stdout, /# fail 0/u);
  assert.ok(existsSync(childDrained), 'the owned child acknowledged cleanup after a successful census');
  assert.ok(await waitForFixtureIdentityDrain(JSON.parse(readFileSync(childIdentity, 'utf8'))), 'the owned detached child stopped before the gate returned');
});

test('a landing worker retries its startup identity snapshot timeout [C7,V4]', t => {
  const fixture = makeShardFixture(t);
  const injected = join(fixture.root, 'worker-snapshot-timeout');
  const ran = join(fixture.root, 'worker-test-ran');
  const workerTest = join(fixture.root, 'test/worker-start.test.js');
  writeFileSync(workerTest, `import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
test('the test body runs after the worker identity retry', () => {
  const marker = JSON.parse(readFileSync(${JSON.stringify(injected)}, 'utf8'));
  const receipts = readFileSync(process.env.PULLBOARD_LANDING_WORKER_STARTS, 'utf8').trim().split(/\\r?\\n/u).map(line => JSON.parse(line));
  const receipt = receipts.find(row => row.type === 'worker' && row.pid === process.pid);
  assert.equal(marker.pid, process.pid, 'the timeout was injected into this test worker');
  assert.match(marker.stack, /landingWorkerIdentity/u, 'the timeout came from worker startup, not parent monitoring');
  assert.ok(receipt && receipt.file.endsWith('worker-start.test.js') && receipt.pgid && receipt.started, 'the worker recorded a fresh successful identity receipt before test execution');
  writeFileSync(${JSON.stringify(ran)}, 'ran');
});
`);
  const preload = join(fixture.root, 'worker-snapshot-timeout.mjs');
  writeFileSync(preload, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
if (process.argv[1] !== ${JSON.stringify(fixture.runner)}) {
  const originalSync = childProcess.execFileSync;
  const originalExec = childProcess.execFile;
  let injected = false;
  function shouldTimeout(command, args) {
    if (injected || command !== 'ps' || args?.[0] !== '-p' || args?.[1] !== String(process.pid)) return false;
    injected = true;
    writeFileSync(${JSON.stringify(injected)}, JSON.stringify({ pid: process.pid, stack: new Error().stack }));
    return true;
  }
  childProcess.execFileSync = (command, args, options) => {
    if (shouldTimeout(command, args)) { const error = new Error('injected worker process snapshot timeout'); error.code = 'ETIMEDOUT'; throw error; }
    return originalSync(command, args, options);
  };
  childProcess.execFile = (command, args, options, callback) => {
    if (shouldTimeout(command, args)) {
      const error = new Error('injected worker process snapshot timeout'); error.code = 'ETIMEDOUT';
      setImmediate(() => callback(error, '', ''));
      return undefined;
    }
    return originalExec(command, args, options, callback);
  };
  syncBuiltinESMExports();
}
`);
  const env = { ...process.env, PULLBOARD_LANDING_RUN: '1',
    PULLBOARD_MACHINE_HOME: join(fixture.root, 'machine'),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(preload).href].filter(Boolean).join(' ') };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  const result = runFixtureChild(process.execPath, [fixture.runner, 'test/worker-start.test.js'], {
    cwd: fixture.root, env, encoding: 'utf8', timeout: 25_000,
  });
  assert.ok(existsSync(injected), 'the first worker identity snapshot timed out');
  assert.equal(result.status, 0, `${result.context}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.ok(existsSync(ran), 'the test file executed after the retry succeeded');
  assert.match(`${result.stdout ?? ''}${result.stderr ?? ''}`, /worker identity snapshot timed out; retrying before file execution/u);
  assert.match(result.stdout, /# fail 0/u);
});

test('a landing worker runs after persistent identity snapshot errors [C7,V4]', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-worker-identity-')));
  const bin = join(root, 'bin');
  const tests = join(root, 'test');
  mkdirSync(bin);
  mkdirSync(tests);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), root);
  const fixtureRunner = join(root, 'packages/gate/src/io/run/tests.js');
  const workerTest = join(tests, 'worker-start.test.js');
  const preload = join(root, 'worker-snapshot-unavailable.mjs');
  const injected = join(root, 'worker-snapshot-unavailable');
  const ran = join(root, 'worker-ran.json');
  const release = join(root, 'release-worker');
  const childReady = join(root, 'owned-child-ready');
  const childTermStarted = join(root, 'owned-child-term-started');
  const childDrained = join(root, 'owned-child-drained');
  let runnerChild;
  let runnerClosed;
  let childIdentity = null;
  t.after(async () => {
    if (!existsSync(release)) writeFileSync(release, 'release');
    if (runnerChild && runnerChild.exitCode === null && runnerChild.signalCode === null) {
      const result = await Promise.race([runnerClosed,
        new Promise(resolve => setTimeout(() => resolve(null), 25000))]);
      if (!result) {
        runnerChild.kill('SIGKILL');
        await runnerClosed;
      }
    }
    if (childIdentity) {
      signalFixtureProcess(childIdentity, 'SIGTERM');
      await waitForFixtureIdentityDrain(childIdentity);
    }
    rmSync(root, { recursive: true, force: true });
  });

  writeFileSync(workerTest, `import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
test('the body runs and its detached child remains owned', async () => {
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(`const fs=require('node:fs'); process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(childTermStarted)},'term'); const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(wait);fs.writeFileSync(${JSON.stringify(childDrained)},'drained');process.exit(0)}},10)}); fs.writeFileSync(${JSON.stringify(childReady)},'ready'); setInterval(()=>{},1000);`)}], { detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(${JSON.stringify(ran)}, JSON.stringify({ pid: process.pid, childPid: child.pid,
    startsPath: process.env.PULLBOARD_LANDING_WORKER_STARTS, attempt: process.env.PULLBOARD_LANDING_ATTEMPT }));
});
`);
  writeFileSync(preload, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
if (process.argv[1]?.endsWith('/worker-start.test.js')) {
  const originalSync = childProcess.execFileSync;
  const originalExec = childProcess.execFile;
  let injections = 0;
  function failWorkerSnapshot(command, args) {
    if (command !== 'ps' || args?.[0] !== '-p' || args?.[1] !== String(process.pid)) return false;
    injections += 1;
    writeFileSync(${JSON.stringify(injected)}, JSON.stringify({ pid: process.pid, args, injections }));
    return true;
  }
  childProcess.execFileSync = (command, args, options) => {
    if (failWorkerSnapshot(command, args)) { const error = new Error('injected persistent worker ps timeout'); error.code = 'ETIMEDOUT'; throw error; }
    return originalSync(command, args, options);
  };
  childProcess.execFile = (command, args, options, callback) => {
    if (failWorkerSnapshot(command, args)) {
      const error = new Error('injected persistent worker ps timeout'); error.code = 'ETIMEDOUT';
      setImmediate(() => callback(error, '', ''));
      return undefined;
    }
    return originalExec(command, args, options, callback);
  };
  syncBuiltinESMExports();
}
`);

  stageFixtureTests(root, ['test/worker-start.test.js']);
  const env = { ...process.env, PULLBOARD_LANDING_RUN: '1',
    PULLBOARD_MACHINE_HOME: join(root, 'machine'),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(preload).href].filter(Boolean).join(' ') };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  runnerChild = startFixtureChild(process.execPath, [fixtureRunner, 'test/worker-start.test.js'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  runnerChild.stdout?.setEncoding('utf8').on('data', part => { output += part; });
  runnerChild.stderr?.setEncoding('utf8').on('data', part => { output += part; });
  runnerClosed = new Promise(resolve => runnerChild.once('close', (code, signal) => resolve({ code, signal })));

  const bodyStarted = await Promise.race([
    waitForFixtureMarker(ran, 'the worker test body ran after its local identity census failed', 25000).then(() => true),
    runnerClosed.then(() => false),
  ]);
  assert.ok(bodyStarted, `the runner exited before evaluating the worker test body\n${output}`);
  const worker = JSON.parse(readFileSync(ran, 'utf8'));
  await waitForFixtureMarker(childReady, 'the detached child started', 5000); // budget: hang ceiling for the child-ready handshake; the marker proves readiness.
  childIdentity = fixtureProcessIdentity(worker.childPid);
  assert.ok(childIdentity, 'the detached child has a capturable identity before release');
  assert.ok(existsSync(injected), 'the preload injected persistent ps timeouts only in the worker');

  const deadline = Date.now() + 5000; // Hang ceiling only; readiness is the per-child acknowledgement below.
  let receipts = [];
  let childReceipt = null;
  let childAcknowledgement = null;
  while (Date.now() < deadline) {
    if (existsSync(worker.startsPath)) {
      receipts = readFixtureJournalTail(worker.startsPath);
      const prefix = `${basename(worker.startsPath)}.child.${worker.attempt}.${worker.pid}.`;
      const path = readdirSync(dirname(worker.startsPath)).filter(name => name.startsWith(prefix) && name.endsWith('.json'))
        .map(name => join(dirname(worker.startsPath), name)).find(name => {
          try { return JSON.parse(readFileSync(name, 'utf8')).pid === worker.childPid; } catch { return false; }
        });
      if (path && existsSync(`${path}.acked`)) {
        childReceipt = JSON.parse(readFileSync(path, 'utf8'));
        childAcknowledgement = JSON.parse(readFileSync(`${path}.acked`, 'utf8'));
        break;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const pending = receipts.find(row => row.type === 'worker-pending' && row.pid === worker.pid);
  const bound = receipts.find(row => row.type === 'worker-bound' && row.pid === worker.pid);
  const unavailable = receipts.find(row => row.type === 'worker-identity-unavailable' && row.pid === worker.pid);
  assert.ok(pending && pending.attempt === worker.attempt && pending.file.endsWith('/test/worker-start.test.js'),
    'the worker announced its selected file before retrying its local census');
  assert.ok(bound && bound.parentPid === pending.parentPid && bound.pgid && bound.started,
    'the parent bound the live direct worker using its own fresh identity census');
  assert.ok(childReceipt && childReceipt.parentPid === worker.pid && childReceipt.spawnFile,
    'the worker published a spawn announcement while its test body was still active');
  assert.equal(childAcknowledgement?.status, 'bound', 'the parent confirmed custody before the worker could exit');
  assert.ok(childAcknowledgement?.identity?.pid === worker.childPid && childAcknowledgement.identity.pgid
    && childAcknowledgement.identity.started, 'the parent acknowledged its fresh child identity');
  assert.ok(unavailable && unavailable.code === 'ETIMEDOUT', 'the worker recorded its exhausted local snapshot retries');
  assert.ok(JSON.parse(readFileSync(injected, 'utf8')).injections > 1, 'the worker-local ps failure persisted across retries');

  await waitForFixtureMarker(childTermStarted, 'the child received cleanup only after its identity was bound', 10000); // budget: hang ceiling for the owned-child TERM handshake; the marker proves delivery.
  writeFileSync(release, 'release');
  const result = await runnerClosed;
  assert.deepEqual(result, { code: 0, signal: null }, output);
  assert.equal((output.match(/run-tests: worker identity unavailable \(/gu) ?? []).length, 1,
    `the worker emitted one identity-unavailable diagnostic\n${output}`);
  assert.match(output, /# fail 0/u);
  assert.ok(existsSync(childDrained), 'parent-owned cleanup drained the detached child before the gate returned');
  assert.ok(await waitForFixtureIdentityDrain(childIdentity), 'the owned child stopped before the fixture returned');
});

test('a later spawn-time ps failure names unverified cleanup [C7,V4]', t => {
  const fixture = makeShardFixture(t);
  const workerTest = join(fixture.root, 'test/spawn-snapshot.test.js');
  const injected = join(fixture.root, 'spawn-snapshot-injected.json');
  const journal = join(fixture.root, 'spawn-snapshot-journal.json');
  const preload = join(fixture.root, 'spawn-snapshot-failure.mjs');
  writeFileSync(workerTest, `import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
test('a healthy worker completes after its spawn snapshot fails', async () => {
  const starts = process.env.PULLBOARD_LANDING_WORKER_STARTS;
  const before = readFileSync(starts, 'utf8').trim().split(/\\r?\\n/u).map(line => JSON.parse(line));
  assert.ok(before.some(row => row.type === 'worker' && row.pid === process.pid), 'startup identity succeeded before the injected failure');
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { detached: true, stdio: 'ignore' });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, 'the fixture child drains itself without runner cleanup');
  writeFileSync(${JSON.stringify(journal)}, JSON.stringify({ pid: process.pid, childPid: child.pid,
    rows: readFileSync(starts, 'utf8').trim().split(/\\r?\\n/u).map(line => JSON.parse(line)) }));
});
`);
  writeFileSync(preload, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
if (process.argv[1] === ${JSON.stringify(workerTest)}) {
  const original = childProcess.execFileSync;
  let injected = false;
  childProcess.execFileSync = (command, args, options) => {
    if (!injected && command === 'ps' && args?.[0] === '-axo') {
      injected = true;
      writeFileSync(${JSON.stringify(injected)}, JSON.stringify({ stack: new Error().stack }));
      const error = new Error('injected later spawn snapshot failure');
      error.code = 'EIO';
      throw error;
    }
    return original(command, args, options);
  };
  syncBuiltinESMExports();
}
`);
  const env = { ...process.env, PULLBOARD_LANDING_RUN: '1',
    PULLBOARD_MACHINE_HOME: join(fixture.root, 'machine'),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(preload).href].filter(Boolean).join(' ') };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  const result = runFixtureChild(process.execPath, [fixture.runner, 'test/spawn-snapshot.test.js'], {
    cwd: fixture.root, env, encoding: 'utf8', timeout: 25000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.status, 0, `${result.context}\n${output}`);
  assert.match(output, /# fail 0/u, 'cleanup uncertainty does not change the passing test outcome');
  assert.match(JSON.parse(readFileSync(injected, 'utf8')).stack, /landingProcessTable/u,
    'the injected failure came from the synchronous spawn census after healthy startup');
  const receipt = JSON.parse(readFileSync(journal, 'utf8'));
  const unavailable = receipt.rows.find(row => row.type === 'child-snapshot-unavailable'
    && row.parentPid === receipt.pid && row.pid === receipt.childPid && row.file === workerTest);
  assert.ok(unavailable, 'the worker publishes cleanup uncertainty before it can exit');
  assert.equal(unavailable.code, 'EIO');
  assert.equal(unavailable.reason, 'injected later spawn snapshot failure');
  assert.match(output, /cleanup for spawn-snapshot\.test\.js UNVERIFIED: EIO: injected later spawn snapshot failure; no unverified process was signaled/u,
    'the parent retains the worker failure and names the affected file and reason');
  assert.equal((output.match(/cleanup for .* UNVERIFIED/gu) ?? []).length, 1, 'cleanup uncertainty is reported once');
});

test('tests continue when worker and parent identity censuses stay unavailable [C7,V4]', async t => {
  const fixture = makeShardFixture(t);
  const workerTest = join(fixture.root, 'test/worker-unverified.test.js');
  const preload = join(fixture.root, 'persistent-census-failure.mjs');
  const workerInjected = join(fixture.root, 'worker-census-injected');
  const parentInjected = join(fixture.root, 'parent-census-injected');
  const bodyRan = join(fixture.root, 'body-ran');
  const childReady = join(fixture.root, 'unknown-child-ready');
  const childPid = join(fixture.root, 'unknown-child-pid');
  const childSignal = join(fixture.root, 'unknown-child-signaled');
  let childIdentity = null;
  t.after(async () => {
    if (!childIdentity && existsSync(childPid)) childIdentity = fixtureProcessIdentity(Number(readFileSync(childPid, 'utf8')));
    if (childIdentity) {
      signalFixtureProcess(childIdentity, 'SIGTERM');
      await waitForFixtureProcessDrain(childIdentity.pid);
    }
  });
  writeFileSync(workerTest, `import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
test('the selected body runs while cleanup identity is unknown', async () => {
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(`const fs=require('node:fs'); process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(childSignal)},'signaled');process.exit(0)}); fs.writeFileSync(${JSON.stringify(childReady)},'ready'); setInterval(()=>{},1000);`)}], { detached: true, stdio: 'ignore' });
  child.unref();
  const deadline = Date.now() + 5000;
  while (!existsSync(${JSON.stringify(childReady)}) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (!existsSync(${JSON.stringify(childReady)})) throw new Error('detached child did not start before the fixture ceiling');
  writeFileSync(${JSON.stringify(childPid)}, String(child.pid));
  writeFileSync(${JSON.stringify(bodyRan)}, 'ran');
});
`);
  writeFileSync(preload, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
const runner = ${JSON.stringify(fixture.runner)};
const workerTest = ${JSON.stringify(workerTest)};
if (process.argv[1] === runner) {
  const original = childProcess.execFileSync;
  childProcess.execFileSync = (command, args, options) => {
    if (command === 'ps' && args?.[0] === '-axo') {
      writeFileSync(${JSON.stringify(parentInjected)}, 'injected');
      const error = new Error('injected persistent parent census failure'); error.code = 'ETIMEDOUT'; throw error;
    }
    return original(command, args, options);
  };
  syncBuiltinESMExports();
} else if (process.argv[1] === workerTest) {
  const original = childProcess.execFile;
  childProcess.execFile = (command, args, options, callback) => {
    if (command === 'ps' && args?.[0] === '-p' && args?.[1] === String(process.pid)
      && args?.[3] === 'pid=,ppid=,pgid=,stat=,lstart=') {
      writeFileSync(${JSON.stringify(workerInjected)}, 'injected');
      const error = new Error('injected persistent worker census failure'); error.code = 'ETIMEDOUT';
      setImmediate(() => callback(error, '', ''));
      return undefined;
    }
    return original(command, args, options, callback);
  };
  syncBuiltinESMExports();
}
`);
  const env = { ...process.env, PULLBOARD_LANDING_RUN: '1',
    PULLBOARD_MACHINE_HOME: join(fixture.root, 'machine'),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(preload).href].filter(Boolean).join(' ') };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  const result = runFixtureChild(process.execPath, [fixture.runner, 'test/worker-unverified.test.js'], {
    cwd: fixture.root, env, encoding: 'utf8', timeout: 45000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.status, 0, `${result.context}\n${output}`);
  assert.ok(existsSync(bodyRan), 'the selected test body ran despite persistent worker and parent census errors');
  assert.ok(existsSync(workerInjected) && existsSync(parentInjected), 'both identity census failures were injected');
  assert.match(output, /# fail 0/u, 'the gate result reflects the passing tests');
  assert.match(output, /cleanup for [^\n]*worker-unverified\.test\.js[^\n]* UNVERIFIED: ETIMEDOUT: injected persistent parent census failure; no unverified process was signaled/u,
    'the runner names uncertain cleanup without treating missing identity as a test failure');
  assert.equal((output.match(/cleanup for .* UNVERIFIED/gu) ?? []).length, 1, 'one cleanup uncertainty diagnostic is emitted');
  childIdentity = fixtureProcessIdentity(Number(readFileSync(childPid, 'utf8')));
  assert.ok(childIdentity, 'the fixture child remains alive for explicit owner cleanup');
  assert.equal(existsSync(childSignal), false, 'the runner did not signal a child it could not identify');
  signalFixtureProcess(childIdentity, 'SIGTERM');
  await waitForFixtureMarker(childSignal, 'the fixture owner cleaned up its child after the run');
  assert.ok(await waitForFixtureProcessDrain(childIdentity.pid), 'the fixture child drained after explicit owner cleanup');
});

test('a failed test completion without a type still stops a landing run [C7,V4]', async t => {
  const fixture = makeLandingStopFixture(t);
  const preload = join(fixture.root, 'untyped-completion.mjs');
  const delivered = join(fixture.root, 'untyped-completion-delivered');
  writeFileSync(preload, `import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
// Prefix-only node:test exports are not updated by syncBuiltinESMExports.
// Intercept the real listener's event while preserving the reporter stream's original object.
if (process.argv[1] === ${JSON.stringify(fixture.runner)}) {
  const originalEmit = EventEmitter.prototype.emit;
  /** Deliver an untyped completion only for the intentional failure in this private fixture. */
  EventEmitter.prototype.emit = function(type, ...args) {
    const data = args[0];
    if (type === 'test:complete' && data?.file === ${JSON.stringify(join(fixture.root, 'test/02-failing.test.js'))}
      && data.details?.passed === false
      && (data.details.type === undefined || data.details.type === 'test')) {
      const details = { ...data.details };
      delete details.type;
      args[0] = { ...data, details };
      const result = originalEmit.call(this, type, ...args);
      writeFileSync(${JSON.stringify(delivered)}, 'delivered');
      return result;
    }
    // Keep failure reporting, but isolate this regression from the newer file-summary fallback.
    if (type === 'test:summary' && data?.file === ${JSON.stringify(join(fixture.root, 'test/02-failing.test.js'))}
      && data.success === false) {
      const summary = { ...data };
      delete summary.file;
      args[0] = summary;
    }
    return originalEmit.call(this, type, ...args);
  };
}
`);
  const env = {
    ...process.env,
    PULLBOARD_MACHINE_HOME: join(fixture.root, 'machine'),
    PULLBOARD_LANDING_RUN: '1',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(preload).href].filter(Boolean).join(' '),
    PULLBOARD_C7_SIBLING_STARTED: fixture.siblingStarted,
    PULLBOARD_C7_SIBLING_FINISHED: fixture.siblingFinished,
    PULLBOARD_C7_FAILURE: fixture.failure,
    PULLBOARD_C7_RELEASE: fixture.release,
    PULLBOARD_C7_QUEUED: fixture.queued,
    PULLBOARD_C7_WORKER_MARKER: fixture.workerMarker,
    PULLBOARD_C7_CHILD_READY: fixture.childReady,
    PULLBOARD_C7_CHILD_PID: fixture.childPid,
    PULLBOARD_C7_CHILD_DRAINED: fixture.childDrained,
    PULLBOARD_C7_FAIL_CHILD_READY: fixture.failChildReady,
    PULLBOARD_C7_FAIL_CHILD_PID: fixture.failChildPid,
    PULLBOARD_C7_FAIL_CHILD_DRAINED: fixture.failChildDrained,
  };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  const result = runFixtureChild(process.execPath, [fixture.runner, '--test-concurrency=2'], {
    cwd: fixture.root, env, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 1, `${result.context}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.ok(existsSync(delivered), 'the actual failing completion reached the runner without a type');
  assert.ok(existsSync(fixture.failure), 'the intentional failure completed');
  assert.ok(existsSync(fixture.siblingStarted), 'the sibling was active before the failure');
  assert.equal(existsSync(fixture.siblingFinished), false, 'the untyped completion interrupted the active sibling');
  assert.equal(existsSync(fixture.queued), false, 'no queued sentinel started after the untyped failure');
  assert.equal(existsSync(fixture.release), false, 'no queued sentinel released the active sibling');
  for (const [pid, drained] of [[fixture.childPid, fixture.childDrained], [fixture.failChildPid, fixture.failChildDrained]]) {
    assert.ok(existsSync(drained), 'the owned detached child acknowledged cleanup');
    assert.ok(await waitForFixtureProcessDrain(readFileSync(pid, 'utf8').trim()), 'the owned detached child exited before return');
  }
  assert.match(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, /Landing gate stopped early after .*02-failing\.test\.js/u);
});

test('a landing run stops at the first failing file [C7,V4]', async t => {
  const unrelatedRoot = mkdtempSync(join(tmpdir(), 'pullboard-landing-unrelated-'));
  const unrelatedReady = join(unrelatedRoot, 'ready');
  const unrelatedDrained = join(unrelatedRoot, 'drained');
  const unrelated = spawn(process.execPath, ['-e', `const fs=require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(unrelatedDrained)}, 'drained'); process.exit(0); }); fs.writeFileSync(${JSON.stringify(unrelatedReady)}, 'ready'); setInterval(() => {}, 1000);`], {
    detached: true, stdio: 'ignore',
  });
  t.after(() => {
    if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill('SIGKILL');
    rmSync(unrelatedRoot, { recursive: true, force: true });
  });
  const unrelatedDeadline = Date.now() + 2000;
  while (!existsSync(unrelatedReady) && Date.now() < unrelatedDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(existsSync(unrelatedReady), 'the unrelated process started before the landing run');
  const fixture = makeLandingStopFixture(t);
  const env = {
    ...process.env,
    PULLBOARD_MACHINE_HOME: join(fixture.root, 'machine'),
    PULLBOARD_LANDING_RUN: '1',
    PULLBOARD_C7_SIBLING_STARTED: fixture.siblingStarted,
    PULLBOARD_C7_SIBLING_FINISHED: fixture.siblingFinished,
    PULLBOARD_C7_FAILURE: fixture.failure,
    PULLBOARD_C7_RELEASE: fixture.release,
    PULLBOARD_C7_QUEUED: fixture.queued,
    PULLBOARD_C7_WORKER_MARKER: fixture.workerMarker,
    PULLBOARD_C7_CHILD_READY: fixture.childReady,
    PULLBOARD_C7_CHILD_PID: fixture.childPid,
    PULLBOARD_C7_CHILD_DRAINED: fixture.childDrained,
    PULLBOARD_C7_FAIL_CHILD_READY: fixture.failChildReady,
    PULLBOARD_C7_FAIL_CHILD_PID: fixture.failChildPid,
    PULLBOARD_C7_FAIL_CHILD_DRAINED: fixture.failChildDrained,
  };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  const stopped = runFixtureChild(process.execPath, [fixture.runner, '--test-concurrency=2'], {
    cwd: fixture.root, env, encoding: 'utf8', timeout: 15000,
  });
  const stoppedOutput = `${stopped.stdout ?? ''}\n${stopped.stderr ?? ''}`;
  assert.equal(stopped.status, 1, `${stopped.context}\n${stoppedOutput}`);
  assert.ok(existsSync(fixture.failure), 'the intentional failing test ran');
  assert.ok(existsSync(fixture.siblingStarted), 'the earlier sibling was active when failure completed');
  assert.ok(existsSync(fixture.childReady), 'the active sibling launched its detached child');
  assert.equal(existsSync(fixture.siblingFinished), false, 'the active sibling was interrupted');
  assert.equal(existsSync(fixture.queued), false, 'the queued sentinel never started');
  assert.equal(existsSync(fixture.release), false, 'no queued sentinel released the active sibling');
  assert.ok(existsSync(fixture.childDrained), 'the detached child handled the runner cleanup signal');
  assert.ok(await waitForFixtureProcessDrain(readFileSync(fixture.childPid, 'utf8').trim()), 'the detached child exited before the gate returned');
  assert.ok(existsSync(fixture.failChildReady), 'the failing worker launched its own detached child');
  assert.ok(existsSync(fixture.failChildDrained), 'the runner captured and drained the failing worker child before it was reparented');
  assert.ok(await waitForFixtureProcessDrain(readFileSync(fixture.failChildPid, 'utf8').trim()), 'the failing worker child exited before the gate returned');
  assert.ok(await waitForFixtureProcessRunning(unrelated.pid), 'an unrelated detached process remains alive');
  assert.equal(existsSync(unrelatedDrained), false, 'the unrelated process received no cleanup signal');
  unrelated.kill('SIGTERM');
  assert.ok(await waitForFixtureProcessDrain(unrelated.pid), 'the regression cleaned up its unrelated process');
  assert.ok(existsSync(unrelatedDrained), 'the unrelated process acknowledged test cleanup');
  assert.match(stoppedOutput, /Landing gate stopped early after .*02-failing\.test\.js/u);
  assert.match(stoppedOutput, /Triggering test error:[\s\S]*intentional landing stop \[C7\]/u);
  assert.match(stoppedOutput, /Files not run: .*0[3-8]-queued\.test\.js/u);
  assert.equal(readFileSync(fixture.workerMarker, 'utf8'), '0', 'test workers do not inherit the landing mode');

  const inProcess = makeLandingStopFixture(t);
  const inProcessEnv = {
    ...env,
    PULLBOARD_MACHINE_HOME: join(inProcess.root, 'machine'),
    PULLBOARD_C7_SIBLING_STARTED: inProcess.siblingStarted,
    PULLBOARD_C7_SIBLING_FINISHED: inProcess.siblingFinished,
    PULLBOARD_C7_FAILURE: inProcess.failure,
    PULLBOARD_C7_RELEASE: inProcess.release,
    PULLBOARD_C7_QUEUED: inProcess.queued,
    PULLBOARD_C7_WORKER_MARKER: inProcess.workerMarker,
    PULLBOARD_C7_CHILD_READY: inProcess.childReady,
    PULLBOARD_C7_CHILD_PID: inProcess.childPid,
    PULLBOARD_C7_CHILD_DRAINED: inProcess.childDrained,
    PULLBOARD_C7_FAIL_CHILD_READY: inProcess.failChildReady,
    PULLBOARD_C7_FAIL_CHILD_PID: inProcess.failChildPid,
    PULLBOARD_C7_FAIL_CHILD_DRAINED: inProcess.failChildDrained,
  };
  const inProcessStopped = runFixtureChild(process.execPath,
    [inProcess.runner, '--test-isolation=none', '--test-concurrency=2'], {
      cwd: inProcess.root, env: inProcessEnv, encoding: 'utf8', timeout: 15000,
    });
  const inProcessOutput = `${inProcessStopped.stdout ?? ''}\n${inProcessStopped.stderr ?? ''}`;
  assert.equal(inProcessStopped.status, 1, `${inProcessStopped.context}\n${inProcessOutput}`);
  assert.match(inProcessOutput, /landing gate early-stop requires --test-isolation=process/u);
  assert.equal(existsSync(inProcess.siblingStarted), false, 'no-isolation landing was refused before any file started');
  assert.equal(existsSync(inProcess.queued), false, 'no-isolation landing did not start queued sentinels');

  const ordinary = makeLandingStopFixture(t);
  const ordinaryEnv = {
    ...env,
    PULLBOARD_MACHINE_HOME: join(ordinary.root, 'machine'),
    PULLBOARD_LANDING_RUN: '0',
    PULLBOARD_C7_SIBLING_STARTED: ordinary.siblingStarted,
    PULLBOARD_C7_SIBLING_FINISHED: ordinary.siblingFinished,
    PULLBOARD_C7_FAILURE: ordinary.failure,
    PULLBOARD_C7_RELEASE: ordinary.release,
    PULLBOARD_C7_QUEUED: ordinary.queued,
    PULLBOARD_C7_WORKER_MARKER: ordinary.workerMarker,
    PULLBOARD_C7_CHILD_READY: ordinary.childReady,
    PULLBOARD_C7_CHILD_PID: ordinary.childPid,
    PULLBOARD_C7_CHILD_DRAINED: ordinary.childDrained,
    PULLBOARD_C7_FAIL_CHILD_READY: ordinary.failChildReady,
    PULLBOARD_C7_FAIL_CHILD_PID: ordinary.failChildPid,
    PULLBOARD_C7_FAIL_CHILD_DRAINED: ordinary.failChildDrained,
  };
  const normal = runFixtureChild(process.execPath, [ordinary.runner, '--test-concurrency=2',
    'test/01-sibling.test.js', 'test/02-failing.test.js', ...ordinary.queuedFiles], {
    cwd: ordinary.root, env: ordinaryEnv, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(normal.status, 1, normal.context);
  assert.ok(existsSync(ordinary.siblingFinished), `ordinary runs wait for active sibling files\n${normal.context}\nstdout: ${normal.stdout ?? ''}`);
  assert.ok(existsSync(ordinary.queued), 'ordinary runs continue scheduling queued files');
  assert.ok(existsSync(ordinary.childDrained), 'ordinary test cleanup also drains its detached child');
  assert.ok(await waitForFixtureProcessDrain(readFileSync(ordinary.childPid, 'utf8').trim()), 'ordinary test cleanup waited for its child to stop');
  assert.ok(existsSync(ordinary.failChildReady), 'the failing worker launched its detached child during an ordinary run');
  try { process.kill(Number(readFileSync(ordinary.failChildPid, 'utf8').trim()), 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  assert.ok(await waitForFixtureProcessDrain(readFileSync(ordinary.failChildPid, 'utf8').trim()), 'ordinary fixture child was drained');
  assert.ok(existsSync(ordinary.failChildDrained), 'the regression cleaned up the ordinary failing-worker child');
  assert.doesNotMatch(`${normal.stdout ?? ''}\n${normal.stderr ?? ''}`, /stopped early/u);

  await t.test('a reused worker PID cannot adopt an unrelated process subtree', async t => {
    const outsiderRoot = mkdtempSync(join(tmpdir(), 'pullboard-landing-pid-reuse-'));
    const outsiderReady = join(outsiderRoot, 'ready');
    const outsiderDrained = join(outsiderRoot, 'drained');
    const outsider = spawn(process.execPath, ['-e', `const fs=require('node:fs'); process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(outsiderDrained)},'drained');process.exit(0)});fs.writeFileSync(${JSON.stringify(outsiderReady)},'ready');setInterval(()=>{},1000);`], {
      detached: true, stdio: 'ignore',
    });
    await waitForFixtureMarker(outsiderReady, 'the unrelated process started');
    const outsiderIdentity = fixtureProcessIdentity(outsider.pid);
    assert.ok(outsiderIdentity, 'the unrelated process has a capturable cleanup identity');
    const cleanupOutsider = async () => {
      signalFixtureProcess(outsiderIdentity, 'SIGTERM');
      await waitForFixtureIdentityDrain(outsiderIdentity);
      rmSync(outsiderRoot, { recursive: true, force: true });
    };
    t.after(cleanupOutsider);

    const reused = makeLandingStopFixture(t);
    const psShim = installLandingPidReusePsShim(reused, outsider.pid);
    const injected = join(reused.root, 'pid-reuse-injected');
    const env = {
      ...process.env,
      PATH: [psShim, process.env.PATH].filter(Boolean).join(delimiter),
      PULLBOARD_MACHINE_HOME: join(reused.root, 'machine'),
      PULLBOARD_LANDING_RUN: '1',
      PULLBOARD_C7_UNRELATED_PID: String(outsider.pid),
      PULLBOARD_C7_PID_REUSE_INJECTED: injected,
      PULLBOARD_C7_SIBLING_STARTED: reused.siblingStarted,
      PULLBOARD_C7_SIBLING_FINISHED: reused.siblingFinished,
      PULLBOARD_C7_FAILURE: reused.failure,
      PULLBOARD_C7_RELEASE: reused.release,
      PULLBOARD_C7_QUEUED: reused.queued,
      PULLBOARD_C7_WORKER_MARKER: reused.workerMarker,
      PULLBOARD_C7_CHILD_READY: reused.childReady,
      PULLBOARD_C7_CHILD_PID: reused.childPid,
      PULLBOARD_C7_CHILD_DRAINED: reused.childDrained,
      PULLBOARD_C7_FAIL_CHILD_READY: reused.failChildReady,
      PULLBOARD_C7_FAIL_CHILD_PID: reused.failChildPid,
      PULLBOARD_C7_FAIL_CHILD_DRAINED: reused.failChildDrained,
    };
    for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
    const result = runFixtureChild(process.execPath, [reused.runner, '--test-concurrency=2'], {
      cwd: reused.root, env, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 1, `${result.context}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    assert.ok(existsSync(injected), 'the process-table fixture presented an old worker PID with a different start identity');
    assert.ok(await waitForFixtureProcessRunning(outsider.pid), 'the unrelated process stayed alive after stale-root cleanup');
    assert.equal(existsSync(outsiderDrained), false, 'a reused worker PID did not adopt and signal the unrelated subtree');
    assert.ok(existsSync(reused.failChildDrained), 'the runner still drained its actual failing worker child');
  });

  await t.test('a failed cleanup signal keeps the gate slot until its child exits', async t => {
    const held = makeLandingStopFixture(t);
    const machine = join(held.root, 'machine');
    mkdirSync(machine);
    writeFileSync(join(machine, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
    const signalFailure = join(held.root, 'signal-failure');
    const shim = installLandingSignalFailureShim(held);
    const baseEnv = {
      ...process.env,
      PULLBOARD_MACHINE_HOME: machine,
      PULLBOARD_LANDING_RUN: '1',
      PULLBOARD_C7_HOLD_FAIL_CHILD: '1',
      PULLBOARD_C7_SPAWN_LATE_CHILD_ON_TERM: '1',
      PULLBOARD_C7_RUNNER_PATH: held.runner,
      PULLBOARD_C7_SIGNAL_FAILURE: signalFailure,
      PULLBOARD_C7_FAIL_CHILD_RELEASE: held.failChildRelease,
      PULLBOARD_C7_SIBLING_STARTED: held.siblingStarted,
      PULLBOARD_C7_SIBLING_FINISHED: held.siblingFinished,
      PULLBOARD_C7_FAILURE: held.failure,
      PULLBOARD_C7_RELEASE: held.release,
      PULLBOARD_C7_QUEUED: held.queued,
      PULLBOARD_C7_WORKER_MARKER: held.workerMarker,
      PULLBOARD_C7_CHILD_READY: held.childReady,
      PULLBOARD_C7_CHILD_PID: held.childPid,
      PULLBOARD_C7_CHILD_DRAINED: held.childDrained,
      PULLBOARD_C7_FAIL_CHILD_READY: held.failChildReady,
      PULLBOARD_C7_FAIL_CHILD_PID: held.failChildPid,
      PULLBOARD_C7_FAIL_CHILD_DRAINED: held.failChildDrained,
      PULLBOARD_C7_LATE_CHILD_READY: held.lateChildReady,
      PULLBOARD_C7_LATE_CHILD_PID: held.lateChildPid,
      PULLBOARD_C7_LATE_CHILD_DRAINED: held.lateChildDrained,
      PULLBOARD_C7_LATE_CHILD_RELEASE: held.lateChildRelease,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(shim).href}`].filter(Boolean).join(' '),
    };
    for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete baseEnv[key];

    const landing = startFixtureChild(process.execPath, [held.runner, '--test-concurrency=2'], {
      cwd: held.root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let landingOutput = '';
    landing.stdout?.setEncoding('utf8').on('data', part => { landingOutput += part; });
    landing.stderr?.setEncoding('utf8').on('data', part => { landingOutput += part; });
    const landingClosed = new Promise(resolve => landing.once('close', (code, signal) => resolve({ code, signal })));
    let waiter;
    let waiterClosed;
    let waiterStarted = false;
    let failChildIdentity = null;
    let lateChildIdentity = null;
    try {
      await waitForFixtureMarker(held.failChildReady, 'the failing file launched its held child');
      failChildIdentity = fixtureProcessIdentity(readFileSync(held.failChildPid, 'utf8').trim());
      assert.ok(failChildIdentity, 'the owned child has a capturable cleanup identity');
      const waiterReadyFile = join(held.root, 'competing-gate-started');
      const resourceModule = fileURLToPath(new URL('../../../../resources/index.js', import.meta.url));
      const waiterSource = `import { takeResource } from ${JSON.stringify(resourceModule)}; import { writeFileSync } from 'node:fs'; const lease = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: ${JSON.stringify(held.root)}, agent: 'cleanup-drain-waiter' }); writeFileSync(${JSON.stringify(waiterReadyFile)}, 'started'); lease.release();`;
      waiter = startFixtureChild(process.execPath, ['--input-type=module', '-e', waiterSource], {
        cwd: held.root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'],
      });
      waiterClosed = new Promise(resolve => waiter.once('close', (code, signal) => resolve({ code, signal })));

      let queued = false;
      const handshakeDeadline = Date.now() + 10000;
      while (!existsSync(held.lateChildDrained) && !existsSync(waiterReadyFile) && Date.now() < handshakeDeadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(existsSync(signalFailure), 'the first owned SIGTERM failed as injected');
      assert.ok(existsSync(held.failChildDrained), 'the original owned child handled TERM and spawned a late detached child');
      assert.ok(existsSync(held.lateChildReady), 'the late detached child reached its ready handshake');
      assert.ok(existsSync(held.lateChildDrained), 'the live receipt set grew and cleanup reached the late child');
      lateChildIdentity = fixtureProcessIdentity(readFileSync(held.lateChildPid, 'utf8').trim());
      assert.ok(lateChildIdentity, 'the late child has a capturable cleanup identity');
      assert.equal(existsSync(waiterReadyFile), false, 'no competing gate action started while descendant drain was unresolved');
      const queueDeadline = Date.now() + 10000;
      while (!queued && !existsSync(waiterReadyFile) && Date.now() < queueDeadline) {
        queued = focusedPoolSnapshot(machine)?.line.some(row => row.agent === 'cleanup-drain-waiter') ?? false;
        if (!queued) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(queued, 'the competing gate action appeared in the queue while the late child remained held');
      assert.equal(existsSync(waiterReadyFile), false, 'the queued gate action has not entered before the child release');

      writeFileSync(held.lateChildRelease, 'allow exit');
      writeFileSync(held.failChildRelease, 'allow exit');
      const [landingResult, waiterResult] = await Promise.all([landingClosed, waiterClosed]);
      waiterStarted = existsSync(waiterReadyFile);
      assert.equal(landingResult.code, 1, `${landingOutput}\n${landingResult.signal ?? ''}`);
      assert.equal(landingResult.signal, null);
      assert.ok(landingOutput.includes('owned descendants drained after cleanup error: injected one-shot signal failure'), landingOutput);
      assert.deepEqual(waiterResult, { code: 0, signal: null });
      assert.ok(waiterStarted, 'the queued gate action started after owned child exit was confirmed');
    } finally {
      try { writeFileSync(held.failChildRelease, 'allow exit'); } catch { /* Fixture teardown may already remove it. */ }
      try { writeFileSync(held.lateChildRelease, 'allow exit'); } catch { /* Fixture teardown may already remove it. */ }
      if (failChildIdentity) signalFixtureProcess(failChildIdentity, 'SIGTERM');
      if (lateChildIdentity) signalFixtureProcess(lateChildIdentity, 'SIGTERM');
      if (landing.exitCode === null && landing.signalCode === null) landing.kill('SIGTERM');
      if (waiter && waiter.exitCode === null && waiter.signalCode === null) waiter.kill('SIGTERM');
      if (landingClosed) await Promise.race([landingClosed, new Promise(resolve => setTimeout(resolve, 2000))]);
      if (waiterClosed) await Promise.race([waiterClosed, new Promise(resolve => setTimeout(resolve, 2000))]);
      if (failChildIdentity) await waitForFixtureIdentityDrain(failChildIdentity);
      if (lateChildIdentity) await waitForFixtureIdentityDrain(lateChildIdentity);
    }
  });
});

for (const code of ['EPERM', 'ESRCH']) {
  test(`a landing cleanup kill that answers ${code} for a child already gone counts as gone and is logged [C7]`, async t => {
    const held = makeLandingStopFixture(t);
    const env = { ...process.env, PULLBOARD_MACHINE_HOME: join(held.root, 'machine'), PULLBOARD_LANDING_RUN: '1', PULLBOARD_C7_SIGNAL_GONE: code,
      PULLBOARD_C7_RUNNER_PATH: held.runner, PULLBOARD_C7_SIGNAL_FAILURE: join(held.root, 'signal-failure'),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(installLandingSignalFailureShim(held)).href}`].filter(Boolean).join(' ') };
    for (const [key, path] of Object.entries(held)) if (typeof path === 'string' && !['root', 'runner'].includes(key)) env['PULLBOARD_C7_' + key.replace(/[A-Z]/gu, c => '_' + c).toUpperCase()] = path;
    for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
    const result = runFixtureChild(process.execPath, [held.runner, '--test-concurrency=2'], { cwd: held.root, env, encoding: 'utf8', timeout: 30000 });
    const output = `${result.context}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.ok(existsSync(join(held.root, 'signal-failure')), 'the cleanup kill answered as injected\n' + output);
    assert.match(output, new RegExp(`run-tests: kill \\d+ answered ${code}; that process is gone or no longer ours, so it counts as gone`, 'u'));
    assert.doesNotMatch(output, /drained after cleanup error/u, 'a gone child is never a cleanup error');
  });
}

/** Build a copied production runner with tracked, ignored, and untracked test files. */
function makeTrackedSelectionFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-tracked-tests-')));
  const bin = join(root, 'bin');
  const source = join(root, 'src');
  const tests = join(root, 'test');
  const scratch = join(root, 'scratch');
  const expected = ['tracked', 'docs-esm', 'dot-suffix'];
  mkdirSync(bin);
  mkdirSync(tests);
  mkdirSync(scratch);
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(root, '.gitignore'), 'scratch/\n');
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), root);
  const capture = join(root, 'selected-files.txt');
  const trackedSources = new Map([
    ['test/tracked.test.js', trackedFixtureSource('tracked')],
    ['docs/guide.test.mjs', trackedFixtureSource('docs-esm')],
    ['prefix.test.js', trackedFixtureSource('dot-suffix')],
    ['prefix-test.cjs', trackedFixtureSource('dash-suffix')],
    ['prefix_test.mjs', trackedFixtureSource('underscore-suffix')],
    ['test-launch.js', trackedFixtureSource('test-prefix')],
    ['test.js', trackedFixtureSource('test-name')],
  ]);
  for (const [path, sourceText] of trackedSources) {
    writeFileSync(join(root, path), sourceText);
  }
  writeFileSync(join(root, 'tracked.spec.js'), `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
/** Fail if a tracked but non-default filename is selected. */
function failIfNonDefaultRuns() { appendFileSync(process.env.PULLBOARD_TRACKED_CAPTURE, 'non-default\\n'); throw new Error('non-default test was executed'); }
test('tracked spec file must not run [C7]', failIfNonDefaultRuns);
`);
  writeFileSync(join(tests, 'untracked.test.js'), `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
/** Fail if the runner discovers an untracked test from the worktree. */
function failIfUntrackedRuns() { appendFileSync(process.env.PULLBOARD_TRACKED_CAPTURE, 'untracked\\n'); throw new Error('untracked test was executed'); }
test('untracked test must not run [C7]', failIfUntrackedRuns);
`);
  writeFileSync(join(scratch, 'ignored.test.js'), `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
/** Fail if the runner discovers an ignored test from scratch storage. */
function failIfIgnoredRuns() { appendFileSync(process.env.PULLBOARD_TRACKED_CAPTURE, 'ignored\\n'); throw new Error('ignored test was executed'); }
test('ignored test must not run [C7]', failIfIgnoredRuns);
`);
  stageFixtureTests(root, ['.gitignore', ...trackedSources.keys(), 'tracked.spec.js']);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, runner: join(root, 'packages/gate/src/io/run/tests.js'), capture, expected };
}

/** Create a small ESM or CommonJS test that records its discovery-pattern label. */
function trackedFixtureSource(label) {
  if (label === 'dash-suffix') {
    return `const { appendFileSync } = require('node:fs');
const { test } = require('node:test');
/** Record one tracked default-pattern match. */
function recordTrackedMatch() { appendFileSync(process.env.PULLBOARD_TRACKED_CAPTURE, '${label}\\n'); }
test('tracked ${label} pattern ran [C7]', recordTrackedMatch);
`;
  }
  return `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
/** Record one tracked default-pattern match. */
function recordTrackedMatch() { appendFileSync(process.env.PULLBOARD_TRACKED_CAPTURE, '${label}\\n'); }
test('tracked ${label} pattern ran [C7]', recordTrackedMatch);
`;
}

/** Ensure default discovery runs tracked tests but never filesystem-only copies. */
function trackedSelectionTest(t) {
  const fixture = makeTrackedSelectionFixture(t);
  assert.equal(execFileSync('git', ['check-ignore', '-q', 'scratch/ignored.test.js'], { cwd: fixture.root }).length, 0,
    'the failing scratch test is actually ignored by Git');
  const tracked = execFileSync('git', ['ls-files'], { cwd: fixture.root, encoding: 'utf8' }).trim().split(/\r?\n/u);
  assert.ok(tracked.includes('.gitignore') && tracked.includes('tracked.spec.js'), 'the non-default and ignore control files are tracked');
  assert.equal(tracked.length, 9, 'all pattern cases and non-default controls are tracked');
  const result = runFixtureChild(process.execPath, [fixture.runner], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, PULLBOARD_TRACKED_CAPTURE: fixture.capture },
  });
  assert.equal(result.status, 0,
    `${result.context}\nexecuted files: ${readFileSync(fixture.capture, 'utf8')}`);
  for (const label of fixture.expected) assert.match(result.stdout, new RegExp(`ok [0-9]+ - tracked .*${label}.* pattern ran \\[C7\\]`, 'u'));
  assert.doesNotMatch(`${result.stdout}\n${result.stderr ?? ''}`, /ignored test was executed|untracked test was executed|non-default test was executed/u);
  assert.deepEqual(readFileSync(fixture.capture, 'utf8').trim().split(/\r?\n/u).sort(),
    fixture.expected.toSorted(),
    'only repository test entry names run exactly once');

  writeFileSync(fixture.capture, '');
  const filtered = runFixtureChild(process.execPath, [fixture.runner, '--test-name-pattern', 'docs-esm'], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, PULLBOARD_TRACKED_CAPTURE: fixture.capture },
  });
  assert.equal(filtered.status, 0, filtered.context);
  assert.match(filtered.stdout, /ok [0-9]+ - tracked docs-esm pattern ran \[C7\]/u,
    'name filters still apply to the tracked default list');
  assert.equal(readFileSync(fixture.capture, 'utf8'), 'docs-esm\n');

  const explicit = runFixtureChild(process.execPath, [fixture.runner, 'test/untracked.test.js'], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, PULLBOARD_TRACKED_CAPTURE: fixture.capture },
  });
  assert.equal(explicit.status, 1, explicit.context);
  assert.match(explicit.stdout, /not ok [0-9]+ - untracked test must not run \[C7\]/u,
    'an explicitly named fixture remains runnable even though it is untracked');
}

test('the runner skips test files git does not track [C7]', trackedSelectionTest);

/** Keep perf-shaped helpers importable without launching their standalone entry points. */
function onlyTestEntriesTest(t) {
  const fixture = makeShardFixture(t);
  const env = { ...process.env, PULLBOARD_SHARD_CAPTURE: fixture.capture,
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  /** Write one tracked fixture input with its real repository-relative path. */
  const put = (path, body) => {
    mkdirSync(dirname(join(fixture.root, path)), { recursive: true });
    writeFileSync(join(fixture.root, path), body);
  };
  /** Commit the fixture entries in a real Git repository. */
  const commit = () => {
    runFixtureGit(['add', '-A'], { cwd: fixture.root, env });
    runFixtureGit(['commit', '-qm', 'chore: discovery fixture'], { cwd: fixture.root, env });
    return runFixtureGit(['rev-parse', 'HEAD'], { cwd: fixture.root, env }).trim();
  };
  const helpers = ['apps/cli/tests/fixtures/cockpit/perf/run.mjs', 'apps/cli/tests/fixtures/cockpit/perf/generate.mjs',
    'apps/cli/tests/fixtures/cockpit/harness.js', 'apps/cli/tests/fixtures/view/link.js'];
  put('.gitignore', 'selected-files.txt\n');
  for (const path of helpers) put(path, `import { fileURLToPath } from 'node:url';
export const value = 42;
if (process.argv[1] === fileURLToPath(import.meta.url)) throw new Error('standalone helper: ${path}');
`);
  put('apps/cli/journeys/init/perf.test.js', `import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
import { value as run } from './perf/run.mjs';
import { value as generate } from './perf/generate.mjs';
import { value as fixture } from './fixture.js';
import { value as link } from '../view-link-fixture.js';
/** Exercise every imported helper without its standalone workload. */
function importedHelpersWork() { assert.deepEqual([run, generate, fixture, link], [42,42,42,42]); appendFileSync(process.env.PULLBOARD_SHARD_CAPTURE, 'cockpit/perf.test.js\\n'); }
test('perf helpers remain importable [C7]', importedHelpersWork);
`);
  put('docs/guide.test.mjs', "import { test } from 'node:test';\nimport { appendFileSync } from 'node:fs';\n/** Exercise a named documentation test entry. */\nfunction guide() { appendFileSync(process.env.PULLBOARD_SHARD_CAPTURE, 'docs/guide.test.mjs\\n'); }\ntest('documentation test entry [C7]', guide);\n");
  put('test/tree-reader.test.js', "/** @pullboard-test-input test-tree */\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.PULLBOARD_SHARD_CAPTURE, 'tree-reader.test.js\\n');\n");
  put('apps/cli/tests/fixtures/cockpit/perf/README.md', '# Perf harness\n');
  commit();
  const discovered = runFixtureChild(process.execPath, [fixture.runner], {
    cwd: fixture.root, encoding: 'utf8', env,
  });
  assert.equal(discovered.status, 0, `${discovered.context}\n${discovered.stdout}`);
  assert.doesNotMatch(discovered.stdout + discovered.stderr, /standalone helper:/u);
  assert.match(discovered.stdout, /ok [0-9]+ - perf helpers remain importable/u);
  assert.match(discovered.stdout, /ok [0-9]+ - documentation test entry/u);
  assert.deepEqual(readFileSync(fixture.capture, 'utf8').trim().split('\n').sort(),
    [...fixture.expected, 'cockpit/perf.test.js', 'docs/guide.test.mjs', 'tree-reader.test.js'].sort(),
    'each expected test entry executes once, including a file with only a tree-reader declaration');
  const entries = [...fixture.expected.map(name => `test/${name}`),
    'apps/cli/journeys/init/perf.test.js', 'docs/guide.test.mjs', 'test/tree-reader.test.js'];
  const before = runFixtureChild(process.execPath, [fixture.runner, ...entries, ...helpers], {
    cwd: fixture.root, encoding: 'utf8', env,
  });
  assert.equal(before.status, 1, 'the old broad file list launches the standalone-only helper controls');
  assert.match(before.stdout, /standalone helper:/u);
  const expectedCases = [...fixture.expected.map(name => `record ${name} [C7]`),
    'perf helpers remain importable [C7]', 'documentation test entry [C7]'].sort();
  /** Separate declared case titles from Node's synthetic path-only test-file records. */
  const declaredCases = output => [...output.matchAll(/^# Subtest: (.+)$/gmu)].map(match => match[1])
    .filter(name => ![...entries, ...helpers].some(path => name === path || name.endsWith('/' + path))).sort();
  assert.deepEqual(declaredCases(before.stdout), expectedCases, 'the old broad list runs every declared case');
  assert.deepEqual(declaredCases(discovered.stdout), expectedCases, 'test-only discovery preserves every declared case');
  const beforeTotal = Number(before.stdout.match(/^# tests (\d+)$/mu)?.[1]);
  const afterTotal = Number(discovered.stdout.match(/^# tests (\d+)$/mu)?.[1]);
  assert.equal(beforeTotal, afterTotal + helpers.length,
    'only the standalone helper-file records disappear from the raw TAP total');
  process.stderr.write(`fixture declared cases: before=${expectedCases.length}, after=${expectedCases.length}; raw TAP: before=${beforeTotal}, after=${afterTotal}; helper records removed=${helpers.length}\n`);
}

test('the suite runs only test files, not helpers or the perf harness [C7]', onlyTestEntriesTest);

/** Run the copied production runner and return the test filenames it actually executed. */
function runShardFixture(fixture, shard) {
  writeFileSync(fixture.capture, '');
  const args = [fixture.runner, ...(shard ? ['--shard', shard] : [])];
  const env = { ...process.env, PULLBOARD_SHARD_CAPTURE: fixture.capture };
  delete env.NODE_TEST_CONTEXT;
  delete env.PULLBOARD_GATE_SLOT_HELD;
  assert.equal(env.PULLBOARD_GATE_SLOT_HELD, undefined, 'the private default-run probe does not inherit an outer gate lease');
  const result = runFixtureChild(process.execPath, args, {
    cwd: fixture.root,
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.context);
  return readFileSync(fixture.capture, 'utf8').trim().split('\n').filter(Boolean);
}

/** Prove the default run stays whole and all native shard selections partition files once. */
function shardsSplitTest(t) {
  const fixture = makeShardFixture(t);
  const unsharded = runShardFixture(fixture, null);
  assert.deepEqual([...unsharded].sort(), fixture.expected, 'without --shard every discovered file still runs');
  const shards = [];
  for (let index = 1; index <= 3; index += 1) {
    const selected = runShardFixture(fixture, `${index}/3`);
    assert.ok(selected.length > 0, `shard ${index}/3 runs fixture files`);
    shards.push(selected);
  }
  const allSelected = shards.flat();
  assert.deepEqual([...allSelected].sort(), fixture.expected, 'three native shards cover every discovered file');
  assert.equal(new Set(allSelected).size, fixture.expected.length, 'no test file appears in more than one shard');
}

test('shards split the test files with none twice and none missing [C7]', shardsSplitTest);

/** Keep plain temporary projects runnable without requiring a Git index. */
function outsideGitDiscoveryTest(t) {
  const fixture = makeShardFixture(t);
  rmSync(join(fixture.root, '.git'), { recursive: true, force: true });
  const selected = runShardFixture(fixture, null);
  assert.deepEqual([...selected].sort(), fixture.expected,
    'without a Git work tree Node still discovers and executes every fixture test');

  writeFileSync(fixture.capture, '');
  writeFileSync(join(fixture.root, '.git'), 'gitdir: missing-git-directory\n');
  const broken = runFixtureChild(process.execPath, [fixture.runner], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, PULLBOARD_SHARD_CAPTURE: fixture.capture },
  });
  assert.equal(broken.status, 1, broken.context);
  assert.match(broken.stderr, /could not list tracked test files/u,
    'a damaged checkout is refused rather than mistaken for an ordinary non-Git folder');
  assert.equal(readFileSync(fixture.capture, 'utf8'), '', 'no filesystem tests run after Git metadata fails');
}

test('the runner keeps native discovery outside a Git work tree [C7]', outsideGitDiscoveryTest);

/** Assert the production runner names malformed shard ranges and their expected form. */
function badShardTest() {
  const badValues = ['0/3', '4/3', '2', 'a/b'];
  for (const value of badValues) {
    const result = runFixtureChild(process.execPath, [runner, '--shard', value], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.context);
    assert.match(result.stderr, new RegExp(`invalid --shard value "${value}"`));
    assert.match(result.stderr, /expected <i>\/<n> with 1 <= i <= n/u);
  }
}

test('a bad shard is refused by name [C7]', badShardTest);
