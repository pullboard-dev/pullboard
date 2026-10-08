/** Real device-flow CLI mirroring through the opaque relay [H1,H7,H15]. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createAuthHandler } from '../relay/auth-http.js';
import { createRelayAuth } from '../relay/auth.js';
import { createRelayHandler } from '../relay/service.js';
import { createGitHubClient } from '../relay/github.js';
import { decodeBoardKey, encodeBoardKey, unseal } from '../src/seal.js';
import { githubFixture } from './relay-fixture.js';

const SIGN_INS = new Map();

/** Run the actual CLI asynchronously so this process can continue serving its HTTP requests. */
function cli(root, env, ...args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, '../bin/pullboard.js'), ...args, '--json'], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
    let signInStarted = false;
    child.stderr.setEncoding('utf8').on('data', (part) => {
      stderr += part;
      if (!signInStarted && stderr.includes('enter TEST-ONLY') && SIGN_INS.has(root)) {
        signInStarted = true;
        Promise.resolve(SIGN_INS.get(root)()).catch(() => child.kill('SIGKILL'));
      }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error(`pullboard ${args.join(' ')} was killed by ${signal}: ${stderr}`));
      if (code !== 0) return reject(new Error(`pullboard ${args.join(' ')} exited ${code}: ${stderr}\n${stdout}`));
      try { resolveResult(JSON.parse(stdout)); }
      catch { reject(new Error(`pullboard ${args.join(' ')} did not print JSON: ${stdout}\n${stderr}`)); }
    });
  });
}

/** Read local events directly so inspection itself cannot drain the durable retry queue. */
function localEvents(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return JSON.parse(JSON.stringify(db.prepare('SELECT * FROM event ORDER BY event_id').all())); }
  finally { db.close(); }
}

