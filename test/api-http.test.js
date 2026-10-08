/** Real HTTP calls against an isolated Git repo and the actual board engine (A2). */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { serveApi } from '../src/api.js';
import { main } from '../src/cli.js';
import { createApiHandler } from '../src/api-http.js';
import { registryFile, registerProject } from '../src/projects.js';
import { Refused } from '../src/refused.js';
import * as store from '../src/board.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');

/** Quote an executable path literally for the fixture's source-bin hook shim. */
function shellWord(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Create a private, committed project, with an exact-build hook shim and no personal Git config. */
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-http-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(root);
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = {
    ...process.env, HOME: join(dir, 'home'), PULLBOARD_HOME: join(dir, 'home'),
    PATH: bin + ':' + process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'HTTP Agent', GIT_AUTHOR_EMAIL: 'agent@example.invalid',
    GIT_COMMITTER_NAME: 'HTTP Agent', GIT_COMMITTER_EMAIL: 'agent@example.invalid',
  };
  mkdirSync(env.HOME);
  /** Run Git only inside the private fixture. */
  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe', encoding: 'utf8' });
  /** Exercise this worktree's real CLI with a private environment. */
  const run = (cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  /** Decode one successful versioned CLI invocation without printing session links. */
  function cli(cwd, ...args) {
    const result = run(cwd, ...args, '--json');
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  git('init', '-q', '-b', 'main');
  cli(root, 'init');
  const config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ ...config, gate: 'true', lanes: { app: { owns: ['app/'] }, review: { owns: [] } } }));
  writeFileSync(join(root, 'SPEC.md'), '# HTTP fixture\n\n## Goals\n- G1 [approved, must] Keep the board. | gate: true\n');
  writeFileSync(join(root, 'DOCTRINE.md'), '');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: private HTTP fixture');
  return { root, dir, env, cli, run, commit: git('rev-parse', 'HEAD').trim() };
}

