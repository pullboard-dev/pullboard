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
function seal(key, value, binding) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(binding)));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, bytes, cipher.getAuthTag()]).toString('base64url');
}

/** Open on the test client only, proving that received ciphertext still represents the sent record. */
function unseal(key, value, binding) {
  const bytes = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13));
  assert.equal(bytes[0], 1);
  decipher.setAuthTag(bytes.subarray(-16));
  decipher.setAAD(Buffer.from(JSON.stringify(binding)));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(13, -16)), decipher.final()]).toString());
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
  /** Bind each client seal to its board, kind and proposed transport position. */
  function clientSeal(value, kind, sequence, board = id) { return seal(key, value, { board, kind, sequence }); }
  /** Unseal received records at their actual committed position, never the client's old proposal. */
  function clientOpen(value, kind, sequence, board = id) { return unseal(key, value, { board, kind, sequence }); }
  return { directory, root, data, cli, document, id, marker, auth, person, one, two, relay, origin, key, call, clientSeal, clientOpen, path: '/api/v1/boards/' + id };
}

test('[A4,H7] two clients append sealed moves in one order and no plaintext or client key reaches storage', async (t) => {
  const box = await fixture(t);
  const listed = await box.call('/api/v1/boards');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.boards, [{ id: box.id, repository: 'fixture/repository' }]);
  const initial = box.clientSeal(box.document, 'snapshot', 0);
  const uploaded = await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: initial } });
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.version, 1);
  assert.deepEqual(uploaded.body.state.sender, { kind: 'person', userId: box.person.user.id });
  assert.deepEqual(box.clientOpen(uploaded.body.state.sealed, 'snapshot', 0), box.document);
  const sent = [
    { client: 'one', title: 'PRIVATE_MOVE_FROM_CLIENT_ONE' },
    { client: 'two', title: 'PRIVATE_MOVE_FROM_CLIENT_TWO' },
  ];
  const results = await Promise.all(sent.map((move, index) => box.call(box.path + '/moves', {
    method: 'POST', token: index ? box.two.token : box.one.token, body: { sequence: 1, sealed: box.clientSeal(move, 'move', 1) },
  })));
  assert.equal(results.filter((reply) => reply.status === 200).length, 1);
  const loser = results.findIndex((reply) => reply.status === 409);
  assert.notEqual(loser, -1);
  assert.equal(results[loser].body.error.code, 'SEQUENCE_REPEAT');
  const retry = await box.call(box.path + '/moves', {
    method: 'POST', token: loser ? box.two.token : box.one.token,
    body: { sequence: 2, sealed: box.clientSeal(sent[loser], 'move', 2) },
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.event.event_id, 2);
  const read = await box.call(box.path + '/events?after=0');
  assert.deepEqual(read.body.events.map((row) => row.event_id), [1, 2]);
  assert.deepEqual(read.body.events.map((row) => box.clientOpen(row.sealed, row.kind, row.event_id)).sort((a, b) => a.client.localeCompare(b.client)), sent);
  const bytes = Buffer.concat(readdirSync(box.data).map((file) => readFileSync(join(box.data, file))));
  for (const text of [box.marker, ...sent.map((move) => move.title), box.root]) {
    assert.equal(bytes.includes(Buffer.from(text)), false, 'a known client plaintext must never occur in relay database bytes');
  }
  assert.equal(bytes.includes(box.key), false, 'the client key must never occur in relay database bytes');
  assert.deepEqual(JSON.parse(box.cli('export')), box.document, 'the complete local board remains unchanged');
});

