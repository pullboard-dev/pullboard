/** @pullboard-test-input apps/cli/journeys/resume/flow.test.js apps/cli/pullboard.js apps/view/index.js packages/gate/src/io/run/tests.js */
/** Keep the view's exact named-port refusal covered in a core-owned file [N26]. */
import { awaitNestedRun } from '../../../../packages/gate/index.js';
import assert from 'node:assert/strict';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  runFixtureChild,
  startFixtureChild,
} from '../../tests/fixtures/child.js';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
  sep,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  chooseViewPort,
  takeDefaultViewPort,
} from '../../tests/fixtures/view/port.js';
import {
  DEFAULT_VIEW_PORT,
  defaultViewPort,
} from '../../../../packages/config/index.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import { fetchFresh } from '../../tests/fixtures/http.js';
import { fetchPrintedViewLink } from '../../tests/fixtures/view/link.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');

test('a busy port names the program, not its thread [N26,I1]', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-port-program-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = String.raw`
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = { exists: fs.existsSync, read: fs.readFileSync, spawn: childProcess.spawnSync,
  platform: Object.getOwnPropertyDescriptor(process, 'platform') };
let listedName = 'MainThread';
let program = '/opt/Runtime Folder/bin/node';
fs.existsSync = path => ['/usr/sbin/lsof', '/usr/bin/lsof'].includes(path) || original.exists(path);
fs.readFileSync = (path, ...args) => path === '/proc/43210/cmdline'
  ? Buffer.from([program, '/private/DO_NOT_LEAK.js', '--token=DO_NOT_LEAK', ''].join(String.fromCharCode(0)))
  : original.read(path, ...args);
childProcess.spawnSync = (command, args, options) => {
  if (command.endsWith('/lsof')) return { status: 0, stdout: 'p43210\nc' + listedName + '\n' };
  if (command.endsWith('/ps')) return { status: 0, stdout: program + '\n' };
  throw new Error('unexpected fixture process: ' + command);
};
syncBuiltinESMExports();
try {
  const { portHolder } = await import(process.argv[1]);
  const threaded = [];
  for (program of ['/opt/Runtime Folder/bin/node', '/opt/Runtime Folder/bin/fixture-server']) {
    for (const platform of ['linux', 'darwin']) {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      threaded.push(portHolder(31337));
    }
  }
  listedName = 'python3';
  const ordinary = portHolder(31337);
  process.stdout.write(JSON.stringify({ threaded, ordinary }));
} finally {
  fs.existsSync = original.exists; fs.readFileSync = original.read; childProcess.spawnSync = original.spawn;
  Object.defineProperty(process, 'platform', original.platform);
  syncBuiltinESMExports();
}
`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script,
    pathToFileURL(resolve(import.meta.dirname, '../../../view/index.js')).href], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, HOME: join(dir, 'home'), PULLBOARD_HOME: join(dir, 'home', '.pullboard'),
      PULLBOARD_MACHINE_HOME: join(dir, 'machine-home') },
  });
  assert.equal(result.status, 0, result.failure ?? result.stderr);
  const named = JSON.parse(result.stdout);
  assert.deepEqual(named.threaded, [{ pid: 43210, name: 'node' }, { pid: 43210, name: 'node' },
    { pid: 43210, name: 'fixture-server' }, { pid: 43210, name: 'fixture-server' }],
    'Linux and macOS name the program behind a MainThread listener');
  assert.deepEqual(named.ordinary, { pid: 43210, name: 'python3' }, 'an ordinary program name stays unchanged');
  assert.doesNotMatch(result.stdout, /DO_NOT_LEAK/u, 'a script path and command arguments never become the program label');
});

test('the shipped view port stays fixed and malformed environment overrides are refused [N26]', () => {
  assert.equal(DEFAULT_VIEW_PORT, 4890);
  assert.equal(defaultViewPort({}), DEFAULT_VIEW_PORT);
  assert.equal(defaultViewPort({ PULLBOARD_VIEW_PORT: '0' }), 0);
  assert.equal(defaultViewPort({ PULLBOARD_VIEW_PORT: '65535' }), 65535);
  for (const value of ['', '-1', '65536', '4.5', '4890x', 'Infinity', ' 4890 ']) {
    assert.throws(() => defaultViewPort({ PULLBOARD_VIEW_PORT: value }), { code: 'USAGE' });
  }
});

