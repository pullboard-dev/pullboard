/** Private real CLI, auth and relay fixture; credentials never enter assertion messages [H1,H7,H18]. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { Transform } from 'node:stream';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createAuthHandler } from '../relay/auth-http.js';
import { createRelayAuth } from '../relay/auth.js';
import { createRelayHandler } from '../relay/service.js';
import { createGitHubClient } from '../relay/github.js';
import { githubFixture } from './relay-fixture.js';

const CLI = resolve(import.meta.dirname, '../bin/pullboard.js');

/** Capture a real child result without exposing its private output in failure diagnostics. */
function childResult(root, env, argv) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, argv, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    child.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
    child.stderr.resume();
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error('private relay fixture child exceeded its deadline'));
      let document;
      try { document = JSON.parse(stdout); }
      catch { return reject(new Error('private relay fixture child did not return JSON')); }
      resolveResult({ code, document });
    });
  });
}

/** Start an isolated board with fallback-file keys and a real authorized loopback relay. */
export async function relayClientFixture(t) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-relay-cleanup-')));
  const root = join(scratch, 'repo');
  const home = join(scratch, 'home');
  const privateBin = join(scratch, 'path');
  mkdirSync(root);
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(privateBin, { mode: 0o700 });
  const git = process.env.PATH.split(delimiter).map(entry => join(entry, 'git')).find(existsSync);
  assert.ok(git, 'fixture has a git executable');
  symlinkSync(realpathSync(git), join(privateBin, 'git'));
  symlinkSync(realpathSync(process.execPath), join(privateBin, 'node'));
  const env = {
    ...process.env, HOME: home, PULLBOARD_HOME: join(home, '.pullboard'),
    PULLBOARD_MACHINE_HOME: join(scratch, 'machine'), PATH: privateBin,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Relay Fixture', GIT_AUTHOR_EMAIL: 'relay-fixture@example.com',
    GIT_COMMITTER_NAME: 'Relay Fixture', GIT_COMMITTER_EMAIL: 'relay-fixture@example.com',
  };
  const provider = await githubFixture(t);
  provider.state.deviceAuthorized = true;
  const authDatabase = join(scratch, 'auth.sqlite');
  const auth = createRelayAuth({ database: authDatabase, github: createGitHubClient(provider.config) });
  let time = Date.now();
  let override = null;
  let signIn;
  let api;
  const calls = [];
  const transit = [];
  const server = createServer(async (req, res) => {
    calls.push({ method: req.method, path: req.url });
    const requestChunks = [];
    const responseChunks = [];
    const request = new Transform({
      transform(chunk, _encoding, callback) {
        requestChunks.push(Buffer.from(chunk));
        callback(null, chunk);
      },
    });
    Object.assign(request, { method: req.method, url: req.url, headers: req.headers });
    req.pipe(request);
    /** Capture a response chunk for boolean-only transport audits without changing the response. */
    function captureResponse(chunk) {
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') responseChunks.push(Buffer.from(chunk));
    }
    const write = res.write.bind(res);
    res.write = (chunk, ...args) => { captureResponse(chunk); return write(chunk, ...args); };
    const end = res.end.bind(res);
    res.end = (chunk, ...args) => { captureResponse(chunk); return end(chunk, ...args); };
    res.once('finish', () => transit.push({ method: req.method, path: req.url,
      request: Buffer.concat(requestChunks), response: Buffer.concat(responseChunks) }));
    if (override && req.method === 'DELETE') {
      res.writeHead(override.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: override.version ?? 1, error: { code: override.code, message: 'fixture refusal' } }));
      return;
    }
    if (await signIn(request, res)) return;
    await api(request, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const relayPort = server.address().port;
  const origin = 'http://127.0.0.1:' + relayPort;
  signIn = createAuthHandler({ auth, publicOrigin: origin });
  api = createRelayHandler({ directory: join(scratch, 'relay'), auth, publicOrigin: origin, pollMs: 10, maintenanceMs: 0, now: () => time });
  t.after(async () => {
    api.close();
    server.closeAllConnections();
    if (server.listening) await new Promise(ready => server.close(ready));
    auth.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  /** Stop the real relay listener and close active sockets to model a network outage. */
  async function stopRelay() {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise((ready, reject) => server.close(error => error ? reject(error) : ready()));
  }
  /** Restart the same relay listener at the same address without changing its journal or credentials. */
  async function restartRelay() {
    if (server.listening) return;
    await new Promise((ready, reject) => {
      const failed = error => { server.off('listening', ready); reject(error); };
      server.once('error', failed);
      server.once('listening', () => { server.off('error', failed); ready(); });
      server.listen(relayPort, '127.0.0.1');
    });
  }
  /** Invoke the production CLI in this private repository. */
  async function cli(...args) { return childResult(root, env, [CLI, ...args, '--json']); }
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env }).status, 0);
  writeFileSync(join(root, 'README.md'), 'private relay fixture project\n', { mode: 0o600 });
  assert.equal(spawnSync('git', ['add', 'README.md'], { cwd: root, env }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-q', '-m', 'fixture base'], { cwd: root, env }).status, 0, 'fixture clone starts from a committed project');
  assert.equal((await cli('init')).code, 0);
  assert.equal(spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:fixture/repository.git'], { cwd: root, env }).status, 0);
  const lane = Object.keys(JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8')).lanes)[0];
  assert.equal((await cli('add', lane, 'private cleanup fixture item')).code, 0);
  const before = (await cli('export')).document;
  const id = before.tables.board_meta.find(row => row.meta_key === 'board_id').meta_value;
  const linkFile = join(root, '.git', 'pullboard', 'relay.json');
  const keyFile = join(env.PULLBOARD_HOME, 'relay-keys', id + '.key');

  /** Start a saved real relay link without exposing the pairing fragment. */
  async function link() { assert.equal((await cli('relay', 'on', '--url', origin)).code, 0, 'real device sign-in links the board'); }
  /** Pair and unlink from a second real repository with its own private device home and key. */
  async function otherDeviceOff() {
    const otherRoot = join(scratch, 'other-device');
    const otherHome = join(scratch, 'other-home');
    mkdirSync(otherRoot);
    mkdirSync(otherHome, { mode: 0o700 });
    const otherEnv = { ...env, HOME: otherHome, PULLBOARD_HOME: join(otherHome, '.pullboard') };
    /** Invoke the independent device's production CLI without retaining its output in diagnostics. */
    const run = (...args) => childResult(otherRoot, otherEnv, [CLI, ...args, '--json']);
    assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: otherRoot, env: otherEnv }).status, 0);
    assert.equal((await run('init')).code, 0);
    assert.equal(spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:fixture/repository.git'], { cwd: otherRoot, env: otherEnv }).status, 0);
    const snapshot = join(scratch, 'snapshot.json');
    writeFileSync(snapshot, JSON.stringify(before), { mode: 0o600 });
    assert.equal((await run('import', snapshot)).code, 0, 'second device imports the same real board');
    assert.equal((await run('relay', 'on', '--url', origin)).code, 0, 'second device signs in independently');
    return (await run('relay', 'off')).code;
  }
  /** Clone the same committed project into a separate repository/home, then join through a printed code. */
  async function otherDeviceJoin(code) {
    const bare = join(scratch, 'project.git');
    const otherRoot = join(scratch, 'paired-clone');
    const otherHome = join(scratch, 'paired-home');
    mkdirSync(otherHome, { mode: 0o700 });
    const otherEnv = { ...env, HOME: otherHome, PULLBOARD_HOME: join(otherHome, '.pullboard'), PULLBOARD_MACHINE_HOME: join(scratch, 'paired-machine') };
    assert.equal(spawnSync('git', ['clone', '--bare', root, bare], { cwd: scratch, env: otherEnv }).status, 0, 'fixture project creates a private bare remote');
    assert.equal(spawnSync('git', ['clone', bare, otherRoot], { cwd: scratch, env: otherEnv }).status, 0, 'second device is a real clone');
    assert.equal(spawnSync('git', ['remote', 'set-url', 'origin', 'git@github.com:fixture/repository.git'], { cwd: otherRoot, env: otherEnv }).status, 0, 'clone names the same authorized repository');
    const run = (...args) => childResult(otherRoot, otherEnv, [CLI, ...args, '--json']);
    assert.equal((await run('init')).code, 0, 'the cloned project initializes its private local board');
    const joined = await run('relay', 'join', code, '--url', origin);
    const document = joined.document;
    if (joined.code !== 0) throw new Error('real clone did not join the one-use pairing code');
    const exported = await run('export');
    if (exported.code !== 0) throw new Error('paired clone could not read its restored board');
    const link = JSON.parse(readFileSync(join(otherRoot, '.git', 'pullboard', 'relay.json'), 'utf8'));
    const otherKeyFile = join(otherEnv.PULLBOARD_HOME, 'relay-keys', link.board + '.key');
    const environmentKey = readFileSync(otherKeyFile, 'utf8').trim();
    /** Run a real linked-clone command with only the environment key, after removing its key file. */
    async function syncWithEnvironmentKey(...args) {
      rmSync(otherKeyFile, { force: true });
      assert.equal(existsSync(otherKeyFile), false, 'the paired clone has no stored board-key file');
      const envKey = { ...otherEnv, PULLBOARD_RELAY_KEY: environmentKey };
      return childResult(otherRoot, envKey, [CLI, ...args, '--json']);
    }
    return { joined: document, exported: exported.document, syncWithEnvironmentKey,
      /** Check that the paired clone still has no persisted board-key file. */
      keyFileExists() { return existsSync(otherKeyFile); } };
  }
  /** Run multiple production commands in one process, emitting only safe counters. */
  async function script(source) {
    return childResult(root, env, ['--input-type=module', '-e', source]);
  }
  return {
    root, env, origin, lane, before, linkFile, keyFile, calls, transit,
    relayDirectory: join(scratch, 'relay'), authDatabase,
    cli, link, otherDeviceOff, otherDeviceJoin, script, stopRelay, restartRelay,
    advance(days) { time = Date.now() + days * 86400000; },
    overrideDelete(value) { override = value; },
    mainURL: new URL('../src/cli.js', import.meta.url).href,
  };
}
