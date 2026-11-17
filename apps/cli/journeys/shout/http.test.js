/** @pullboard-test-input apps/cli/pullboard.js */
import {
  viewApiPorts,
} from '../../../view/index.js';
import {
  apiBoardOpeners,
} from '../../tests/fixtures/board.js';
import assert from 'node:assert/strict';
import {
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  runFixtureGit,
  startFixtureChild,
} from '../../tests/fixtures/child.js';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  spawn,
} from 'node:child_process';
import {
  createServer,
  request as httpRequest,
} from 'node:http';
import {
  join,
  resolve,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  createLocalApiHandler,
  serveApi,
} from '../../../../packages/api/index.js';
import {
  refusalDocument,
} from '../../index.js';
import {
  main,
} from '../../tests/fixtures/native.js';
import {
  createApiHandler,
} from '../../../../packages/api/index.js';
import {
  registryFile,
  registerProject,
} from '../../../../packages/seats/index.js';
import {
  Refused,
} from '../../../../packages/kernel/light.js';
import {
  board as store,
} from '../../../lib/index.js';
import {
  preparePersonRequest,
} from '../../../../packages/person/light.js';
import {
  receivePersonRequest,
} from '../../../../packages/link/index.js';
import {
  apiHttpBox as httpBox,
} from '../../tests/fixtures/api.js';
import {
  fetchFresh,
} from '../../tests/fixtures/http.js';
import {
  fixture,
  viewHttpBox,
} from '../../tests/fixtures/http/view-box.js';
const BIN = resolve(import.meta.dirname, '../../pullboard.js');

test('[A2] a stale registered folder does not hide another readable board', async (t) => {
  const box = await httpBox(t, { includeMissing: true });
  const listed = await box.call('/api/v1/boards');
  assert.equal(listed.document.boards.length, 1);
  assert.equal(listed.document.warnings.length, 1);
  assert.equal(listed.document.warnings[0].name, 'Missing fixture');
  assert.equal(listed.document.warnings[0].error.version, 1);
  assert.equal(listed.document.warnings[0].error.error.code, 'BOARD_UNAVAILABLE');
  assert.match(listed.document.warnings[0].error.error.next, /pullboard forget/);
  const state = await box.call(box.path + '/state');
  assert.equal(state.status, 200);
  assert.equal(state.document.state.board, box.id);
});

test('[A2, N26] a person request receipt refreshes cached state without an event', async (t) => {
  let builds = 0;
  const box = await httpBox(t, { onStateBuild: () => { builds += 1; } });
  const first = await box.call(box.path + '/state');
  assert.equal(first.status, 200);
  assert.equal(builds, 1);

  const board = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  let eventCountBefore;
  let eventCountAfter;
  try {
    eventCountBefore = board.db.prepare('SELECT COUNT(*) AS count FROM event').get().count;
    const document = preparePersonRequest({ verb: 'add', args: { lane: 'app', title: 'Private receipt fixture' } }, 'cache-receipt-1');
    assert.equal(receivePersonRequest(board, document, {
      sequence: 1, at: new Date().toISOString(), sender: { kind: 'person', userId: 'private-fixture-person' },
    }).status, 'waiting');
    eventCountAfter = board.db.prepare('SELECT COUNT(*) AS count FROM event').get().count;
  } finally { store.closeBoard(board); }
  assert.equal(eventCountAfter, eventCountBefore, 'ordinary person request receipt intake writes no board event');

  const refreshed = await box.call(box.path + '/state');
  assert.ok(refreshed.document.state.personRequests.some((request) => request.id === 'cache-receipt-1'),
    'the next state response includes the receipt received after the previous cache fill');
  assert.equal(builds, 2, 'request-receipt metadata invalidates the state snapshot');
});