test('the suite runs while a view holds the default port [N26,C7]', async (t) => {
  const unrelated = createHttpServer((_request, response) => response.end('unrelated default listener'));
  t.after(() => unrelated.listening ? new Promise((done) => unrelated.close(done)) : undefined);
  try {
    await new Promise((ready, fail) => {
      unrelated.once('error', fail);
      unrelated.listen(DEFAULT_VIEW_PORT, '127.0.0.1', ready);
    });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    // A person's already-running view is the exact regression condition. Never stop or replace it.
    t.diagnostic('the default port was already occupied; its existing listener is left untouched');
  }
  const names = [
    'view tests with separate private homes serialize the fixed loopback port',
    'pullboard view uses its fixed default port and reuses its authenticated listener',
    'a reused authenticated view completes setup for its new board',
  ];
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, [
    resolve(import.meta.dirname, '../../../../packages/gate/src/io/run/tests.js'), '--test-name-pattern', names.join('|'),
    resolve(import.meta.dirname, 'port.test.js'), resolve(import.meta.dirname, '../resume/flow/setup.test.js'),
  ], { cwd: resolve(import.meta.dirname, '../../../..'), env: { ...process.env } }));
  if (result.status !== 0) t.diagnostic(safeErrorSummary(result.stdout));
  assert.equal(result.status, 0, result.failure ?? result.stderr);
  for (const name of names) {
    assert.ok(result.stdout.split('\n').some(line => /^ok \d+ - /u.test(line) && line.includes(name)),
      `the occupied-default run must actually execute and pass: ${name}`);
  }
  assert.match(result.stdout, /^# fail 0$/mu);
});

