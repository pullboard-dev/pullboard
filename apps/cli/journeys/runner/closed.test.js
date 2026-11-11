/** @pullboard-test-input source-tree */
/** Faulted restart custody never signals a private worker; genuine idle/busy recovery remains registered [C7]. */
import '../../../runner/tests/io/private/check/worker/restart.test.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { HOST } from '../../tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../tests/fixtures/runner/ssh.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';

// Each fault is confined to a separate private component process. No production test seam or machine-pool worker is used.
const CHILD_SOURCE = String.raw`
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
const config = JSON.parse(process.argv[1]);
const { root, fault, healthURL } = config;
const jobs = join(root, 'jobs');
const workerFile = join(root, 'runtime', 'b'.repeat(64), 'apps/runner/src/io/scripts/worker.js');
const ready = join(root, 'ready');
fs.mkdirSync(join(workerFile, '..'), { recursive: true });
fs.mkdirSync(jobs, { recursive: true });
fs.writeFileSync(workerFile, 'require("node:fs").writeFileSync(' + JSON.stringify(ready) + ',"ready");setInterval(()=>{},60000);');
const foreignFile = join(root, 'foreign ' + workerFile);
if (fault === 'foreign-entrypoint') {
  fs.mkdirSync(join(foreignFile, '..'), { recursive: true });
  fs.copyFileSync(workerFile, foreignFile);
}
const unrelated = fault === 'unrelated-command' || fault === 'separate-argument';
const shell = fault === 'shell-argument';
const forgedExecutable = fault === 'foreign-executable';
const args = shell ? ['-c', 'printf ready > "$1"; read ignored', 'fixture-shell', ready, workerFile]
  : unrelated ? ['-e', fs.readFileSync(workerFile, 'utf8'),
    fault === 'separate-argument' ? workerFile : 'not-a-worker:' + workerFile]
    : [fault === 'foreign-entrypoint' ? foreignFile : workerFile];
const executable = forgedExecutable ? '/usr/bin/tee' : shell ? '/bin/sh' : process.execPath;
const worker = childProcess.spawn(executable, args, { cwd: root, stdio: ['pipe', 'ignore', 'ignore'],
  ...(forgedExecutable ? { argv0: 'node' } : {}) });
const exited = once(worker, 'exit');
const originalKill = process.kill;
const originalSpawn = childProcess.spawnSync;
const originalReadDirectory = fs.readdirSync;
const originalOut = process.stdout.write;
const originalErr = process.stderr.write;
const signals = [];
let output = '', logs = '', reused = false, changedObservations = 0;
try {
  if (forgedExecutable) {
    await once(worker, 'spawn');
    // tee is genuinely spawned with open private stdin; this setup marker is not a worker health receipt.
    fs.writeFileSync(ready, 'foreign executable spawned');
  }
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(ready)) {
    if (Date.now() > deadline || worker.exitCode !== null) throw new Error('private worker did not start');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (fault.startsWith('owner-')) {
    const directory = join(jobs, 'private-job'); fs.mkdirSync(directory);
    if (fault !== 'owner-missing') fs.writeFileSync(join(directory, 'worker-owner.json'),
      fault === 'owner-json' ? '{' : JSON.stringify({ pid: worker.pid, started: '' }));
  }
  if (fault === 'job-symlink') {
    const outside = join(root, 'outside-job'); fs.mkdirSync(outside); fs.symlinkSync(outside, join(jobs, 'linked-job'));
  }
  if (fault === 'job-file') fs.writeFileSync(join(jobs, 'unknown-entry'), 'not job custody');
  if (fault === 'sqlite-schema') {
    const db = new DatabaseSync(join(process.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite'));
    try { db.exec('CREATE TABLE unrelated(value TEXT)'); } finally { db.close(); }
  }
  /** Inject a real read-error result only at this private jobs boundary. */
  fs.readdirSync = function(directory, ...options) {
    if ((fault === 'jobs-read' || fault === 'jobs-disappeared') && directory === jobs)
      throw Object.assign(new Error('controlled private jobs read denial'), { code: fault === 'jobs-read' ? 'EACCES' : 'ENOENT' });
    return originalReadDirectory.call(fs, directory, ...options);
  };
  /** Present an OS-reused PID identity after TERM; the real fixture process itself remains alive for the oracle. */
  childProcess.spawnSync = function(command, args, options) {
    const result = originalSpawn.call(childProcess, command, args, options);
    if (fault === 'pid-reuse' && reused && command === '/bin/ps' && args.includes('pid=,ppid=,pgid=,lstart=,stat=,args=') && typeof result.stdout === 'string') {
      result.stdout = result.stdout.split('\n').map(line => {
        const row = /^(\s*)(\d+)(\s+\d+\s+\d+\s+)([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})(\s+\S+\s+)(.+)$/u.exec(line);
        if (!row || Number(row[2]) !== worker.pid) return line;
        changedObservations++;
        return row[1] + row[2] + row[3] + 'Thu Jan 1 00:00:00 1970' + row[5] + row[6];
      }).join('\n');
    }
    return result;
  };
  /** Record attempted signals without delivering them; zero remains an actual read-only liveness probe. */
  process.kill = function(pid, signal) {
    if (signal === 0) return originalKill.call(process, pid, signal);
    signals.push({ pid, signal });
    if (fault === 'pid-reuse' && pid === worker.pid && signal === 'SIGTERM') reused = true;
    return true;
  };
  syncBuiltinESMExports();
  const { serveRestart } = await import(healthURL);
  /** Capture the actual component reply without substituting a response or diagnostic. */
  process.stdout.write = function(bytes) { output += String(bytes); return true; };
  /** Capture exactly the component's greppable stderr lines. */
  process.stderr.write = function(bytes) { logs += String(bytes); return true; };
  serveRestart(Buffer.from(JSON.stringify({ nonce: '11111111-1111-1111-1111-111111111111', root })).toString('base64'));
  process.stdout.write = originalOut; process.stderr.write = originalErr;
  console.log(JSON.stringify({ root, runner: hostname(), pid: worker.pid, signals, changedObservations,
    launchedExecutable: executable, argv0: forgedExecutable ? 'node' : executable, entrypointArgument: args[0],
    alive: originalKill.call(process, worker.pid, 0), reply: JSON.parse(output), logs }));
} finally {
  process.stdout.write = originalOut; process.stderr.write = originalErr;
  process.kill = originalKill; fs.readdirSync = originalReadDirectory; childProcess.spawnSync = originalSpawn;
  syncBuiltinESMExports();
  if (worker.exitCode === null && worker.signalCode === null) originalKill.call(process, worker.pid, 'SIGKILL');
  await exited;
}
`;