test('[A2] local HTTP state accepts a safe seen cursor and committed code previews', async (t) => {
  const box = await httpBox(t);
  await box.cliLocal(box.root, 'shout', 'app', 'state cursor baseline');
  const before = await box.call(box.path + '/state');
  const seen = before.document.state.shouts.at(-1).shout_id;
  await box.cliLocal(box.root, 'shout', 'app', 'state cursor event');
  const state = await box.call(box.path + '/state?seen=' + seen);
  assert.equal(state.document.state.unseen.since, seen);
  assert.equal(state.document.state.unseen.count, 1);
  const missing = await box.call(box.path + '/state');
  assert.equal(missing.document.state.unseen, null);
  for (const cursor of ['', '-1', '1.5', '9007199254740992']) {
    const invalid = await box.call(box.path + '/state?seen=' + cursor);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.document.error.code, 'BAD_CURSOR');
  }

  writeFileSync(join(box.root, 'SPEC.md'), '# changed working tree\n');
  const preview = await box.call(box.path + '/code?ref=' + encodeURIComponent('SPEC.md:1-4@' + box.commit) + '&before=' + encodeURIComponent('Please inspect '));
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.document.code.lines, ['# HTTP fixture', '', '## Goals', '- G1 [approved, must] Keep the board. | gate: true']);
  assert.equal(preview.document.code.path, 'SPEC.md');
  assert.equal(preview.document.code.from, 1);
  assert.equal(preview.document.code.to, 4);
  for (const ref of ['../outside:1@' + box.commit, 'SPEC.md:0@' + box.commit, 'SPEC.md:1@HEAD']) {
    const invalid = await box.call(box.path + '/code?ref=' + encodeURIComponent(ref));
    assert.equal(invalid.status, 400);
    assert.ok(['BAD_REF', 'NO_COMMIT'].includes(invalid.document.error.code));
  }
});

test('[A2, N33, N35] API listing refreshes live labels and preserves unreadable-entry warnings', async (t) => {
  const box = fixture(t);
  const priorHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  t.after(() => { if (priorHome === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = priorHome; });
  const second = join(box.dir, 'second-repo');
  mkdirSync(second);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: second, env: box.env, stdio: 'pipe' });
  await box.cliLocal(second, 'init');
  const secondConfigFile = join(second, 'pullboard.json');
  const secondConfig = JSON.parse(readFileSync(secondConfigFile, 'utf8'));
  writeFileSync(secondConfigFile, JSON.stringify({ ...secondConfig, name: 'Saved second', project: 'Saved group' }));
  registerProject(second, new Date('2026-02-03T04:05:06.000Z'));

  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main });
  t.after(() => api.close());
  const url = new URL(api.url);
  const key = url.searchParams.get('k');
  /** Fetch the authenticated board catalog through the real local HTTP server. */
  async function listing() {
    const response = await fetchFresh(url.origin + '/api/v1/boards', { headers: { 'x-pullboard-key': key } });
    assert.equal(response.status, 200);
    return response.json();
  }

  const initial = await listing();
  assert.deepEqual(initial.boards.map((entry) => entry.root), [box.root, second]);
  assert.deepEqual(initial.warnings, []);
  const firstId = initial.boards[0].id;
  const firstAdded = initial.boards[0].added;
  const secondId = initial.boards[1].id;
  const secondAdded = initial.boards[1].added;
  const configFile = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, name: 'Fresh first', project: 'Fresh group' }));

  const refreshedBoth = await listing();
  assert.deepEqual(refreshedBoth.boards.map(({ root }) => root), [box.root, second]);
  assert.deepEqual(refreshedBoth.boards.map(({ id }) => id), [firstId, secondId]);
  assert.deepEqual(refreshedBoth.boards.map(({ added }) => added), [firstAdded, secondAdded]);
  assert.deepEqual(refreshedBoth.boards.map(({ name, project }) => ({ name, project })), [
    { name: 'Fresh first', project: 'Fresh group' },
    { name: 'Saved second', project: 'Saved group' },
  ]);
  rmSync(join(second, '.git'), { recursive: true, force: true });

  const refreshed = await listing();
  assert.deepEqual(refreshed.boards.map(({ root, name, project }) => ({ root, name, project })), [
    { root: box.root, name: 'Fresh first', project: 'Fresh group' },
  ]);
  assert.equal(refreshed.boards[0].id, firstId);
  assert.equal(refreshed.boards[0].added, firstAdded);
  assert.equal(refreshed.warnings.length, 1);
  assert.equal(refreshed.warnings[0].root, second);
  assert.equal(refreshed.warnings[0].name, 'Saved second');
  assert.equal(refreshed.warnings[0].project, 'Saved group');
  assert.equal(refreshed.warnings[0].added, secondAdded);
  assert.equal(refreshed.warnings[0].error.version, 1);
  assert.equal(refreshed.warnings[0].error.error.code, 'BOARD_UNAVAILABLE');
  assert.match(refreshed.warnings[0].error.error.next, /pullboard forget/);
  assert.deepEqual(JSON.parse(readFileSync(registryFile(), 'utf8')).projects.map(({ root }) => root), [box.root, second]);

  const forgotten = await box.cliLocal(box.root, 'forget', box.root);
  assert.equal(forgotten.root, box.root);
  assert.deepEqual(JSON.parse(readFileSync(registryFile(), 'utf8')).projects.map(({ root }) => root), [second]);
  const afterForget = await listing();
  assert.deepEqual(afterForget.boards, []);
  assert.deepEqual(afterForget.warnings.map(({ root }) => root), [second]);
});