/** Summarize an error without exposing authenticated URLs, keys, tokens, or record content. */
function safeErrorSummary(error) {
  const name = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(error?.name ?? '') ? error.name : 'Error';
  const code = /^[A-Za-z0-9_.-]{1,64}$/u.test(error?.code ?? '') ? ` [${error.code}]` : '';
  const message = String(error?.message ?? error)
    .replace(/https?:\/\/[^\s"'<>]+/giu, '[redacted URL]')
    .replace(/([?&](?:k|key|token)=)[^&\s"'<>]+/giu, '$1[redacted]')
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9._~-]{32,}\b/gu, '[redacted credential]');
  const nested = error instanceof AggregateError
    ? [...error.errors].map(safeErrorSummary).map((detail) => `\n  ${detail}`).join('')
    : '';
  return `${name}${code}: ${message}${nested}`;
}

/** Preserve error identity while replacing potentially sensitive text with its safe summary. */
function safeReportedError(error) {
  const reported = new Error(safeErrorSummary(error));
  if (/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(error?.name ?? '')) reported.name = error.name;
  if (/^[A-Za-z0-9_.-]{1,64}$/u.test(error?.code ?? '')) reported.code = error.code;
  return reported;
}

test("a named port that is busy is refused with the way out, not a stack trace [N26]", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-view-port-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const held = createServer();
  await new Promise((done) => held.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => held.close(done)));

  const port = held.address().port;
  const env = {
    ...process.env,
    HOME: join(dir, 'home'),
    PULLBOARD_HOME: join(dir, 'home', '.pullboard'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const result = runFixtureChild(process.execPath, [BIN, 'view', '--no-open', '--port', String(port)], {
    cwd: dir, env, encoding: 'utf8',
  });
  assert.equal(result.status, 1, `a refusal, not a crash or a hang: ${result.stderr}`);
  const json = runFixtureChild(process.execPath, [BIN, 'view', '--no-open', '--port', String(port), '--json'], {
    cwd: dir, env, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(json.status, 1, json.stderr);
  const refusal = JSON.parse(json.stdout).error;
  assert.equal(refusal.code, 'PORT_BUSY');
  assert.equal(result.stderr.trim(), `pullboard: [PORT_BUSY] port ${port} is in use: name another with --port N, or use --port 0 to take a free one\nnext: ${refusal.next}`);
});

test('a busy view port names a fix the hosted page can still find [N26,I1]', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-view-busy-default-'));
  const fixtureRoot = realpathSync(dir);
  const ownedViews = [];
  let freePort;
  t.after(async () => {
    await cleanupFixtureViews(join(dir, 'home', '.pullboard'), fixtureRoot, ownedViews);
    if (freePort !== undefined) await waitForPortToClose(freePort);
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A leased stand-in for 4890: the person's real view on the shipped port is never touched.
  const lease = await takeDefaultViewPort(dir, { agent: `view-port-busy-${process.pid}` });
  t.after(() => lease.release());
  const port = lease.port;
  const held = createServer();
  const heldSockets = new Set();
  held.on('connection', (socket) => {
    heldSockets.add(socket);
    socket.once('close', () => heldSockets.delete(socket));
  });
  await new Promise((done, fail) => { held.once('error', fail); held.listen(port, '127.0.0.1', done); });
  t.after(async () => {
    const closed = new Promise((done) => held.close(done));
    for (const socket of heldSockets) socket.destroy();
    await closed;
  });
  const env = {
    ...process.env,
    HOME: join(dir, 'home'),
    PULLBOARD_HOME: join(dir, 'home', '.pullboard'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    PULLBOARD_VIEW_PORT: String(port),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  delete env.AI_AGENT;
  delete env.PULLBOARD_VIEW_FOREGROUND;
  // A stale view record whose pid is alive in an unrelated process must never be named as the holder.
  const unrelated = startFixtureChild(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' }); // budget: idle lifetime for the unrelated pid; killed when the test ends.
  t.after(() => { unrelated.kill('SIGKILL'); });
  mkdirSync(env.PULLBOARD_HOME, { recursive: true });
  writeFileSync(join(env.PULLBOARD_HOME, `view-${port}.json`),
    `${JSON.stringify({ port, secret: randomUUID(), pid: unrelated.pid, boundAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  const plain = runFixtureChild(process.execPath, [BIN, 'view', '--no-open'], { cwd: dir, env, encoding: 'utf8', timeout: 40_000 });
  assert.equal(plain.status, 1, plain.failure ?? plain.stderr);
  const json = runFixtureChild(process.execPath, [BIN, 'view', '--no-open', '--json'], { cwd: dir, env, encoding: 'utf8', timeout: 40_000 });
  assert.equal(json.status, 1, json.failure ?? json.stderr);
  const refusal = JSON.parse(json.stdout).error;
  assert.equal(refusal.code, 'PORT_BUSY');
  for (const text of [refusal.message, refusal.next, plain.stderr]) {
    assert.ok(!text.includes('--port 0'), `no step the hosted page can never find: ${text}`);
  }
  assert.match(refusal.message, new RegExp(`^port ${port} is in use`, 'u'));
  assert.match(refusal.message, /pullboard\.dev looks for your view on that port: stop .+, then run pullboard view again$/u,
    'the refusal says the one fix that keeps the hosted page working');
  if (['/usr/sbin/lsof', '/usr/bin/lsof'].some((file) => existsSync(file)) && process.platform !== 'win32') {
    assert.ok(refusal.message.includes(`in use by node (pid ${process.pid}),`) && refusal.message.includes(`stop it with kill ${process.pid},`),
      `the refusal names the process holding the port: ${refusal.message}`);
  }
  assert.ok(!refusal.message.includes(String(unrelated.pid)), `a live pid in a stale view record is not the holder: ${refusal.message}`);
  assert.equal(refusal.next, 'stop the other view on that port, then run pullboard view again');
  assert.equal(plain.stderr.trim(), `pullboard: [PORT_BUSY] ${refusal.message}\nnext: ${refusal.next}`);
  rmSync(join(env.PULLBOARD_HOME, `view-${port}.json`), { force: true });
  const free = runFixtureChild(process.execPath, [BIN, 'view', '--no-open', '--port', '0', '--json'], { cwd: dir, env, encoding: 'utf8', timeout: 40_000 });
  assert.equal(free.status, 0, free.failure ?? free.stderr);
  const freeView = JSON.parse(free.stdout);
  freePort = freeView.port;
  ownedViews.push(await captureAuthenticatedFixtureView(env.PULLBOARD_HOME, freePort, fixtureRoot, freeView.pid, '0'));
  assert.notEqual(freePort, port, '--port 0 still takes a free port when asked for');
});

/** Wait until the owned default listener has closed after its process stops. */
async function waitForPortToClose(port, request = fetchFresh) {
  const deadline = Date.now() + 5_000; // budget: hang ceiling for observing the owned view's graceful close.
  while (Date.now() < deadline) {
    try {
      const response = await request(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      await response.body?.cancel();
    } catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') return;
      if (!['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE'].includes(error.cause?.code)) throw error;
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`the owned view listener on ${port} did not close after SIGTERM`);
}

test('a reset during view shutdown is observed until the listener really closes [N26,C7]', async (t) => {
  let connections = 0;
  const listener = createServer((socket) => {
    connections += 1;
    if (connections === 1) socket.resetAndDestroy();
    else {
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
      listener.close();
    }
  });
  await new Promise((ready, fail) => {
    listener.once('error', fail);
    listener.listen(0, '127.0.0.1', ready);
  });
  t.after(() => listener.listening ? new Promise((done) => listener.close(done)) : undefined);
  await assert.doesNotReject(waitForPortToClose(listener.address().port),
    'a connection reset is a shutdown observation, not proof that the listener is closed');
  assert.equal(connections, 2, 'the observer checks the still-open listener after its reset');
  assert.equal(listener.listening, false, 'success follows a definite connection refusal');
});

/** Start an owned worker that holds the real fixed port under its test-home-independent lease. */
function portLeaseWorker(directory, port) {
  const fixture = pathToFileURL(resolve(import.meta.dirname, '../../tests/fixtures/view/port.js')).href;
  const source = `
    import { createServer } from 'node:net';
    import { takeDefaultViewPort } from ${JSON.stringify(fixture)};
    const lease = await takeDefaultViewPort(process.cwd(), {
      port: ${port},
      agent: 'port-worker-' + process.pid,
      onWait: () => process.stdout.write('queued\\n'),
    });
    const listener = createServer();
    try {
      await new Promise((ready, fail) => {
        listener.once('error', fail);
        listener.listen(${port}, '127.0.0.1', ready);
      });
      process.stdout.write('ready\\n');
      for await (const input of process.stdin) if (String(input).includes('release')) break;
    } finally {
      if (listener.listening) await new Promise((done) => listener.close(done));
      lease.release();
    }
  `;
  const child = startFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
    cwd: directory, env: { ...process.env, PULLBOARD_MACHINE_HOME: join(directory, 'private-machine') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let errorOutput = '';
  let finished = false;
  const waiting = new Map();
  child.stdin.on('error', () => {}); // Cleanup may release an owned worker that already reported its exit.
  child.stdout.on('data', (chunk) => {
    output += chunk;
    for (const [line, waiter] of waiting) {
      if (output.split('\n').includes(line)) { waiting.delete(line); waiter.resolve(); }
    }
  });
  child.stderr.on('data', (chunk) => { errorOutput += chunk; });
  const closed = new Promise((done) => child.once('close', (code, signal) => {
    finished = true;
    for (const waiter of waiting.values()) waiter.reject(new Error(`port worker exited ${code}/${signal}: ${errorOutput}`));
    waiting.clear();
    done({ code, signal });
  }));
  return {
    closed,
    line: (line) => output.split('\n').includes(line) ? Promise.resolve()
      : finished ? Promise.reject(new Error(`port worker exited before ${line}: ${errorOutput}`))
        : new Promise((resolveLine, reject) => waiting.set(line, { resolve: resolveLine, reject })),
    release: () => { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end('release\n'); },
  };
}

test('view tests with separate private homes serialize the fixed loopback port [N26,C7]', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-view-port-peers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const port = await chooseViewPort();
  const first = portLeaseWorker(dir, port);
  let second;
  try {
    await first.line('ready');
    const other = mkdtempSync(join(tmpdir(), 'pullboard-view-port-peer-'));
    t.after(() => rmSync(other, { recursive: true, force: true }));
    second = portLeaseWorker(other, port);
    await assert.doesNotReject(second.line('queued'), 'a separate test home still waits for the real machine port');
    first.release();
    assert.equal((await first.closed).code, 0);
    await second.line('ready');
    second.release();
    assert.equal((await second.closed).code, 0, 'the waiting peer binds only after the first listener closes');
  } finally {
    first.release();
    second?.release();
    await Promise.all([first.closed, second?.closed]);
  }
});

/** Capture the authenticated view's process identity before teardown can remove its private home. */
async function captureAuthenticatedFixtureView(home, port, fixtureRoot, expectedPid, requestedPort) {
  const record = JSON.parse(readFileSync(join(home, `view-${port}.json`), 'utf8'));
  assert.equal(record.port, port, 'the private session belongs to the launched view port');
  assert.equal(record.pid, expectedPid, 'the private session PID matches the CLI result');
  const response = await fetchFresh(`http://127.0.0.1:${port}/api/v1/boards`, {
    headers: { 'x-pullboard-key': record.secret }, redirect: 'manual', signal: AbortSignal.timeout(1_000),
  });
  assert.equal(response.ok, true, 'the view process is authenticated before its identity is captured');
  await response.body?.cancel();
  const identity = readFixtureViewIdentity(record.pid);
  assert.ok(identity, 'the authenticated view process is running');
  assert.ok(isWithinFixture(identity.cwd, fixtureRoot), 'the authenticated view process cwd is inside its fixture directory');
  assert.equal(identity.executable, realpathSync(process.execPath), 'the view uses this Node executable');
  assert.ok(isFixtureViewCommand(identity.command, requestedPort), 'the captured process has the expected fixture view argv');
  return { ...identity, port, requestedPort, authenticated: true };
}

/** Read process fields without printing command arguments, which can contain private data. */
function readFixtureViewIdentity(pid) {
  let base;
  try {
    const output = runFixturePs(['-p', String(pid), '-o', 'pid=,pgid=,stat=,lstart=']).trim();
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(output);
    if (!match) {
      const current = readFixtureProcessLiveness(pid);
      if (!current || current.state.startsWith('Z')) return null;
      throw new Error(`process ${pid} identity is malformed while the process remains live`);
    }
    base = { pid: Number(match[1]), pgid: Number(match[2]), state: match[3], started: match[4] };
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
  if (base.state.startsWith('Z')) return null;
  try {
    const command = runFixturePs(['-p', String(pid), '-o', 'command=']).trim();
    let cwd;
    let executable;
    if (process.platform === 'linux') {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
      executable = readlinkSync(`/proc/${pid}/exe`);
    } else if (process.platform === 'darwin') {
      const cwdOutput = runFixtureProcessTool('/usr/sbin/lsof', ['-b', '-a', '-d', 'cwd', '-p', String(pid), '-Fn']);
      const executableOutput = runFixtureProcessTool('/usr/sbin/lsof', ['-b', '-a', '-d', 'txt', '-p', String(pid), '-Fn']);
      cwd = /^n(.*)$/mu.exec(cwdOutput)?.[1];
      const expectedExecutable = realpathSync(process.execPath);
      executable = executableOutput.split(/\r?\n/u).filter((line) => line.startsWith('n'))
        .map((line) => line.slice(1)).find((path) => {
          try { return realpathSync(path) === expectedExecutable; } catch { return false; }
        });
    } else {
      throw new Error(`cannot safely inspect fixture view processes on ${process.platform}`);
    }
    assert.ok(cwd && executable, `process ${pid} identity is unreadable; refusing to infer ownership`);
    let physicalCwd = cwd.replace(/ \(deleted\)$/u, '');
    try { physicalCwd = realpathSync(physicalCwd); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { ...base, cwd: physicalCwd, executable: realpathSync(executable), command,
      commandSha256: createHash('sha256').update(command).digest('hex') };
  } catch (error) {
    const current = readFixtureProcessLiveness(pid);
    if (!current || current.state.startsWith('Z') || current.started !== base.started || current.pgid !== base.pgid) return null;
    throw error;
  }
}

/** Run one bounded process inspection while suppressing stderr and never dumping command output. */
function runFixtureProcessTool(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', timeout: 1_500, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Run a bounded ps query for the test's own process identity checks. */
function runFixturePs(args) {
  return runFixtureProcessTool('/bin/ps', args);
}

/** Confirm whether the captured PID is absent, zombie, or still the same live process. */
function readFixtureProcessLiveness(pid) {
  let output;
  try { output = runFixturePs(['-p', String(pid), '-o', 'pid=,pgid=,stat=,lstart=']).trim(); }
  catch (error) { if (error.status === 1) return null; throw error; }
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(output);
  if (!match) throw new Error(`process ${pid} liveness is unreadable; refusing to treat it as stopped`);
  return { pid: Number(match[1]), pgid: Number(match[2]), state: match[3], started: match[4] };
}

/** Stop only authenticated fixture views, prove their exact processes exited, then verify the directory is clear. */
async function cleanupFixtureViews(home, fixtureRoot, captured = []) {
  let names;
  let homeRemovedFirst = false;
  try { names = readdirSync(home); }
  catch (error) { if (error.code === 'ENOENT') { names = []; homeRemovedFirst = captured.length > 0; } else throw error; }
  const failures = [];
  const owned = new Map(captured.map((identity) => [identity.port, identity]));
  for (const name of names.filter((entry) => /^view-\d+\.json$/u.test(entry))) {
    const port = Number(/^view-(\d+)\.json$/u.exec(name)[1]);
    try {
      const record = JSON.parse(readFileSync(join(home, name), 'utf8'));
      if (record.port !== port || !Number.isInteger(record.pid) || record.pid < 1
        || typeof record.secret !== 'string' || !record.secret) {
        failures.push(new Error(`private fixture session on port ${port} is malformed; listener left untouched`));
        continue;
      }
      let response;
      try {
        response = await fetchFresh(`http://127.0.0.1:${port}/api/v1/boards`, {
          headers: { 'x-pullboard-key': record.secret }, redirect: 'manual', signal: AbortSignal.timeout(1_000),
        });
      } catch (error) {
        if (error.cause?.code === 'ECONNREFUSED') continue;
        throw error;
      }
      if (!response.ok) await response.body?.cancel();
      const listing = response.ok ? await response.json() : null;
      if (!Array.isArray(listing?.boards) || !Array.isArray(listing?.warnings)) {
        failures.push(new Error(`private fixture session on port ${port} did not authenticate; listener left untouched`));
        continue;
      }
      let identity = owned.get(port);
      if (!identity) {
        identity = readFixtureViewIdentity(record.pid);
        if (!identity || identity.executable !== realpathSync(process.execPath)
          || !isWithinFixture(identity.cwd, fixtureRoot)
          || !isFixtureViewCommand(identity.command, String(port), '0')) {
          failures.push(new Error(`private fixture session on port ${port} does not identify its owned view process; process left untouched`));
          continue;
        }
        identity = { ...identity, port, requestedPort: identity.command.includes(`--port ${port}`) ? String(port) : '0', authenticated: true };
        owned.set(port, identity);
      }
      if (!identity.authenticated || identity.pid !== record.pid) {
        failures.push(new Error(`private fixture session on port ${port} does not match its captured authenticated process`));
        continue;
      }
      const current = readFixtureViewIdentity(identity.pid);
      if (current && !sameFixtureViewIdentity(identity, current)) {
        failures.push(new Error(`private fixture PID on port ${port} changed identity; replacement process left untouched`));
        continue;
      }
      signalFixtureView(identity, current);
      await waitForFixtureViewExit(identity);
      await waitForPortToClose(port);
    } catch (error) {
      failures.push(new Error(`could not clean up the fixture view on port ${port}: ${error.message}`));
    }
  }
  for (const identity of owned.values()) {
    try {
      const current = readFixtureViewIdentity(identity.pid);
      signalFixtureView(identity, current);
      await waitForFixtureViewExit(identity);
      await waitForPortToClose(identity.port);
    } catch (error) { failures.push(new Error(`could not confirm fixture view process ${identity.pid} exited: ${error.message}`)); }
  }
  try { assertNoFixtureViewProcesses(fixtureRoot); }
  catch (error) { failures.push(error); }
  if (homeRemovedFirst) failures.push(new Error('the private fixture home was removed before its authenticated view process was stopped'));
  if (failures.length) throw new AggregateError(failures, 'one or more fixture views could not be stopped safely');
}

/** Compare immutable OS identity fields while allowing the process to be reparented. */
function sameFixtureViewIdentity(left, right) {
  return left.pid === right.pid && left.pgid === right.pgid && left.started === right.started
    && left.cwd === right.cwd && left.executable === right.executable && left.commandSha256 === right.commandSha256;
}

/** Send TERM only to the same captured view; accept ESRCH only after confirming it exited. */
function signalFixtureView(identity, current) {
  if (!current || current.state.startsWith('Z')) return;
  if (!sameFixtureViewIdentity(identity, current)) throw new Error(`fixture view PID ${identity.pid} changed before signaling`);
  try { process.kill(identity.pid, 'SIGTERM'); }
  catch (error) {
    if (error.code !== 'ESRCH') throw error;
    const after = readFixtureViewIdentity(identity.pid);
    if (after && sameFixtureViewIdentity(identity, after) && !after.state.startsWith('Z')) throw error;
  }
}

/** Check physical fixture containment while tolerating the /var symlink on macOS. */
function isWithinFixture(cwd, fixtureRoot) {
  return cwd === fixtureRoot || cwd.startsWith(`${fixtureRoot}${sep}`);
}

/** Match only the exact pullboard CLI path and its explicit view port argument. */
function isFixtureViewCommand(command, ...ports) {
  const escapedBin = BIN.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const portPattern = ports.includes('any') ? '\\d+' : ports.map((port) => port.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|');
  return new RegExp(`(?:^|\\s)${escapedBin} view --no-open --port (?:${portPattern})(?:\\s|$)`, 'u').test(command);
}

/** Wait a bounded interval for the captured process identity to disappear or be replaced. */
async function waitForFixtureViewExit(identity, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = readFixtureViewIdentity(identity.pid);
    if (!current || !sameFixtureViewIdentity(identity, current) || current.state.startsWith('Z')) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`owned view process ${identity.pid} is still running`);
}

/** Fail closed if a Node view command still has a working directory inside the fixture. */
function assertNoFixtureViewProcesses(fixtureRoot) {
  const output = runFixturePs(['-axo', 'pid=,command=']);
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (!match || !isFixtureViewCommand(match[2], 'any')) continue;
    const identity = readFixtureViewIdentity(Number(match[1]));
    assert.ok(!identity || !isWithinFixture(identity.cwd, fixtureRoot),
      `fixture view process ${match[1]} remains under the private fixture directory`);
  }
}

test('pullboard view uses its fixed default port and reuses its authenticated listener [N26]', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-view-default-'));
  const fixtureRoot = realpathSync(dir);
  let preserveFixture = false;
  t.after(() => { if (!preserveFixture) rmSync(dir, { recursive: true, force: true }); });
  const lease = await takeDefaultViewPort(dir, { agent: `view-port-${process.pid}` });
  t.after(() => lease.release());
  const port = lease.port;
  const env = {
    ...process.env,
    HOME: join(dir, 'home'),
    PULLBOARD_HOME: join(dir, 'home', '.pullboard'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    PULLBOARD_VIEW_PORT: String(port),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  delete env.AI_AGENT;
  delete env.PULLBOARD_VIEW_FOREGROUND;
  let primaryError;
  try {
    const unrelated = createHttpServer((_request, response) => response.end('unrelated listener'));
    try {
      await new Promise((ready, fail) => {
        unrelated.once('error', fail);
        unrelated.listen(port, '127.0.0.1', ready);
      });
      const busy = runFixtureChild(process.execPath, [BIN, 'view', '--no-open', '--json'], {
        cwd: dir, env, encoding: 'utf8', timeout: 40_000, umask: 0o022,
      });
      assert.equal(busy.status, 1, busy.failure ?? busy.stderr);
      const refusal = JSON.parse(busy.stdout).error;
      assert.equal(refusal.code, 'PORT_BUSY');
      assert.ok(refusal.message.includes(String(port)));
      assert.match(refusal.message, /: stop .+, then run pullboard view again$/u);
      assert.equal(await (await fetchFresh(`http://127.0.0.1:${port}/`)).text(), 'unrelated listener', 'the refusal leaves another listener untouched');
    } finally {
      if (unrelated.listening) await new Promise((done) => unrelated.close(done));
    }

    const firstResult = runFixtureChild(process.execPath, [BIN, 'view', '--no-open', '--json'], {
      cwd: dir, env, encoding: 'utf8', timeout: 40_000, umask: 0o022,
    });
    assert.equal(firstResult.status, 0, firstResult.failure ?? firstResult.stderr);
    const first = JSON.parse(firstResult.stdout);
    assert.equal(first.port, port, 'an omitted port binds the configured fixed loopback port');
    assert.equal(first.reused, false, 'the first invocation owns the new listener');
    const sessionFile = join(env.PULLBOARD_HOME, `view-${port}.json`);
    assert.equal((statSync(sessionFile).mode & 0o077) === 0, true, 'the session secret stays private under umask 022');
    const page = await fetchPrintedViewLink(first.url);
    assert.equal(page.status, 200, 'the printed secret link reaches the view');
    await page.body?.cancel();

    const secondResult = runFixtureChild(process.execPath, [BIN, 'view', '--no-open'], {
      cwd: dir, env, encoding: 'utf8', timeout: 40_000, umask: 0o022,
    });
    assert.equal(secondResult.status, 0, secondResult.failure ?? secondResult.stderr);
    const printedLink = /^Pullboard view: (https?:\/\/127\.0\.0\.1:\d+\/\?k=\S+)$/mu.exec(secondResult.stdout)?.[1];
    assert.ok(printedLink, 'the second invocation prints the view link and stop action');
    assert.ok(printedLink === first.url, 'reuse prints the same authenticated link');
    assert.match(secondResult.stdout, /To stop it: /u);

    const freeResult = runFixtureChild(process.execPath, [BIN, 'view', '--no-open', '--port', '0', '--json'], {
      cwd: dir, env, encoding: 'utf8', timeout: 40_000, umask: 0o022,
    });
    assert.equal(freeResult.status, 0, freeResult.failure ?? freeResult.stderr);
    const free = JSON.parse(freeResult.stdout);
    assert.notEqual(free.port, port, 'explicit port 0 still asks the operating system for a free port');
    assert.equal(free.reused, false, 'explicit port 0 does not silently reuse the fixed default');

    const reserved = createServer();
    await new Promise((ready, fail) => {
      reserved.once('error', fail);
      reserved.listen(0, '127.0.0.1', ready);
    });
    const requestedPort = reserved.address().port;
    await new Promise((done) => reserved.close(done));
    const namedResult = runFixtureChild(process.execPath, [BIN, 'view', '--no-open', '--port', String(requestedPort), '--json'], {
      cwd: dir, env: { ...env, PULLBOARD_VIEW_PORT: 'invalid' }, encoding: 'utf8', timeout: 40_000, umask: 0o022,
    });
    assert.equal(namedResult.status, 0, namedResult.failure ?? namedResult.stderr);
    assert.equal(JSON.parse(namedResult.stdout).port, requestedPort, 'an explicit nonzero port overrides the default');
  } catch (error) { primaryError = error; }
  let cleanupError;
  try { await cleanupFixtureViews(env.PULLBOARD_HOME, fixtureRoot); }
  catch (error) {
    preserveFixture = true;
    cleanupError = error;
  }
  try { lease.release(); }
  catch (error) {
    cleanupError = cleanupError ? new AggregateError([cleanupError, error], 'fixture cleanup and resource release both failed') : error;
  }
  if (primaryError && cleanupError) {
    throw new AggregateError([safeReportedError(primaryError), safeReportedError(cleanupError)],
      `view test failed and cleanup also failed:\n  ${safeErrorSummary(primaryError)}\n  ${safeErrorSummary(cleanupError)}; private fixture records retained at ${env.PULLBOARD_HOME}`);
  }
  if (primaryError) throw primaryError;
  if (cleanupError) {
    throw new AggregateError([safeReportedError(cleanupError)],
      `${safeErrorSummary(cleanupError)}; private fixture records retained at ${env.PULLBOARD_HOME}`);
  }
});

/** A broken pipe is inconclusive while the real listener remains open; only refusal proves closure. */
test('a broken pipe during view shutdown is observed until the listener really closes [N26,C7]', async (t) => {
  let connections = 0;
  const listener = createServer(socket => {
    connections += 1;
    socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
    listener.close();
  });
  await new Promise((ready, fail) => {
    listener.once('error', fail);
    listener.listen(0, '127.0.0.1', ready);
  });
  t.after(() => listener.listening ? new Promise(done => listener.close(done)) : undefined);
  let probes = 0;
  /** Inject the captured transport-error shape once, then use real HTTP and real connection refusal. */
  const request = async (...args) => {
    probes += 1;
    if (probes === 1) {
      assert.equal(listener.listening, true, 'EPIPE alone does not mean the listener has closed');
      throw new TypeError('controlled write failure', { cause: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) });
    }
    return fetchFresh(...args);
  };
  await assert.doesNotReject(waitForPortToClose(listener.address().port, request), 'a broken pipe keeps observing until actual connection refusal');
  assert.equal(connections, 1, 'the observer reaches the still-open real HTTP listener after EPIPE');
  assert.ok(probes >= 3, 'success requires a later real connection refusal');
  assert.equal(listener.listening, false);
});


test('listener lookups use nonblocking lsof and name an unreadable port [N26,C7]', () => {
  const script = String.raw`
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = { exists: fs.existsSync, spawn: childProcess.spawnSync };
const calls = [];
fs.existsSync = path => ['/usr/sbin/lsof', '/usr/bin/lsof'].includes(path) || original.exists(path);
childProcess.spawnSync = (command, args) => {
  if (!command.endsWith('/lsof')) throw new Error('unexpected private probe');
  calls.push(args);
  return { status: null, stdout: '', error: { code: 'ETIMEDOUT' } };
};
syncBuiltinESMExports();
try {
  const module = await import(process.argv[1]);
  module.portHolder(31337);
  const refusal = module.busyViewPortRefusal?.(31337, true);
  console.log(JSON.stringify({ calls, message: refusal?.message ?? '' }));
} finally {
  fs.existsSync = original.exists; childProcess.spawnSync = original.spawn;
  syncBuiltinESMExports();
}
`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script,
    new URL('../../../view/index.js', import.meta.url).href], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.ok(document.calls.length > 0);
  assert.ok(document.calls.every(args => args.includes('-b')), 'a dead mount cannot make a listener lookup use blocking filesystem probes');
  assert.match(document.message, /port 31337/u);
  assert.match(document.message, /could not read.*listener.*ETIMEDOUT/iu);
});
