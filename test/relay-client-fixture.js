/** Private real CLI, auth and relay fixture; credentials never enter assertion messages [H1,H7,H18]. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
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
  for (const name of ['PULLBOARD_RELAY_KEY', 'PULLBOARD_RELAY_TOKEN']) delete env[name];
  const provider = await githubFixture(t);
  provider.state.deviceAuthorized = true;
  let auth;
  let time = Date.now();
  let override = null;
  let refuseEventReads = false;
  let refuseSnapshotWrites = false;
  let signIn;
  let api;
  const calls = [];
  const moveAcks = [];
  const privateKeys = new Set();
  let keyLeaked = false;
  const server = createServer(async (req, res) => {
    const end = res.end.bind(res);
    res.end = (chunk, ...args) => {
      if (req.method === 'POST' && /\/api\/v1\/boards\/[0-9a-f]{32}\/moves$/.test(req.url ?? '') && (typeof chunk === 'string' || Buffer.isBuffer(chunk))) {
        try {
          const response = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
          if (typeof response.event?.sealed === 'string') moveAcks.push(response.event);
        } catch { /* Capture only valid move acknowledgements; the production response remains unchanged. */ }
      }
      return end(chunk, ...args);
    };
    calls.push({ method: req.method, path: req.url, accept: req.headers.accept ?? '' });
    if ([...privateKeys].some(key => JSON.stringify({ url: req.url, headers: req.headers }).includes(key))) keyLeaked = true;
    if (refuseEventReads && req.method === 'GET' && /\/events(?:\?|$)/.test(req.url)) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 1, error: { code: 'RELAY_UNAVAILABLE', message: 'fixture read outage' } }));
      return;
    }
    if (override && req.method === 'DELETE') {
      res.writeHead(override.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: override.version ?? 1, error: { code: override.code, message: 'fixture refusal' } }));
      return;
    }
    if (refuseSnapshotWrites && req.method === 'PUT' && /\/api\/v1\/boards\/[0-9a-f]{32}\/state$/.test(req.url ?? '')) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 1, error: { code: 'RELAY_UNAVAILABLE', message: 'fixture snapshot outage' } }));
      return;
    }
    if (await signIn(req, res)) return;
    await api(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  auth = createRelayAuth({ database: join(scratch, 'auth.sqlite'), github: createGitHubClient({ ...provider.config, callbackURL: origin + '/auth/github/callback' }) });
  signIn = createAuthHandler({ auth, publicOrigin: origin });
  api = createRelayHandler({ directory: join(scratch, 'relay'), auth, publicOrigin: origin, pollMs: 10, maintenanceMs: 0, now: () => time });
  t.after(async () => {
    api.close();
    server.closeAllConnections();
    await new Promise(ready => server.close(ready));
    auth.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  /** Invoke the production CLI in this private repository. */
  async function cli(...args) { return childResult(root, env, [CLI, ...args, '--json']); }
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env }).status, 0);
  assert.equal((await cli('init')).code, 0);
  assert.equal(spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:fixture/repository.git'], { cwd: root, env }).status, 0);
  const lane = Object.keys(JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8')).lanes)[0];
  assert.equal((await cli('add', lane, 'private cleanup fixture item')).code, 0);
  const before = (await cli('export')).document;
  const id = before.tables.board_meta.find(row => row.meta_key === 'board_id').meta_value;
  const linkFile = join(root, '.git', 'pullboard', 'relay.json');
  const keyFile = join(env.PULLBOARD_HOME, 'relay-keys', id + '.key');

  /** Start a saved real relay link without exposing the pairing fragment. */
  async function link() {
    assert.equal((await cli('relay', 'on', '--url', origin)).code, 0, 'real device sign-in links the board');
    privateKeys.add(readFileSync(keyFile, 'utf8').trim());
  }
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
  /** Link another independently initialized synthetic board through the same real person account. */
  async function additionalBoard(title) {
    const nextRoot = join(scratch, 'additional-board');
    const nextHome = join(scratch, 'additional-home');
    mkdirSync(nextRoot);
    mkdirSync(nextHome, { mode: 0o700 });
    const nextEnv = { ...env, HOME: nextHome, PULLBOARD_HOME: join(nextHome, '.pullboard') };
    /** Run this separate board without retaining credentials in diagnostic output. */
    const run = (...args) => childResult(nextRoot, nextEnv, [CLI, ...args, '--json']);
    assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: nextRoot, env: nextEnv }).status, 0);
    assert.equal((await run('init')).code, 0);
    assert.equal(spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:fixture/repository.git'], { cwd: nextRoot, env: nextEnv }).status, 0);
    assert.equal((await run('add', lane, title)).code, 0);
    assert.equal((await run('relay', 'on', '--url', origin)).code, 0);
    const state = JSON.parse(readFileSync(join(nextRoot, '.git', 'pullboard', 'relay.json'), 'utf8'));
    const encoded = readFileSync(join(nextEnv.PULLBOARD_HOME, 'relay-keys', state.board + '.key'), 'utf8').trim();
    privateKeys.add(encoded);
    return { id: state.board, encoded, cli: run };
  }
  /** Run multiple production commands in one process, emitting only safe counters. */
  async function script(source) {
    return childResult(root, env, ['--input-type=module', '-e', source]);
  }
  return {
    root, env, origin, lane, before, linkFile, keyFile, calls, moveAcks, cli, link, otherDeviceOff, additionalBoard, script,
    advance(days) { time = Date.now() + days * 86400000; },
    overrideDelete(value) { override = value; },
    refuseSnapshotWrites(value) { refuseSnapshotWrites = value; },
    mainURL: new URL('../src/cli.js', import.meta.url).href,
    keyInRequest() { return keyLeaked; },
    /** Revoke the actual synthetic person session, including its current live streams. */
    revokeSession() { const state = JSON.parse(readFileSync(linkFile, 'utf8')); return auth.revoke(state.token, state.tokenId); },
    refuseReads(value) { refuseEventReads = value; },
  };
}