/** Serve this fixture's explicit project, avoiding any registry outside its private home. */
async function httpBox(t, { includeMissing = false } = {}) {
  const box = fixture(t);
  const api = await serveApi({ runCommand: main, projects: () => [...(includeMissing ? [{ root: join(box.dir, 'gone'), name: 'Missing fixture' }] : []), { root: box.root, name: 'HTTP fixture' }] });
  t.after(() => api.close());
  const url = new URL(api.url);
  const key = url.searchParams.get('k');
  const origin = url.origin;
  /** Make a real HTTP call and decode its single versioned response. */
  async function call(path, value, headers = {}) {
    const response = await fetch(origin + path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { 'x-pullboard-key': key, ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const document = await response.json();
    assert.equal(document.version, 1);
    return { status: response.status, document };
  }
  const listed = await call('/api/v1/boards');
  assert.equal(listed.status, 200);
  assert.equal(listed.document.boards.length, 1);
  const id = listed.document.boards[0].id;
  assert.match(id, /^[0-9a-f]{32}$/);
  return { ...box, api, origin, key, id, call, path: '/api/v1/boards/' + id };
}

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

test('[A2] local HTTP state accepts a safe seen cursor and committed code previews', async (t) => {
  const box = await httpBox(t);
  box.cli(box.root, 'shout', 'app', 'state cursor baseline');
  const before = await box.call(box.path + '/state');
  const seen = before.document.state.shouts.at(-1).shout_id;
  box.cli(box.root, 'shout', 'app', 'state cursor event');
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

test('[A2, N33, N35] API listing refreshes live labels and preserves missing-entry warnings', async (t) => {
  const box = fixture(t);
  const priorHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  t.after(() => { if (priorHome === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = priorHome; });
  const second = join(box.dir, 'second-repo');
  mkdirSync(second);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: second, env: box.env, stdio: 'pipe' });
  box.cli(second, 'init');
  const secondConfigFile = join(second, 'pullboard.json');
  const secondConfig = JSON.parse(readFileSync(secondConfigFile, 'utf8'));
  writeFileSync(secondConfigFile, JSON.stringify({ ...secondConfig, name: 'Saved second', project: 'Saved group' }));
  registerProject(second, new Date('2026-02-03T04:05:06.000Z'));

  const api = await serveApi({ runCommand: main });
  t.after(() => api.close());
  const url = new URL(api.url);
  const key = url.searchParams.get('k');
  /** Fetch the authenticated board catalog through the real local HTTP server. */
  async function listing() {
    const response = await fetch(url.origin + '/api/v1/boards', { headers: { 'x-pullboard-key': key } });
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
  rmSync(second, { recursive: true, force: true });

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

  const forgotten = box.cli(box.root, 'forget', box.root);
  assert.equal(forgotten.root, box.root);
  assert.deepEqual(JSON.parse(readFileSync(registryFile(), 'utf8')).projects.map(({ root }) => root), [second]);
  const afterForget = await listing();
  assert.deepEqual(afterForget.boards, []);
  assert.deepEqual(afterForget.warnings.map(({ root }) => root), [second]);
});

test('[A2] real HTTP state, moves and refusals use the CLI and exact committed events', async (t) => {
  const box = await httpBox(t);
  const one = box.cli(box.root, 'worktree', 'app');
  const two = box.cli(box.root, 'worktree', 'app');
  const added = await box.call(box.path + '/moves', { verb: 'add', args: { lane: 'app', title: 'HTTP item', criterion: 'complete', specs: 'G1' } });
  assert.equal(added.status, 200);
  assert.equal(added.document.event.event_kind, 'add');
  const id = added.document.result.item.item_id;
  const claimed = await box.call(box.path + '/moves', { verb: 'claim', item: id, agent: one.agent });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.document.event.event_by, one.agent);
  assert.equal(claimed.document.event.event_kind, 'claim');
  const refused = await box.call(box.path + '/moves', { verb: 'claim', item: id, agent: two.agent });
  const terminal = box.run(two.path, 'claim', String(id), '--json');
  assert.equal(refused.status, 409);
  assert.equal(terminal.status, 1);
  assert.equal(refused.document.error.code, JSON.parse(terminal.stdout).error.code);
  assert.deepEqual(refused.document.error, JSON.parse(terminal.stdout).error, 'the original CLI refusal keeps its message and next step');
  const state = await box.call(box.path + '/state');
  assert.equal(state.document.state.board, box.id);
  assert.equal(state.document.state.items.find((item) => item.id === id).owner, one.agent);
  const events = await box.call(box.path + '/events?after=' + added.document.event.event_id);
  assert.deepEqual(events.document.events, [claimed.document.event]);
  const badAgent = await box.call(box.path + '/moves', { verb: 'release', item: id, agent: 'absent-agent' });
  assert.equal(badAgent.status, 409);
  assert.equal(badAgent.document.error.code, 'NO_AGENT');
});

test('[A2, H12, R2] requests and shouts append events and requests stay outside decisions', async (t) => {
  const box = await httpBox(t);
  const requested = await box.call(box.path + '/requests', { text: 'Please approve the fixture row.' });
  assert.equal(requested.status, 200);
  assert.equal(requested.document.result.request, true);


  assert.equal(requested.document.event.event_kind, 'shout');
  const shout = await box.call(box.path + '/moves', { verb: 'shout', args: { to: 'app', text: 'new work' } });
  assert.equal(shout.document.event.event_kind, 'shout');
  const state = await box.call(box.path + '/state');
  assert.equal(state.document.state.requests.length, 1);
  assert.equal(state.document.state.decisions.length, 0);
  const premature = await box.call(box.path + '/moves', { verb: 'answer', item: requested.document.result.id, args: { text: 'I am working on it' } });
  assert.equal(premature.status, 409);
  assert.equal(premature.document.error.code, 'REQUEST_OUTCOME');
  assert.equal((await box.call(box.path + '/state')).document.state.requests.length, 1);
  const answer = await box.call(box.path + '/moves', { verb: 'answer', item: requested.document.result.id, args: { text: 'done checked and recorded' } });
  assert.equal(answer.status, 200);
  assert.equal(answer.document.event.event_kind, 'answer');
  assert.equal((await box.call(box.path + '/state')).document.state.requests.length, 0);
});

test('[A2] a live HTTP stream follows CLI writes and reconnects after Last-Event-ID', async (t) => {
  const box = await httpBox(t);
  const initial = await box.call(box.path + '/events');
  const after = initial.document.events.at(-1).event_id;
  const controller = new AbortController();
  const response = await fetch(box.origin + box.path + '/events?after=' + after, { headers: { 'x-pullboard-key': box.key, accept: 'text/event-stream' }, signal: controller.signal });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  let buffered = '';
  /** Read a complete live event with a bounded timeout. */
  async function frame() {
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      while (!/\ndata: .+\n\n/.test(buffered)) {
        const { value, done } = await reader.read();
        assert.equal(done, false, 'stream stays open until its event arrives');
        buffered += new TextDecoder().decode(value);
      }
      const match = /id: (\d+)\ndata: (.+)\n\n/.exec(buffered);
      assert.ok(match);
      buffered = buffered.slice(match.index + match[0].length);
      return { id: Number(match[1]), document: JSON.parse(match[2]) };
    } finally { clearTimeout(timeout); }
  }
  const added = box.cli(box.root, 'add', 'app', 'Terminal event', '--criterion', 'done', '--specs', 'G1');
  const live = await frame();
  assert.equal(live.document.version, 1);
  assert.equal(live.document.event.event_kind, 'add');
  assert.equal(live.document.event.item_id, added.item.item_id);
  assert.equal(live.id, live.document.event.event_id);
  await reader.cancel();
  controller.abort();
  const replay = await fetch(box.origin + box.path + '/events?after=0', { headers: { 'x-pullboard-key': box.key, 'last-event-id': String(live.id) } });
  assert.deepEqual((await replay.json()).events, []);
  const invalid = await box.call(box.path + '/events?after=1.5');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.document.error.code, 'BAD_CURSOR');
});

test('[A2] local auth, origin, unknown board and malformed calls refuse without moving', async (t) => {
  const box = await httpBox(t);
  const unauthenticated = await fetch(box.origin + '/api/v1/boards');
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
  const malformed = await fetch(box.origin + box.path + '/moves', { method: 'POST', headers: { 'x-pullboard-key': box.key, 'content-type': 'application/json' }, body: '{broken' });
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
  const handler = createApiHandler({
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
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1/boards/' + id + '/events?after=' + records().at(-1).event_id, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  authorized = false;
  box.cli(box.root, 'add', 'app', 'Hidden after revocation', '--criterion', 'complete', '--specs', 'G1');
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
  const handler = createApiHandler({
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
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1/boards/' + id + '/code?ref=secret.txt%3A1%40abcdef0');
  const document = await response.json();
  assert.equal(response.status, 400);
  assert.equal(document.version, 1);
  assert.equal(document.error.code, 'CODE_NOT_AVAILABLE');
  assert.match(document.error.next, /local view|local API/);
});