test('[A4,H7] snapshots compact covered moves, preserve the tail and deletion removes only its database', async (t) => {
  const box = await fixture(t);
  await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: box.clientSeal(box.document, 'snapshot', 0) } });
  for (let n = 1; n <= 3; n++) {
    const reply = await box.call(box.path + '/moves', { method: 'POST', body: { sequence: n, sealed: box.clientSeal({ move: n }, 'move', n) } });
    assert.equal(reply.body.event.event_id, n);
  }
  const compacted = await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 2, sealed: box.clientSeal({ covered: 2 }, 'snapshot', 2) } });
  assert.equal(compacted.status, 200);
  assert.equal(compacted.body.state.sequence, 2);
  assert.deepEqual(box.clientOpen((await box.call(box.path + '/state')).body.state.sealed, 'snapshot', 2), { covered: 2 });
  const oldCursor = await box.call(box.path + '/events?after=0');
  assert.equal(oldCursor.status, 409);
  assert.equal(oldCursor.body.error.code, 'SNAPSHOT_REQUIRED');
  assert.deepEqual((await box.call(box.path + '/events?after=2')).body.events.map((row) => row.event_id), [3]);
  const next = await box.call(box.path + '/moves', { method: 'POST', body: { sequence: 4, sealed: box.clientSeal({ move: 4 }, 'move', 4) } });
  assert.equal(next.body.event.event_id, 4);
  const other = 'f'.repeat(32) === box.id ? 'e'.repeat(32) : 'f'.repeat(32);
  await box.auth.linkBoard(box.person.token, other, 'fixture/repository');
  const otherPath = '/api/v1/boards/' + other;
  assert.equal((await box.call(otherPath + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: box.clientSeal({ other: true }, 'snapshot', 0, other) } })).status, 200);
  assert.equal((await box.call(box.path, { method: 'DELETE', token: box.person.token })).status, 200);
  for (const suffix of ['', '-wal', '-shm']) assert.equal(existsSync(join(box.data, box.id + '.journal.sqlite' + suffix)), false);
  assert.equal((await box.call(box.path + '/state', { token: box.person.token })).status, 404);
  assert.equal((await box.call(box.path + '/state')).status, 401, 'unlink revokes board-scoped credentials');
  assert.deepEqual(box.clientOpen((await box.call(otherPath + '/state', { token: box.person.token })).body.state.sealed, 'snapshot', 0, other), { other: true });
  assert.deepEqual(JSON.parse(box.cli('export')), box.document);
});

test('[A4,H7] malformed or unauthorized calls cannot store clear records, keys or another board', async (t) => {
  const box = await fixture(t);
  assert.equal((await box.call(box.path + '/state', { token: null })).status, 401);
  const other = 'b'.repeat(32) === box.id ? 'c'.repeat(32) : 'b'.repeat(32);
  const wrong = await box.call('/api/v1/boards/' + other + '/state');
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, 'TOKEN_BOARD');
  for (const body of [{ sequence: 0, sealed: 'a' }, { sequence: 0, sealed: 'abc=' }, { sequence: 0, sealed: box.clientSeal({}, 'snapshot', 0), key: 'client key stays on device' }, { sequence: '0', sealed: box.clientSeal({}, 'snapshot', 0) }]) {
    assert.equal((await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body })).status, 400);
  }
  assert.deepEqual(readdirSync(box.data), []);
  await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: box.clientSeal(box.document, 'snapshot', 0) } });
  assert.equal((await box.call(box.path + '/moves', { method: 'POST', body: { verb: 'add', args: { title: 'clear' } } })).body.error.code, 'BAD_UPLOAD');
  const deniedCookie = await box.call(box.path + '/moves', { method: 'POST', token: null, headers: { cookie: 'pb_session=' + box.person.token, origin: 'https://foreign.example' }, body: { sequence: 1, sealed: box.clientSeal({}, 'move', 1) } });
  assert.equal(deniedCookie.status, 403);
  assert.equal(deniedCookie.body.error.code, 'BAD_ORIGIN');
  assert.equal((await box.call(box.path + '/state', { token: null, headers: { cookie: 'pb_session=' + box.person.token } })).status, 200);
  const cookieMove = await box.call(box.path + '/moves', { method: 'POST', token: null, headers: { cookie: 'pb_session=' + box.person.token, origin: 'http://127.0.0.1:44444' }, body: { sequence: 1, sealed: box.clientSeal({ cookie: true }, 'move', 1) } });
  assert.equal(cookieMove.status, 200);
  const request = await box.call(box.path + '/requests', {
    method: 'POST', body: { sequence: 2, sealed: box.clientSeal({ request: true }, 'request', 2) },
  });
  assert.equal(request.status, 200);
  assert.equal(request.body.event.kind, 'request');
  assert.deepEqual(request.body.event.sender, { kind: 'agent', userId: box.person.user.id, agent: 'client-one' });
  assert.deepEqual(box.clientOpen(request.body.event.sealed, request.body.event.kind, request.body.event.event_id), { request: true });
  assert.throws(() => box.clientOpen(request.body.event.sealed, 'move', request.body.event.event_id));

  const gap = await box.call(box.path + '/moves', {
    method: 'POST', body: { sequence: 4, sealed: box.clientSeal({ gap: true }, 'move', 4) },
  });
  assert.equal(gap.status, 409);
  assert.equal(gap.body.error.code, 'SEQUENCE_GAP');
  assert.deepEqual((await box.call(box.path + '/events?after=0')).body.events.map((row) => row.event_id), [1, 2]);
  assert.equal((await box.call(box.path + '/state', {
    token: null, headers: { cookie: 'pb_session=' + box.person.token + '; pb_session=' + box.person.token },
  })).status, 401);
  await box.auth.revoke(box.person.token, box.one.id);
  assert.equal((await box.call(box.path + '/state')).status, 401);
});