/** Run the real auth and opaque board handlers together on a private loopback port. */
async function relayServer(t, directory, auth) {
  let signIn;
  let api;
  let refuseMoves = false;
  let loseReply = false;
  let now = Date.now();
  const calls = [];
  const server = createServer(async (req, res) => {
    calls.push({ method: req.method, path: req.url });
    if (loseReply && req.method === 'POST' && /\/moves$/.test(req.url)) {
      loseReply = false;
      res.end = () => { res.destroy(); return res; };
    }
    if (refuseMoves && req.method === 'POST' && /\/api\/v1\/boards\/[^/]+\/moves$/.test(req.url)) {
      for await (const _chunk of req) { /* consume sealed bytes without logging them */ }
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"version":1,"error":{"code":"TEMPORARY","message":"retry","next":"retry"}}');
      return;
    }
    if (await signIn(req, res)) return;
    await api(req, res);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((ready, reject) => {
    server.once('listening', ready);
    server.once('error', reject);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  signIn = createAuthHandler({ auth, publicOrigin: origin });
  api = createRelayHandler({ directory, auth, publicOrigin: origin, pollMs: 10, maintenanceMs: 0, now: () => now });
  t.after(async () => {
    api.close();
    server.closeAllConnections();
    await new Promise((ready) => server.close(ready));
  });
  return { origin, calls, failMoves(value) { refuseMoves = value; }, dropNextReply() { loseReply = true; }, advance(days) { now = Date.now() + days * 86400000; } };
}

test('[H1,H7,H15] relay on snapshots and mirrors ciphertext, retries local moves in order, and off preserves the board', async (t) => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-relay-client-')));
  const root = join(scratch, 'repo');
  const home = join(scratch, 'home');
  const pullboardHome = join(home, '.pullboard');
  const privateBin = join(scratch, 'path');
  const relayDirectory = join(scratch, 'relay');
  mkdirSync(root); mkdirSync(home, { mode: 0o700 }); mkdirSync(privateBin, { mode: 0o700 });
  chmodSync(home, 0o700); chmodSync(privateBin, 0o700);
  const gitBinary = process.env.PATH.split(delimiter).map((entry) => join(entry, 'git')).find(existsSync);
  assert.ok(gitBinary, 'the fixture PATH contains git');
  symlinkSync(realpathSync(gitBinary), join(privateBin, 'git'));
  symlinkSync(realpathSync(process.execPath), join(privateBin, 'node'));
  const env = {
    ...process.env,
    HOME: home,
    PULLBOARD_HOME: pullboardHome,
    PATH: privateBin,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Relay Test',
    GIT_AUTHOR_EMAIL: 'relay-test@example.com',
    GIT_COMMITTER_NAME: 'Relay Test',
    GIT_COMMITTER_EMAIL: 'relay-test@example.com',
  };
  const provider = await githubFixture(t);
  let signIns = 0;
  SIGN_INS.set(root, async () => {
    signIns++;
    assert.equal((await fetch(provider.origin + '/login/device')).status, 200);
  });
  t.after(() => SIGN_INS.delete(root));
  const auth = createRelayAuth({ database: join(scratch, 'auth.sqlite'), github: createGitHubClient(provider.config) });
  t.after(() => { auth.close(); });
  const relay = await relayServer(t, relayDirectory, auth);
  t.after(() => { rmSync(scratch, { recursive: true, force: true }); });
  const flow = auth.beginWeb();
  const authorization = await fetch(flow.authorizationURL, { redirect: 'manual' });
  const callback = new URL(authorization.headers.get('location'));
  const person = await auth.finishWeb(callback.searchParams.get('state'), callback.searchParams.get('code'), flow.binding);

  const git = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  await cli(root, env, 'init');
  const config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  const originRemote = spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:fixture/repository.git'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(originRemote.status, 0, originRemote.stderr);
  const marker = 'RELAY_CLIENT_KNOWN_PRIVATE_CRITERION';
  const lane = Object.keys(config.lanes)[0];
  await cli(root, env, 'add', lane, 'initial private item', '--criterion', marker);
  const boardFile = join(root, '.git', 'pullboard', 'board.sqlite');
  const beforeLink = await cli(root, env, 'export');
  const boardId = beforeLink.tables.board_meta.find((row) => row.meta_key === 'board_id').meta_value;

  const relayEnv = env;
  assert.deepEqual(relay.calls, [], 'unlinked commands open no relay connection');
  const keysDirectory = join(pullboardHome, 'relay-keys');
  mkdirSync(keysDirectory, { recursive: true, mode: 0o755 });
  await assert.rejects(cli(root, relayEnv, 'relay', 'on', '--url', relay.origin), /RELAY_KEY_STORAGE/);
  assert.deepEqual(await auth.boardsFor(person.token), [], 'a failed device key save creates no remote link');
  assert.ok(!relay.calls.some((call) => call.path === '/auth/boards/link'));
  chmodSync(keysDirectory, 0o700);
  const on = await cli(root, relayEnv, 'relay', 'on', '--url', relay.origin);
  assert.deepEqual(await auth.boardsFor(person.token), [{ id: boardId, repository: 'fixture/repository' }]);
  assert.equal(on.version, 1);
  assert.equal(on.linked, true);
  assert.equal(on.board, boardId);
  assert.match(on.link, /^https:\/\/app\.pullboard\.dev\/#board=/);
  assert.match(on.link, /(?:^|&)key=[A-Za-z0-9_-]{43}(?:&|$)/);
  assert.equal(on.url, relay.origin);
  const keyFile = join(pullboardHome, 'relay-keys', `${boardId}.key`);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  const keyText = readFileSync(keyFile, 'utf8').trim();
  const key = decodeBoardKey(keyText);
  const fragment = new URL(on.link).hash.slice(1);
  assert.equal(new URLSearchParams(fragment).get('board'), boardId);
  assert.equal(new URLSearchParams(fragment).get('key'), keyText, 'the phone link carries this board key only after #');

  /** Fetch a public sealed document and authenticate it locally with the device-only key. */
  async function get(path) {
    const response = await fetch(relay.origin + path, { headers: { authorization: `Bearer ${person.token}` } });
    return { status: response.status, body: await response.json() };
  }
  const remoteState = await get(`/api/v1/boards/${boardId}/state`);
  assert.equal(remoteState.status, 200);
  const openedSnapshot = JSON.parse(new TextDecoder().decode(await unseal(
    key, Buffer.from(remoteState.body.state.sealed, 'base64url'), { boardId, kind: 'snapshot', sequence: 0 },
  )));
  assert.equal(openedSnapshot.version, beforeLink.version);
  assert.deepEqual(openedSnapshot.tables, beforeLink.tables, 'the first sealed record preserves every native board row and counter');
  assert.equal(openedSnapshot.presentation.version, 1);
  assert.ok(openedSnapshot.presentation.state.items.some(item => item.criterion === marker), 'the optional encrypted API presentation has the same board contents');

  await cli(root, relayEnv, 'add', lane, 'mirrored private move');
  await cli(root, relayEnv, 'shout', 'person', 'mirrored private shout');
  const firstMoves = localEvents(boardFile).slice(beforeLink.tables.event.length);
  assert.deepEqual(firstMoves.map((row) => row.event_kind), ['add', 'shout']);
  let remoteEvents = await get(`/api/v1/boards/${boardId}/events?after=0`);
  assert.deepEqual(remoteEvents.body.events.map((event) => event.event_id), [1, 2]);
  for (const [index, event] of remoteEvents.body.events.entries()) {
    assert.equal(event.kind, 'move');
    const opened = JSON.parse(new TextDecoder().decode(await unseal(
      key, Buffer.from(event.sealed, 'base64url'), { boardId, kind: 'move', sequence: index + 1 },
    )));
    assert.deepEqual({ version: opened.version, engine: opened.engine, event: opened.event }, { version: 1, engine: 1, event: firstMoves[index] });
    assert.equal(opened.presentation.version, 1);
  }

  const linkFile = join(root, '.git', 'pullboard', 'relay.json');
  const oldLink = JSON.parse(readFileSync(linkFile, 'utf8'));
  await auth.revoke(person.token, oldLink.tokenId);
  const expired = await cli(root, relayEnv, 'status');
  assert.match((expired.diagnostics ?? []).join('\n'), /sign-in expired or was revoked.*relay on/);
  const renewed = await cli(root, relayEnv, 'relay', 'on');
  assert.equal(renewed.link, on.link, 'renewing sign-in preserves the device pairing key');
  assert.equal(renewed.sequence, 2, 'renewing sign-in preserves the relay cursor');
  assert.equal((await get(`/api/v1/boards/${boardId}/state`)).body.state.sealed, remoteState.body.state.sealed,
    'renewing sign-in does not replace the original snapshot');
  assert.ok(signIns >= 3, 'JSON mode exposes each device code before waiting for sign-in');

  relay.failMoves(true);
  await cli(root, relayEnv, 'add', lane, 'queued private move');
  await cli(root, relayEnv, 'shout', 'person', 'second queued private move');
  const allNewRows = localEvents(boardFile).slice(beforeLink.tables.event.length);
  assert.deepEqual(allNewRows.map((row) => row.event_kind), ['add', 'shout', 'add', 'shout']);
  const behind = await cli(root, relayEnv, 'status');
  assert.equal(behind.relay.behind, 2, 'the local command succeeds and status reports its durable failed upload');
  relay.failMoves(false);
  const caughtUp = await cli(root, relayEnv, 'status');
  assert.equal(caughtUp.relay.behind, 0, 'the next successful command drains the queue');
  remoteEvents = await get(`/api/v1/boards/${boardId}/events?after=0`);
  assert.deepEqual(remoteEvents.body.events.map((event) => event.event_id), [1, 2, 3, 4]);
  for (const [offset, queued] of remoteEvents.body.events.slice(2).entries()) {
    const sequence = offset + 3;
    assert.equal(queued.kind, 'move');
    const openedQueued = JSON.parse(new TextDecoder().decode(await unseal(
      key, Buffer.from(queued.sealed, 'base64url'), { boardId, kind: 'move', sequence },
    )));
    assert.deepEqual({ version: openedQueued.version, engine: openedQueued.engine, event: openedQueued.event }, { version: 1, engine: 1, event: allNewRows[offset + 2] }, 'queued records retain their local order');
    if (openedQueued.presentation) {
      assert.equal(openedQueued.presentation.version, 1);
      assert.equal(openedQueued.presentation.state.events[0].event_id, openedQueued.event.event_id, 'a queued projection never contains later unacknowledged local moves');
    }
  }
  relay.dropNextReply();
  await cli(root, relayEnv, 'add', lane, 'committed reply lost');
  const recovered = await cli(root, relayEnv, 'status');
  assert.equal(recovered.relay.behind, 0);
  assert.equal(recovered.relay.sequence, 5);
  remoteEvents = await get(`/api/v1/boards/${boardId}/events?after=0`);
  assert.deepEqual(remoteEvents.body.events.map((event) => event.event_id), [1, 2, 3, 4, 5], 'a committed send with a lost reply is acknowledged without duplication');
  relay.advance(80);
  const warned = await cli(root, relayEnv, 'status');
  assert.match((warned.diagnostics ?? []).join('\n'), /BOARD_INACTIVE.*10 days left.*Make a board move/i, 'the next linked command shows the real relay retention notice and repair');
  relay.advance(0);

  const stored = Buffer.concat(readdirSync(relayDirectory).map((name) => readFileSync(join(relayDirectory, name))));
  for (const secret of [marker, 'initial private item', 'mirrored private move', 'mirrored private shout', 'queued private move', 'second queued private move', 'committed reply lost', root]) {
    assert.equal(stored.includes(Buffer.from(secret)), false, `relay journal does not contain known plaintext ${secret}`);
  }
  assert.equal(stored.includes(key), false, 'relay journal does not contain raw key bytes');
  assert.equal(stored.includes(Buffer.from(encodeBoardKey(key))), false, 'relay journal does not contain the encoded key');

  const localBeforeOff = await cli(root, relayEnv, 'export');
  const off = await cli(root, relayEnv, 'relay', 'off');
  assert.equal(off.linked, false);
  assert.deepEqual(await cli(root, env, 'export'), localBeforeOff, 'unlink leaves local rows and counters unchanged');
  assert.deepEqual(await auth.boardsFor(person.token), [], 'unlink removes the repository link');
  const session = await fetch(relay.origin + '/auth/session', { headers: { authorization: `Bearer ${person.token}` } });
  assert.equal(session.status, 200, 'unlink preserves the person session');
  assert.equal((await get(`/api/v1/boards/${boardId}/state`)).status, 404);
  assert.equal(readdirSync(relayDirectory).some((name) => name.startsWith(boardId + '.journal.sqlite')), false,
    'off removes the relay journal and SQLite sidecars');
  const afterOffCalls = relay.calls.length;
  await cli(root, env, 'status');
  assert.equal(relay.calls.length, afterOffCalls, 'unlinked commands stop connecting immediately');
  assert.equal(existsSync(keyFile), false, 'successful off removes this device copy of the board key');
});