/** Exercise the actual restart component with real private files/SQLite and controlled OS observations in one child. */
function observe(t, fault) {
  const files = privateFixtureFiles('pullboard-restart-failclosed-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  const home = join(files.root, 'home'), machineHome = join(home, '.pullboard');
  mkdirSync(machineHome, { recursive: true });
  const env = { ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome };
  // An ordinary component subprocess is not the Node test worker; preserve all stock NODE_OPTIONS.
  delete env.NODE_TEST_CONTEXT;
  const input = { root: join(files.root, 'runner'), fault,
    healthURL: pathToFileURL(join(import.meta.dirname, '../../../runner/src/io/worker/health.js')).href };
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', CHILD_SOURCE, JSON.stringify(input)],
    { cwd: files.root, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.context + result.stdout);
  assert.equal(result.signal, null, result.context);
  return JSON.parse(result.stdout);
}

/** Require one explicit hostname/root/reason line and the actual unhealthy component reply. */
function refused(actual, reason) {
  assert.equal(actual.reply.idle, false);
  assert.equal(actual.reply.writable, false);
  assert.match(actual.reply.reason, reason);
  const lines = actual.logs.split('\n').filter(line => line.startsWith('pullboard runner-restart refused '));
  assert.equal(lines.length, 1, actual.logs);
  assert.ok(lines[0].includes('runner=' + JSON.stringify(actual.runner)), lines[0]);
  assert.ok(lines[0].includes('root=' + JSON.stringify(actual.root)), lines[0]);
  assert.ok(lines[0].includes('reason=' + JSON.stringify(actual.reply.reason)), lines[0]);
}

for (const [fault, reason] of [
  ['jobs-read', /jobs directory could not be read.*EACCES/u],
  ['jobs-disappeared', /jobs directory could not be read.*ENOENT/u],
  ['owner-json', /job owner JSON is malformed/u],
  ['owner-fields', /job owner PID\/start record is malformed/u],
  ['owner-missing', /job owner record could not be read.*ENOENT/u],
  ['sqlite-schema', /resource SQLite idle query failed.*ERR_SQLITE_ERROR/u],
  ['job-symlink', /jobs entry is not a real directory/u],
  ['job-file', /jobs entry is not a real directory/u],
]) {
  test('restart refuses [C7] ' + fault + ' before every signal and logs the actual runner and reason', t => {
    const actual = observe(t, fault);
    assert.deepEqual(actual.signals, [], 'no TERM or KILL may precede the failed idle observation');
    assert.deepEqual(actual.reply.restarted, []);
    assert.equal(actual.alive, true, 'the genuine private pinned worker remains alive');
    refused(actual, reason);
  });
}

test('restart leaves an unrelated command containing a pinned-worker path substring alone [C7]', t => {
  const actual = observe(t, 'unrelated-command');
  assert.deepEqual(actual.signals, []);
  assert.deepEqual(actual.reply.restarted, []);
  assert.equal(actual.alive, true);
  assert.equal(actual.reply.idle, true, JSON.stringify(actual));
});


test('a pinned-worker path supplied as a separate argument to node -e never makes that process a restart target [C7]', t => {
  const actual = observe(t, 'separate-argument');
  assert.deepEqual(actual.signals, []);
  assert.deepEqual(actual.reply.restarted, []);
  assert.equal(actual.alive, true);
  refused(actual, /pinned-path command is not the ordinary Node worker entrypoint/u);
});


test('a shell command carrying a pinned-worker path is never itself a restart target [C7]', t => {
  const actual = observe(t, 'shell-argument');
  assert.deepEqual(actual.signals, []);
  assert.deepEqual(actual.reply.restarted, []);
  assert.equal(actual.alive, true);
  refused(actual, /pinned-path command is not the ordinary Node worker entrypoint/u);
});


test('a different actual entrypoint containing whitespace plus a pinned-worker suffix is never a restart target [C7]', t => {
  const actual = observe(t, 'foreign-entrypoint');
  assert.deepEqual(actual.signals, []);
  assert.deepEqual(actual.reply.restarted, []);
  assert.equal(actual.alive, true, 'the real foreign script stays alive despite its misleading filename');
  refused(actual, /pinned-path command is not the ordinary Node worker entrypoint/u);
});


test('a genuine unrelated OS executable with argv0 node and exact worker argv1 is never signaled [C7]', t => {
  const actual = observe(t, 'foreign-executable');
  assert.equal(actual.launchedExecutable, '/usr/bin/tee');
  assert.equal(actual.argv0, 'node');
  assert.equal(actual.entrypointArgument, join(actual.root, 'runtime', 'b'.repeat(64), 'apps/runner/src/io/scripts/worker.js'));
  assert.deepEqual(actual.signals, []);
  assert.deepEqual(actual.reply.restarted, []);
  assert.deepEqual(actual.reply.signalAttempts, []);
  assert.equal(actual.alive, true, 'the unrelated executable really remains alive with its private stdin open');
  refused(actual, /pinned-path command is not the ordinary Node worker entrypoint/u);
});

test('a reused PID observation after TERM cannot authorize KILL of the replacement identity [C7]', t => {
  const actual = observe(t, 'pid-reuse');
  assert.deepEqual(actual.signals, [{ pid: actual.pid, signal: 'SIGTERM' }]);
  assert.deepEqual(actual.reply.restarted, [], 'a partial TERM is not a completed idle restart');
  assert.deepEqual(actual.reply.signalAttempts, actual.signals, 'retain the actual attempted TERM independently of completed restarts');
  assert.ok(actual.changedObservations > 0, 'the fresh OS census really changed PID start identity');
  assert.equal(actual.alive, true, 'the recording-signal fixture was not killed');
  refused(actual, /worker PID identity changed before SIGKILL/u);
});

/** The real SSH stand-in and pinned capsule must return their refusal through the ordinary controller consumer. */
const PROBE_SOURCE = String.raw`
import { DatabaseSync } from 'node:sqlite';
const config = JSON.parse(process.argv[1]);
const db = new DatabaseSync(config.resourceFile);
try { db.exec('CREATE TABLE unrelated(value TEXT)'); } finally { db.close(); }
const { probeRunnerHealth } = await import(config.healthURL);
let logs = '';
const original = process.stderr.write;
try {
  /** Observe the normal consumer log; preserve its actual authenticated return value. */
  process.stderr.write = function(bytes) { logs += String(bytes); return true; };
  const reply = await probeRunnerHealth(config.runner, undefined, { restart: true });
  process.stdout.write(JSON.stringify({ reply, logs }));
} finally { process.stderr.write = original; }
`;

test('ordinary probeRunnerHealth exposes the actual pinned restart SQLite refusal with runner and reason [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const bin = join(box.dir, 'probe-bin'), home = join(box.dir, 'remote-home');
  const root = join(home, '.pullboard-runner'), machineHome = join(home, '.pullboard');
  const worker = join(box.dir, 'private-worker');
  for (const directory of [bin, worker, root, machineHome]) mkdirSync(directory, { recursive: true });
  installSshStandIn({ bin, worker, home, machineHome, requests: join(box.dir, 'requests.jsonl'), nodeCommand: process.execPath });
  const input = { resourceFile: join(machineHome, 'resources.sqlite'),
    healthURL: pathToFileURL(join(import.meta.dirname, '../../../../packages/runners/index.js')).href,
    runner: { host: HOST, node: process.execPath, root, slots: 1, browser: 0 } };
  const env = { ...box.env, PATH: bin + ':' + box.env.PATH };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', PROBE_SOURCE, JSON.stringify(input)],
    { cwd: box.repo, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.context + result.stdout);
  assert.equal(result.signal, null, result.context);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.reply.healthy, false);
  assert.equal(actual.reply.step, 'idle proof', 'the genuine pinned worker answered its nonce/version request');
  assert.equal(actual.reply.code, 0);
  assert.deepEqual(actual.reply.signalAttempts, []);
  assert.equal(actual.reply.idle, false);
  assert.deepEqual(actual.reply.restarted, []);
  assert.match(actual.reply.reason, /resource SQLite idle query failed.*ERR_SQLITE_ERROR/u);
  const lines = actual.logs.split('\n').filter(line => line.startsWith('pullboard runner-restart refused '));
  assert.equal(lines.length, 1, actual.logs);
  assert.ok(lines[0].includes('runner=' + JSON.stringify(HOST)), lines[0]);
  assert.ok(lines[0].includes('root=' + JSON.stringify(root)), lines[0]);
  assert.ok(lines[0].includes('reason=' + JSON.stringify(actual.reply.reason)), lines[0]);
});