test('[A4,H2,H7,H16] trusted sender attribution exposes impersonation and agent tokens cannot erase a board', async (t) => {
  const box = await fixture(t);
  const initial = box.clientSeal(box.document, 'snapshot', 0);
  const uploaded = await box.call(box.path + '/state', {
    method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: initial },
  });
  assert.equal(uploaded.status, 200);
  const forged = { agent: 'client-two', verb: 'claim', item: 1 };
  const reply = await box.call(box.path + '/moves', {
    method: 'POST', body: { sequence: 1, sealed: box.clientSeal(forged, 'move', 1) },
  });
  assert.equal(reply.status, 200, 'the relay stores opaque bytes without reading their claimed agent');
  const expected = { kind: 'agent', userId: box.person.user.id, agent: 'client-one' };
  assert.deepEqual(reply.body.event.sender, expected, 'the sender comes from the credential, not sealed contents');
  const events = (await box.call(box.path + '/events?after=0')).body.events;
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].sender, expected, 'attribution survives the closed/reopened journal');
  const opened = box.clientOpen(events[0].sealed, events[0].kind, events[0].event_id);
  assert.notEqual(opened.agent, events[0].sender.agent, 'the client can detect impersonation before engine replay');
  assert.deepEqual(opened, forged, 'the server never rewrites or interprets the sealed move');

  const compact = await box.call(box.path + '/state', {
    method: 'PUT', body: { sequence: 1, sealed: box.clientSeal({ covered: 1 }, 'snapshot', 1) },
  });
  assert.equal(compact.status, 403);
  assert.equal(compact.body.error.code, 'HUMAN_REQUIRED');
  const deleted = await box.call(box.path, { method: 'DELETE' });
  assert.equal(deleted.status, 403);
  assert.equal(deleted.body.error.code, 'HUMAN_REQUIRED');
  assert.deepEqual((await box.call(box.path + '/state')).body.state, uploaded.body.state);
  assert.deepEqual((await box.call(box.path + '/events?after=0')).body.events, events);
  assert.ok(existsSync(join(box.data, box.id + '.journal.sqlite')));
  const personMove = await box.call(box.path + '/moves', {
    method: 'POST', token: box.person.token,
    body: { sequence: 2, sealed: box.clientSeal({ person: true }, 'move', 2) },
  });
  assert.deepEqual(personMove.body.event.sender, { kind: 'person', userId: box.person.user.id });
  assert.equal((await box.call(box.path, { method: 'DELETE', token: box.person.token })).status, 200);
});

test('[A4,H7] live streams follow the same order, resume by cursor and stop after revocation', async (t) => {
  const box = await fixture(t);
  await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: box.clientSeal(box.document, 'snapshot', 0) } });
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
  const one = await box.call(box.path + '/moves', { method: 'POST', body: { sequence: 1, sealed: box.clientSeal({ live: 1 }, 'move', 1) } });
  assert.equal(one.body.event.event_id, 1);
  const firstText = await first.until('id: 1\n');
  assert.ok(firstText.includes(JSON.stringify({ version: 1, event: one.body.event })));
  const resumed = await stream(1);
  await resumed.until(': API v1\n');
  const two = await box.call(box.path + '/moves', { method: 'POST', body: { sequence: 2, sealed: box.clientSeal({ live: 2 }, 'move', 2) } });
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
  const uploaded = await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: box.clientSeal(document, 'snapshot', 0) } });
  assert.equal(uploaded.status, 200);
  assert.deepEqual(box.clientOpen(uploaded.body.state.sealed, 'snapshot', 0), document);
  const oversizeMove = await box.call(box.path + '/moves', { method: 'POST', body: { sequence: 1, sealed: box.clientSeal(document, 'move', 1) } });
  assert.equal(oversizeMove.status, 400);
  assert.equal(oversizeMove.body.error.code, 'BAD_REQUEST');
  assert.deepEqual((await box.call(box.path + '/events?after=0')).body.events, []);
  const packageInfo = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'));
  assert.equal(packageInfo.files.some((entry) => entry === 'relay' || entry.startsWith('relay/')), false);
});