test('[A2,N39] the view cookie check catches a weakened compare', async (t) => {
  const box = fixture(t);
  const secret = randomUUID();
  const sessionCookie = {
    name: `pullboard_view_${randomUUID().replaceAll('-', '')}`,
    value: randomBytes(24).toString('base64url'),
  };
  assert.throws(() => createLocalApiHandler({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument,
    secret,
    getPort: () => 1,
    runCommand: main,
    projects: () => [],
    sessionCookie: { name: sessionCookie.name, value: randomBytes(8).toString('base64url') },
  }), /at least 128 bits/u, 'session cookies need capacity for at least 128 random bits');
  let bound;
  const handler = createLocalApiHandler({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument,
    secret,
    getPort: () => bound,
    runCommand: main,
    projects: () => [{ root: box.root, name: 'Cookie fixture' }],
    personChannel: 'api',
    sessionCookie,
  });
  const server = createServer(handler);
  await new Promise((ready, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => { bound = server.address().port; ready(); });
  });
  t.after(() => new Promise((closed) => server.close(closed)));
  const origin = `http://127.0.0.1:${bound}`;
  const otherPortServer = createServer();
  await new Promise((ready, fail) => {
    otherPortServer.once('error', fail);
    otherPortServer.listen(0, '127.0.0.1', ready);
  });
  const otherLocalOrigin = `http://127.0.0.1:${otherPortServer.address().port}`;
  t.after(() => new Promise((closed) => otherPortServer.close(closed)));
  assert.notEqual(otherLocalOrigin, origin, 'the hostile same-site page uses a different localhost port');
  const cookie = `${sessionCookie.name}=${sessionCookie.value}`;
  /** Send one real HTTP request to the private API handler. */
  const request = (path, headers = {}, init = {}) => fetchFresh(origin + path, {
    ...init,
    headers: { ...headers, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  /** Decode the handler's versioned refusal and check its authentication result. */
  async function refused(response, status, code = 'AUTH_REQUIRED') {
    assert.equal(response.status, status);
    const document = await response.json();
    assert.equal(document.version, 1);
    assert.equal(document.error.code, code);
  }

  const cookieListing = await request('/api/v1/boards', { cookie, 'sec-fetch-site': 'same-origin' });
  assert.equal(cookieListing.status, 200, 'the current view cookie authenticates the actual local API');
  const listing = await cookieListing.json();
  assert.equal(listing.version, 1);
  const board = listing.boards.find((entry) => resolve(entry.root) === resolve(box.root));
  assert.ok(board, 'the private Git fixture is listed through cookie authentication');
  const state = await request(`/api/v1/boards/${board.id}/state`, { cookie });
  assert.equal(state.status, 200, 'cookie-authenticated state reads the fixture SQLite board');

  const sameOriginFallback = await request('/api/v1/boards', { cookie });
  assert.equal(sameOriginFallback.status, 200, 'without Fetch-Site, the existing own Host/Origin checks still allow the cookie');
  await refused(await request('/api/v1/boards'), 401, 'AUTH_REQUIRED');
  await refused(await request('/api/v1/boards', { cookie: `${sessionCookie.name}=${'x'.repeat(sessionCookie.value.length)}` }), 401, 'AUTH_REQUIRED');
  const caseChangedName = `${sessionCookie.name[0].toUpperCase()}${sessionCookie.name.slice(1)}`;
  assert.notEqual(caseChangedName, sessionCookie.name);
  await refused(await request('/api/v1/boards', { cookie: `${caseChangedName}=${sessionCookie.value}` }), 401, 'AUTH_REQUIRED');
  await refused(await request('/api/v1/boards', { cookie: `${sessionCookie.name}=expired-session-value` }), 401, 'AUTH_REQUIRED');
  await refused(await request('/api/v1/boards', { cookie: `${cookie}; ${cookie}` }), 401, 'AUTH_REQUIRED');
  await refused(await request('/api/v1/boards', { cookie: `${sessionCookie.name}=wrong-cookie-value; ${cookie}` }), 401, 'AUTH_REQUIRED');
  await refused(await request('/api/v1/boards', { cookie: `${sessionCookie.name}; ${cookie}` }), 401, 'AUTH_REQUIRED');
  const staleName = `${sessionCookie.name}_old`;
  await refused(await request('/api/v1/boards', { cookie: `${staleName}=${sessionCookie.value}` }), 401, 'AUTH_REQUIRED');
  await refused(await request('/api/v1/boards', { cookie, 'sec-fetch-site': 'same-site' }), 401, 'AUTH_REQUIRED');
  await refused(await request('/api/v1/boards', { cookie, origin: otherLocalOrigin, 'sec-fetch-site': 'same-site' }), 401, 'AUTH_REQUIRED');
  await refused(await request(`/api/v1/boards/${board.id}/moves`, {
    cookie, 'sec-fetch-site': 'same-site',
  }, { method: 'POST', body: { verb: 'next', args: {} } }), 401, 'AUTH_REQUIRED');
  await refused(await request(`/api/v1/boards/${board.id}/moves`, {
    cookie, origin: otherLocalOrigin, 'sec-fetch-site': 'same-site',
  }, { method: 'POST', body: { verb: 'next', args: {} } }), 401, 'AUTH_REQUIRED');

  const foreignHost = await new Promise((done, reject) => {
    const outbound = httpRequest(origin + '/api/v1/boards', { headers: { host: 'foreign.invalid', cookie } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => done({ status: response.statusCode, document: JSON.parse(text) }));
    });
    outbound.once('error', reject);
    outbound.end();
  });
  assert.equal(foreignHost.status, 401, 'a valid cookie cannot cross the API host boundary');
  assert.equal(foreignHost.document.error.code, 'AUTH_REQUIRED');
  await refused(await request('/api/v1/boards', { cookie, origin: 'https://foreign.invalid' }), 403, 'API_ORIGIN');
  await refused(await request(`/api/v1/boards/${board.id}/moves`, { cookie, origin: 'https://foreign.invalid' }, {
    method: 'POST', body: { verb: 'next', args: {} },
  }), 403, 'API_ORIGIN');

  const keyHeader = await request('/api/v1/boards', { 'x-pullboard-key': secret, 'sec-fetch-site': 'cross-site' });
  assert.equal(keyHeader.status, 200, 'the existing key header remains valid');
  const bearer = await request('/api/v1/boards', { authorization: `Bearer ${secret}` });
  assert.equal(bearer.status, 200, 'the existing Bearer key remains valid');
  const queryKey = await request(`/api/v1/boards?k=${encodeURIComponent(secret)}`);
  assert.equal(queryKey.status, 200, 'the existing query key remains valid');
  const badCookieWithKey = await request('/api/v1/boards', { cookie: `${sessionCookie.name}=wrong-cookie-value`, 'x-pullboard-key': secret });
  assert.equal(badCookieWithKey.status, 200, 'a bad cookie does not override a valid key');

  const personMove = await request(`/api/v1/boards/${board.id}/moves`, { cookie }, {
    method: 'POST', body: { verb: 'next', args: { as: 'person' } },
  });
  await refused(personMove, 409, 'B26_PERSON_CHANNEL');
});

test('[A2] local auth, origin, unknown board and malformed calls refuse without moving', async (t) => {
  const box = await httpBox(t);
  const unauthenticated = await fetchFresh(box.origin + '/api/v1/boards');
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).error.code, 'AUTH_REQUIRED');
  const badSecret = await box.call('/api/v1/boards', undefined, { 'x-pullboard-key': 'incorrect-private-fixture-key' });
  assert.equal(badSecret.status, 401);
  const badOrigin = await box.call(box.path + '/requests', { text: 'blocked' }, { origin: 'https://different.invalid' });
  assert.equal(badOrigin.status, 403);
  const unknown = await box.call('/api/v1/boards/' + '0'.repeat(32) + '/state');
  assert.equal(unknown.status, 404);
  const unknownStream = await box.call('/api/v1/boards/' + '0'.repeat(32) + '/events', undefined, { accept: 'text/event-stream' });
  assert.equal(unknownStream.status, 404);
  const malformed = await fetchFresh(box.origin + box.path + '/moves', { method: 'POST', headers: { 'x-pullboard-key': box.key, 'content-type': 'application/json' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'BAD_REQUEST');
  const unsupported = await box.call(box.path + '/moves', { verb: 'run', args: { agent: 'unsafe' } });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.document.error.code, 'BAD_REQUEST');
  const state = await box.call(box.path + '/state');
  assert.deepEqual(state.document.state.items, []);
  assert.deepEqual(state.document.state.requests, []);
});

