/** Two real clients and encrypted CLI records exercise the relay without sharing their key [A4,H7]. */
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { serveRelay } from '../relay/service.js';
import { createRelayAuth } from '../relay/auth.js';
import { createGitHubClient } from '../relay/github.js';
import { githubFixture } from './relay-fixture.js';

/** Seal on the test client only; nonce, authentication tag and ciphertext are opaque to the server. */
function seal(key, value) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64url');
}

/** Open on the test client only, proving that received ciphertext still represents the sent record. */
function unseal(key, value) {
  const bytes = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
}

/** Create a real private CLI board, actual stand-in GitHub sign-in, and an ephemeral relay server. */
async function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-sealed-http-')));
  const root = join(directory, 'repo');
  const home = join(directory, 'home');
  const data = join(directory, 'relay');
  mkdirSync(root); mkdirSync(home);
  const env = { ...process.env, HOME: home, PULLBOARD_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  /** Run the current CLI only in the fixture's private home and Git repository. */
  function cli(...args) {
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../bin/pullboard.js'), ...args], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  cli('init');
  const config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  const marker = 'PRIVATE_BOARD_CRITERION_DO_NOT_RELAY_IN_CLEAR';
  cli('add', Object.keys(config.lanes)[0], 'A sealed board item', '--criterion', marker);
  const document = JSON.parse(cli('export'));
  const id = document.tables.board_meta.find((row) => row.meta_key === 'board_id').meta_value;
  const provider = await githubFixture(t);
  const auth = createRelayAuth({ database: join(directory, 'auth.sqlite'), github: createGitHubClient(provider.config) });
  const flow = auth.beginWeb();
  const redirect = await fetch(flow.authorizationURL, { redirect: 'manual' });
  const callback = new URL(redirect.headers.get('location'));
  const person = await auth.finishWeb(callback.searchParams.get('state'), callback.searchParams.get('code'), flow.binding);
  await auth.linkBoard(person.token, id, 'fixture/repository');
  const one = await auth.issueToken(person.token, { board: id, agent: 'client-one' });
  const two = await auth.issueToken(person.token, { board: id, agent: 'client-two' });
  const relay = await serveRelay({ directory: data, auth, port: 0, pollMs: 20, publicOrigin: 'http://127.0.0.1:44444' });
  t.after(async () => { await relay.close(); auth.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:' + relay.port;
  const key = randomBytes(32);

  /** Send one private API call without putting credentials or board keys in its URL or diagnostics. */
  async function call(path, { method = 'GET', body, token = one.token, headers = {} } = {}) {
    const response = await fetch(origin + path, {
      method,
      headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  return { directory, root, data, cli, document, id, marker, auth, person, one, two, relay, origin, key, call, path: '/api/v1/boards/' + id };
}

test('[A4,H7] two clients append sealed moves in one order and no plaintext or client key reaches storage', async (t) => {
  const box = await fixture(t);
  const listed = await box.call('/api/v1/boards');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.boards, [{ id: box.id, repository: 'fixture/repository' }]);
  const initial = seal(box.key, box.document);
  const uploaded = await box.call(box.path + '/state', { method: 'PUT', body: { sequence: 0, sealed: initial } });
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.version, 1);
  assert.deepEqual(unseal(box.key, uploaded.body.state.sealed), box.document);
  const sent = [
    { client: 'one', title: 'PRIVATE_MOVE_FROM_CLIENT_ONE' },
    { client: 'two', title: 'PRIVATE_MOVE_FROM_CLIENT_TWO' },
  ];
  const results = await Promise.all(sent.map((move, index) => box.call(box.path + '/moves', {
    method: 'POST', token: index ? box.two.token : box.one.token, body: { sealed: seal(box.key, move) },
  })));
  assert.ok(results.every((reply) => reply.status === 200 && reply.body.version === 1));
  assert.deepEqual(results.map((reply) => reply.body.event.event_id).sort(), [1, 2]);
  const read = await box.call(box.path + '/events?after=0');
  assert.deepEqual(read.body.events.map((row) => row.event_id), [1, 2]);
  assert.deepEqual(read.body.events.map((row) => unseal(box.key, row.sealed)).sort((a, b) => a.client.localeCompare(b.client)), sent);
  const bytes = Buffer.concat(readdirSync(box.data).map((file) => readFileSync(join(box.data, file))));
  for (const text of [box.marker, ...sent.map((move) => move.title), box.root]) {
    assert.equal(bytes.includes(Buffer.from(text)), false, 'a known client plaintext must never occur in relay database bytes');
  }
  assert.equal(bytes.includes(box.key), false, 'the client key must never occur in relay database bytes');
  assert.deepEqual(JSON.parse(box.cli('export')), box.document, 'the complete local board remains unchanged');
});

test('[A4,H7] snapshots compact covered moves, preserve the tail and deletion removes only its database', async (t) => {
  const box = await fixture(t);
  await box.call(box.path + '/state', { method: 'PUT', body: { sequence: 0, sealed: seal(box.key, box.document) } });
  for (let n = 1; n <= 3; n++) {
    const reply = await box.call(box.path + '/moves', { method: 'POST', body: { sealed: seal(box.key, { move: n }) } });
    assert.equal(reply.body.event.event_id, n);
  }
  const compacted = await box.call(box.path + '/state', { method: 'PUT', body: { sequence: 2, sealed: seal(box.key, { covered: 2 }) } });
  assert.equal(compacted.status, 200);
  assert.equal(compacted.body.state.sequence, 2);
  assert.deepEqual(unseal(box.key, (await box.call(box.path + '/state')).body.state.sealed), { covered: 2 });
  const oldCursor = await box.call(box.path + '/events?after=0');
  assert.equal(oldCursor.status, 409);
  assert.equal(oldCursor.body.error.code, 'SNAPSHOT_REQUIRED');
  assert.deepEqual((await box.call(box.path + '/events?after=2')).body.events.map((row) => row.event_id), [3]);
  const next = await box.call(box.path + '/moves', { method: 'POST', body: { sealed: seal(box.key, { move: 4 }) } });
  assert.equal(next.body.event.event_id, 4);
  const other = 'f'.repeat(32) === box.id ? 'e'.repeat(32) : 'f'.repeat(32);
  await box.auth.linkBoard(box.person.token, other, 'fixture/repository');
  const otherPath = '/api/v1/boards/' + other;
  assert.equal((await box.call(otherPath + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: seal(box.key, { other: true }) } })).status, 200);
  assert.equal((await box.call(box.path, { method: 'DELETE' })).status, 200);
  for (const suffix of ['', '-wal', '-shm']) assert.equal(existsSync(join(box.data, box.id + '.journal.sqlite' + suffix)), false);
  assert.equal((await box.call(box.path + '/state')).status, 404);
  assert.deepEqual(unseal(box.key, (await box.call(otherPath + '/state', { token: box.person.token })).body.state.sealed), { other: true });
  assert.deepEqual(JSON.parse(box.cli('export')), box.document);
});

test('[A4,H7] malformed or unauthorized calls cannot store clear records, keys or another board', async (t) => {
  const box = await fixture(t);
  assert.equal((await box.call(box.path + '/state', { token: null })).status, 401);
  const other = 'b'.repeat(32) === box.id ? 'c'.repeat(32) : 'b'.repeat(32);
  const wrong = await box.call('/api/v1/boards/' + other + '/state');
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, 'TOKEN_BOARD');
  for (const body of [{ sequence: 0, sealed: 'a' }, { sequence: 0, sealed: 'abc=' }, { sequence: 0, sealed: seal(box.key, {}), key: 'client key stays on device' }, { sequence: '0', sealed: seal(box.key, {}) }]) {
    assert.equal((await box.call(box.path + '/state', { method: 'PUT', body })).status, 400);
  }
  assert.deepEqual(readdirSync(box.data), []);
  await box.call(box.path + '/state', { method: 'PUT', body: { sequence: 0, sealed: seal(box.key, box.document) } });
  assert.equal((await box.call(box.path + '/moves', { method: 'POST', body: { verb: 'add', args: { title: 'clear' } } })).body.error.code, 'BAD_UPLOAD');
  const deniedCookie = await box.call(box.path + '/moves', { method: 'POST', token: null, headers: { cookie: 'pb_session=' + box.person.token, origin: 'https://foreign.example' }, body: { sealed: seal(box.key, {}) } });
  assert.equal(deniedCookie.status, 403);
  assert.equal(deniedCookie.body.error.code, 'BAD_ORIGIN');
  assert.equal((await box.call(box.path + '/state', { token: null, headers: { cookie: 'pb_session=' + box.person.token } })).status, 200);
  const cookieMove = await box.call(box.path + '/moves', { method: 'POST', token: null, headers: { cookie: 'pb_session=' + box.person.token, origin: 'http://127.0.0.1:44444' }, body: { sealed: seal(box.key, { cookie: true }) } });
  assert.equal(cookieMove.status, 200);
  await box.auth.revoke(box.person.token, box.one.id);
  assert.equal((await box.call(box.path + '/state')).status, 401);
});

test('[A4,H7] live streams follow the same order, resume by cursor and stop after revocation', async (t) => {
  const box = await fixture(t);
  await box.call(box.path + '/state', { method: 'PUT', body: { sequence: 0, sealed: seal(box.key, box.document) } });
  const controllers = [];
  t.after(() => { for (const controller of controllers) controller.abort(); });
  /** Open a live API stream and bound each observation without exposing its credential. */
  async function stream(last = null) {
    const controller = new AbortController();
    controllers.push(controller);
    const reply = await fetch(box.origin + box.path + '/events?after=0', {
      headers: { authorization: 'Bearer ' + box.two.token, accept: 'text/event-stream', ...(last === null ? {} : { 'last-event-id': String(last) }) },
      signal: controller.signal,
    });
    assert.equal(reply.status, 200);
    const reader = reply.body.getReader();
    let text = '';
    /** Wait only until the requested synthetic cursor or refusal appears. */
    async function until(fragment) {
      const deadline = Date.now() + 3000;
      while (!text.includes(fragment)) {
        let timer;
        const part = await Promise.race([
          reader.read(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('sealed stream timed out')), Math.max(1, deadline - Date.now())); }),
        ]).finally(() => clearTimeout(timer));
        assert.equal(part.done, false, 'stream ended before expected delivery');
        text += Buffer.from(part.value).toString('utf8');
      }
      return text;
    }
    return { until, cancel: () => reader.cancel() };
  }
  const first = await stream();
  await first.until(': API v1\n');
  const one = await box.call(box.path + '/moves', { method: 'POST', body: { sealed: seal(box.key, { live: 1 }) } });
  assert.equal(one.body.event.event_id, 1);
  const firstText = await first.until('id: 1\n');
  assert.ok(firstText.includes(JSON.stringify({ version: 1, event: one.body.event })));
  const resumed = await stream(1);
  await resumed.until(': API v1\n');
  const two = await box.call(box.path + '/moves', { method: 'POST', body: { sealed: seal(box.key, { live: 2 }) } });
  assert.equal(two.body.event.event_id, 2);
  const resumedText = await resumed.until('id: 2\n');
  assert.equal(resumedText.includes('id: 1\n'), false);
  await box.auth.revoke(box.person.token, box.two.id);
  const revoked = await resumed.until('event: error\n');
  assert.ok(revoked.includes('"code":"AUTH_REQUIRED"'));
  await first.cancel();
  await resumed.cancel();
});

test('[A4,H7] a bounded large sealed snapshot is independent of the smaller move-body limit', async (t) => {
  const box = await fixture(t);
  const document = { record: 'a'.repeat(150_000) };
  const uploaded = await box.call(box.path + '/state', { method: 'PUT', body: { sequence: 0, sealed: seal(box.key, document) } });
  assert.equal(uploaded.status, 200);
  assert.deepEqual(unseal(box.key, uploaded.body.state.sealed), document);
  const oversizeMove = await box.call(box.path + '/moves', { method: 'POST', body: { sealed: seal(box.key, document) } });
  assert.equal(oversizeMove.status, 400);
  assert.equal(oversizeMove.body.error.code, 'BAD_REQUEST');
  assert.deepEqual((await box.call(box.path + '/events?after=0')).body.events, []);
  const packageInfo = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'));
  assert.equal(packageInfo.files.some((entry) => entry === 'relay' || entry.startsWith('relay/')), false);
});
