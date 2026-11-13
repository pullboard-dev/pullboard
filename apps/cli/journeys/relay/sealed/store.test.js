/** Sealed relay storage stays opaque, ordered, bounded and attributed [A4,H7,H2,H16]. */
import { fixture } from '../../../tests/fixtures/relay/sealed.js';
import assert from 'node:assert/strict';
import { cleanupFixtureChildren } from '../../../tests/fixtures/child.js';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import {
  ENGINE_VERSION,
  VERIFIER_STANDING_ENGINE,
} from '../../../../../packages/state/index.js';

after(cleanupFixtureChildren);

test('[A4,H7] two clients append sealed moves in one order and no plaintext or client key reaches storage', async (t) => {
  const box = await fixture(t);
  const listed = await box.call('/api/v1/boards');
  assert.equal(listed.status, 200);
  const linkedAt = box.auth.linkedBoards().find(row => row.id === box.id).linkedAt;
  assert.deepEqual(listed.body.boards, [{ id: box.id, repository: 'fixture/repository', linkedAt }]);
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
  await box.auth.linkBoard(box.person.token, other, 'fixture/repository-2'); // one team board per repository [E12]
  const otherPath = '/api/v1/boards/' + other;
  assert.equal((await box.call(otherPath + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: box.clientSeal({ other: true }, 'snapshot', 0, other) } })).status, 200);
  assert.equal((await box.call(box.path, { method: 'DELETE', token: box.person.token })).status, 200);
  for (const suffix of ['', '-wal', '-shm']) assert.equal(existsSync(join(box.data, box.id + '.journal.sqlite' + suffix)), false);
  assert.equal((await box.call(box.path + '/state', { token: box.person.token })).status, 404);
  const deletedCredential = await box.call(box.path + '/state');
  assert.equal(deletedCredential.status, 410, 'a former live board credential names the deleted copy without granting access');
  assert.equal(deletedCredential.body.error.code, 'RELAY_BOARD_DELETED');
  assert.equal(deletedCredential.body.state, undefined, 'the deleted credential receives no sealed board data');
  assert.deepEqual(box.clientOpen((await box.call(otherPath + '/state', { token: box.person.token })).body.state.sealed, 'snapshot', 0, other), { other: true });
  assert.deepEqual(JSON.parse(box.cli('export')), box.document);
});

test('[A4,H7] malformed or unauthorized calls cannot store clear records, keys or another board', async (t) => {
  const box = await fixture(t);
  const initialFiles = readdirSync(box.data).sort();
  assert.equal((await box.call(box.path + '/state', { token: null })).status, 401);
  const other = 'b'.repeat(32) === box.id ? 'c'.repeat(32) : 'b'.repeat(32);
  const wrong = await box.call('/api/v1/boards/' + other + '/state');
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, 'TOKEN_BOARD');
  for (const body of [{ sequence: 0, sealed: 'a' }, { sequence: 0, sealed: 'abc=' }, { sequence: 0, sealed: box.clientSeal({}, 'snapshot', 0), key: 'client key stays on device' }, { sequence: '0', sealed: box.clientSeal({}, 'snapshot', 0) }]) {
    assert.equal((await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body })).status, 400);
  }
  assert.deepEqual(readdirSync(box.data).sort(), initialFiles, 'unauthorized or malformed input creates no board data beside pre-existing account metadata');
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
  assert.deepEqual(request.body.event.sender, { kind: 'agent', userId: box.person.user.id, agent: 'client-one', policy: VERIFIER_STANDING_ENGINE, login: box.person.user.login, engine: ENGINE_VERSION });
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
  // Each record also names the GitHub login behind it and the engine its sender declared (#343) [E3].
  const expected = { kind: 'agent', userId: box.person.user.id, agent: 'client-one', policy: VERIFIER_STANDING_ENGINE, login: box.person.user.login, engine: ENGINE_VERSION };
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
  assert.deepEqual(personMove.body.event.sender, { kind: 'person', userId: box.person.user.id, policy: VERIFIER_STANDING_ENGINE, login: box.person.user.login, engine: ENGINE_VERSION });
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
      headers: { 'x-pullboard-engine': String(ENGINE_VERSION), authorization: 'Bearer ' + box.two.token, accept: 'text/event-stream', ...(last === null ? {} : { 'last-event-id': String(last) }) },
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
  const packageInfo = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../package.json'), 'utf8'));
  assert.equal(packageInfo.files.some((entry) => entry === 'relay' || entry.startsWith('relay/')), false);
});