test('[A2] move text stays literal and invalid bodies cannot produce a partial event', async (t) => {
  const box = await httpBox(t);
  const literal = await box.call(box.path + '/moves', { verb: 'shout', args: { to: 'app', text: '--help' } });
  assert.equal(literal.status, 200);
  assert.equal(literal.document.event.event_kind, 'shout');
  const state = await box.call(box.path + '/state');
  assert.equal(state.document.state.shouts.at(-1).shout_text, '--help');
  const oversized = await box.call(box.path + '/requests', { text: 'x'.repeat(110_000) });
  assert.equal(oversized.status, 400);
  assert.equal(oversized.document.error.code, 'BAD_REQUEST');
  const wrongType = await box.call(box.path + '/requests', { text: 'refused' }, { 'content-type': 'text/plain' });
  assert.equal(wrongType.status, 400);
  const wrongHost = await new Promise((done, reject) => {
    const request = httpRequest(box.origin + '/api/v1/boards', { headers: { host: 'foreign.invalid', 'x-pullboard-key': box.key } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => done({ status: response.statusCode, document: JSON.parse(text) }));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(wrongHost.status, 401);
  assert.equal(wrongHost.document.error.code, 'AUTH_REQUIRED');
  const after = await box.call(box.path + '/state');
  assert.deepEqual(after.document.state.events, state.document.state.events);
  assert.deepEqual(after.document.state.requests, []);
});

test('[A2] shared transport stops a live stream when its caller loses access', async (t) => {
  const box = fixture(t);
  const file = join(box.root, '.git', 'pullboard', 'board.sqlite');
  let authorized = true;
  let checks = 0;
  /** Read this fixture's real event records and always close its connection. */
  function records(after = 0) {
    const board = store.openBoard(file);
    try { return store.events(board).filter((event) => event.event_id > after); }
    finally { store.closeBoard(board); }
  }
  const board = store.openBoard(file);
  const id = store.boardId(board);
  store.closeBoard(board);
  const handler = createApiHandler({ refusalDocument,
    authenticate: () => {
      checks += 1;
      if (!authorized) throw new Refused('AUTH_REQUIRED', 'the fixture session was revoked; sign in again');
      return { user: 'fixture-user' };
    },
    board: () => ({ id }),
    events: (known, after) => records(after),
  }, { pollMs: 20 });
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const timeout = setTimeout(() => controller.abort(), 10_000);
  t.after(() => clearTimeout(timeout));
  const response = await fetchFresh('http://127.0.0.1:' + server.address().port + '/api/v1/boards/' + id + '/events?after=' + records().at(-1).event_id, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  authorized = false;
  await box.cliLocal(box.root, 'add', 'app', 'Hidden after revocation', '--criterion', 'complete', '--specs', 'G1');
  let text = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  assert.match(text, /event: error/);
  assert.match(text, /"version":1/);
  assert.match(text, /"code":"AUTH_REQUIRED"/);
  assert.doesNotMatch(text, /"event_kind":"add"/);
  assert.ok(checks >= 3, 'access is checked at entry and on live polls');
});

test('[A2] adapters without a committed-code capability return a versioned refusal', async (t) => {
  const handler = createApiHandler({ refusalDocument,
    authenticate: () => ({ user: 'fixture-user' }),
    boards: () => [],
    board: (id) => ({ id }),
    state: () => ({}),
    events: () => [],
  });
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { handler.close(); server.close(done); }));
  const id = 'fixture-board';
  const response = await fetchFresh('http://127.0.0.1:' + server.address().port + '/api/v1/boards/' + id + '/code?ref=secret.txt%3A1%40abcdef0');
  const document = await response.json();
  assert.equal(response.status, 400);
  assert.equal(document.version, 1);
  assert.equal(document.error.code, 'CODE_NOT_AVAILABLE');
  assert.match(document.error.next, /local view|local API/);
  const noDelta = await fetchFresh('http://127.0.0.1:' + server.address().port + '/api/v1/boards/' + id + '/state?since=1');
  assert.equal(noDelta.status, 400);
  assert.equal((await noDelta.json()).error.code, 'DELTA_NOT_AVAILABLE', 'an adapter whose state carries full items offers no deltas');
  for (const path of ['/items/1', '/items?q=anything']) {
    const unavailable = await fetchFresh('http://127.0.0.1:' + server.address().port + '/api/v1/boards/' + id + path);
    assert.equal(unavailable.status, 400);
    assert.equal((await unavailable.json()).error.code, 'ITEM_NOT_AVAILABLE', 'an adapter whose state carries full items offers no item reads');
  }
});

test('[A2, N26] state JSON fragments preserve the API envelope and legacy adapter fallback', async (t) => {
  const state = { board: 'fixture', label: 'a ",\\"injected\\":true', unseen: null };
  const handler = createApiHandler({ refusalDocument,
    authenticate: () => ({ user: 'fixture-user' }),
    board: (id) => ({ id }),
    stateJson: (_board, _who, seen) => seen === 1 ? state : JSON.stringify(state),
    eventLogVersion: () => 'v1',
  });
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  const response = await fetchFresh('http://127.0.0.1:' + server.address().port + '/api/v1/boards/fixture/state');
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(text), { version: 1, state, eventLogVersion: 'v1' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('etag'), null);
  const invalidSerializer = await fetchFresh('http://127.0.0.1:' + server.address().port + '/api/v1/boards/fixture/state?seen=1');
  assert.equal(invalidSerializer.status, 500);
  assert.equal((await invalidSerializer.json()).error.code, 'SERVICE_ERROR');

  const legacy = createApiHandler({ refusalDocument,
    authenticate: () => ({ user: 'fixture-user' }),
    board: (id) => ({ id }),
    state: () => state,
  });
  const legacyServer = createServer(legacy);
  await new Promise((done) => legacyServer.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { legacy.close(); legacyServer.close(done); legacyServer.closeIdleConnections(); }));
  const legacyResponse = await fetchFresh('http://127.0.0.1:' + legacyServer.address().port + '/api/v1/boards/fixture/state');
  assert.deepEqual(await legacyResponse.json(), { version: 1, state });
  assert.equal(legacyResponse.headers.get('cache-control'), 'no-store');
  assert.equal(legacyResponse.headers.get('etag'), null);
});

test("a request through serve is never the person's [P6,B26,A2]", { timeout: 60_000 }, // budget: private CLI/API startup and request-channel checks, not a throughput claim.
async (t) => {
  const box = fixture(t);
  // Stays a process: a long-lived serve child whose request channel and shutdown signal are under test.
  const child = startFixtureChild(process.execPath, [BIN, 'serve', '--port', '0', '--json'], {
    cwd: box.root, env: { ...box.env, CLAUDECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise(resolveClosed => child.once('close', resolveClosed));
  let stopped = false;
  /** Stop only the private server and await its terminal close before deleting its fixture. */
  async function stopServer() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let timer;
    try {
      const ended = await Promise.race([closed.then(() => true), new Promise(resolveWait => { timer = setTimeout(() => resolveWait(false), 2000); })]); // budget: owned fixture server TERM grace before its bounded KILL fallback.
      if (!ended) { child.kill('SIGKILL'); await closed; }
    } finally { clearTimeout(timer); }
  }
  t.after(stopServer);
  const served = await new Promise((resolveAddress, rejectAddress) => {
    let output = '';
    const timer = setTimeout(() => rejectAddress(new Error('private agent serve did not announce its address')), 20_000); // budget: private CLI address startup ceiling.
    child.once('exit', () => { clearTimeout(timer); rejectAddress(new Error('private agent serve exited before its address')); });
    child.stdout.on('data', chunk => {
      output += chunk;
      try {
        const document = JSON.parse(output);
        if (typeof document.url === 'string') { clearTimeout(timer); resolveAddress(new URL(document.url)); }
      } catch { /* Wait for the complete private JSON announcement, never print its key. */ }
    });
  });
  const headers = { 'x-pullboard-key': served.searchParams.get('k'), 'content-type': 'application/json' };
  const listing = await (await fetchFresh(served.origin + '/api/v1/boards', { headers })).json();
  const id = listing.boards.find(board => resolve(board.root) === resolve(box.root)).id;
  const path = '/api/v1/boards/' + id;
  const before = (await box.cliLocal(box.root, 'log')).events.length;
  const refused = await fetchFresh(served.origin + path + '/requests', {
    method: 'POST', headers, body: JSON.stringify({ text: 'Please review this private fixture.' }),
  });
  assert.equal((await refused.json()).error?.code, 'B26_PERSON_CHANNEL');
  assert.notEqual(refused.status, 200);
  assert.equal((await box.cliLocal(box.root, 'log')).events.length, before, 'a standalone serve request adds no event');
  await stopServer();
  const view = await viewHttpBox(t, box);
  const requested = await view.call(view.path + '/requests', { text: 'Please review this from the actual view.' });
  assert.equal(requested.status, 200, "the actual view keeps the person's request channel");
  assert.equal(requested.document.event.event_by, 'person');
  assert.equal((await box.cliLocal(box.root, 'log')).events.length, before + 1);
});
