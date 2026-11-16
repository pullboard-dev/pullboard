/** Private runner checkouts, process helpers and ps shims for the production test runner's landing and selection cases [C7,V4]. */
import { copyRunnerPackage } from './package.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { closeSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { fstatSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { stageFixtureTests } from './tests.js';
import { pathToFileURL } from 'node:url';

export const shardFileCount = 9;

/** Treat a reaped or zombie fixture PID as drained while waiting for it to stop executing. */
export async function waitForFixtureProcessDrain(pid, timeoutMs = 2000) {
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
export async function waitForFixtureProcessRunning(pid, timeoutMs = 2000) {
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
export function fixtureProcessIdentity(pid) {
  let output;
  try { output = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,pgid=,stat=,lstart='], { encoding: 'utf8' }).trim(); }
  catch (error) { if (error.status === 1) return null; throw error; }
  const match = output.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u);
  if (!match) return null;
  return { pid: Number(match[1]), pgid: Number(match[2]), state: match[3], started: match[4] };
}

/** Signal a fixture only while its captured PID, process group, and start identity still match. */
export function signalFixtureProcess(identity, signal) {
  try {
    const current = fixtureProcessIdentity(identity.pid);
    if (!current) return;
    if (current.pid === identity.pid && current.pgid === identity.pgid && current.started === identity.started && !current.state.startsWith('Z')) {
      process.kill(identity.pid, signal);
    }
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

/** Treat disappearance, a zombie, or a changed process identity as drained. */
export async function waitForFixtureIdentityDrain(identity, timeoutMs = 2000) {
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
export async function waitForFixtureMarker(path, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(existsSync(path), `${label} before the fixture hang ceiling`);
}

/** Read only a bounded journal tail and discard partial rows at either edge. */
export function readFixtureJournalTail(path, maxBytes = 65536) {
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
export function makeShardFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-test-shards-')));
  const bin = join(root, 'bin');
  const source = join(root, 'src');
  const tests = join(root, 'test');
  mkdirSync(bin);
  mkdirSync(tests);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  copyRunnerPackage(resolve(import.meta.dirname, '../../../..'), root);
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
  return { root, capture, expected, runner: join(root, 'apps/cli/src/io/run/tests.js') };
}

/** Build a fixture with one held sibling, one failure, and queued sentinels beyond worker capacity. */
export function makeLandingStopFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-landing-stop-')));
  const bin = join(root, 'bin');
  const tests = join(root, 'test');
  mkdirSync(bin);
  mkdirSync(tests);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  copyRunnerPackage(resolve(import.meta.dirname, '../../../..'), root);
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
    root, runner: join(root, 'apps/cli/src/io/run/tests.js'),
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
export function installLandingPidReusePsShim(fixture, unrelatedPid) {
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
export function installLandingSignalFailureShim(fixture) {
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

/**
 * Run the production test runner of a shard fixture on one staged test in a fresh process, with a preload that injects a census failure.
 *
 * Why a process: the runner's own cleanup report is the subject, and it only exists in the runner's process, not the test's.
 */
export function runShardWithPreload(fixture, file, { preload, waitMs, timeout }) {
  const env = { ...process.env, PULLBOARD_LANDING_RUN: '1', PULLBOARD_LANDING_IDENTITY_WAIT_MS: String(waitMs),
    PULLBOARD_MACHINE_HOME: join(fixture.root, 'machine'),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(preload).href].filter(Boolean).join(' ') };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  const result = spawnSync(process.execPath, [fixture.runner, file], { cwd: fixture.root, env, encoding: 'utf8', timeout });
  return { ...result, context: `runner exit ${result.status} signal ${result.signal ?? 'none'} ${result.error?.message ?? ''}`.trim() };
}
