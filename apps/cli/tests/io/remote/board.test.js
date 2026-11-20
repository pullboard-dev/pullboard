/** A seat with board.url set reads show and whoami from a served board and opens no board.sqlite [P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpBox } from '../../fixtures/api.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { runCliInProcess } from '../../fixtures/process.js';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { FIXTURE_MODEL } from '../../fixtures/testkit.js';

/** One successful versioned CLI call on the served board's own checkout, run in this process. */
async function served(box, cwd, ...args) {
  const ran = await runCliInProcess([...args, '--json'], { cwd, env: box.env });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  return JSON.parse(ran.stdout);
}

/** A served board, an agent on it, and a boardless clone on its own machine home that points at the board by URL. */
async function remoteSeat(t) {
  const box = await apiHttpBox(t);
  const linked = join(box.dir, 'agent');
  runFixtureGit(['worktree', 'add', '-q', '--detach', linked], { cwd: box.root, env: box.env, stdio: 'pipe' });
  const agent = (await served(box, linked, 'join', 'app')).agent;
  const item = (await served(box, box.root, 'add', 'app', 'Remote readable item', '--specs', 'G1', '--criterion', 'Read it by URL')).item.item_id;
  const clone = join(box.dir, 'studio');
  runFixtureGit(['clone', '-q', box.root, clone], { cwd: box.dir, env: box.env, stdio: 'pipe' });
  const machine = join(box.dir, 'studio-home');
  mkdirSync(machine);
  const env = { ...box.env, PULLBOARD_MACHINE_HOME: machine, PULLBOARD_AGENT: agent };
  /** Run the real CLI dispatch in the clone, awaited, so the in-process server keeps answering. */
  const run = (...args) => runCliInProcess(args, { cwd: clone, env });
  return { box, agent, item, clone, env, run };
}


/** A forwarding stand-in in front of the served board that records the path of every GET it relays. */
async function pathRecorder(t, target) {
  const paths = [];
  const server = createServer((request, response) => {
    paths.push(`${request.method} ${request.url}`);
    const relay = httpRequest(new URL(request.url, target), { method: request.method, headers: { ...request.headers, host: new URL(target).host }, agent: false }, (answer) => {
      response.writeHead(answer.statusCode, answer.headers);
      answer.pipe(response);
    });
    request.pipe(relay);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { server.close(done); server.closeIdleConnections(); }));
  return { paths, origin: `http://127.0.0.1:${server.address().port}` };
}

/** The board files a local board command would create or open in the clone. */
function cloneBoard(clone) {
  return existsSync(join(clone, '.git', 'pullboard', 'board.sqlite'));
}

test('cli.io-remote-board.show-id-prints-a-served-item-from: show <id> prints a served item from a clone with no board.sqlite [P7]', { timeout: 60_000 }, // budget: hang ceiling for fixture init, a served board and four CLI calls, not a throughput claim.
async (t) => {
  const seat = await remoteSeat(t);
  assert.equal((await seat.run('settings', 'board.url', seat.box.origin)).status, 0);
  assert.equal((await seat.run('settings', 'board.token', '--', seat.box.key)).status, 0);
  const shown = await seat.run('show', String(seat.item), '--json');
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  const document = JSON.parse(shown.stdout);
  assert.equal(document.item.id, seat.item);
  assert.equal(document.item.title, 'Remote readable item');
  const text = await seat.run('show', String(seat.item));
  assert.match(text.stdout, new RegExp(`^#${seat.item}  \\S+  app  Remote readable item`, 'mu'));
  assert.match(text.stdout, /criterion: Read it by URL/u);
  assert.equal(cloneBoard(seat.clone), false, 'show opened no local board');
});

test('cli.io-remote-board.whoami-prints-the-named-agent-s-lane: whoami prints the named agent\'s lane from the served board with no board.sqlite [P7]', { timeout: 60_000 }, // budget: hang ceiling for fixture init, a served board and three CLI calls, not a throughput claim.
async (t) => {
  const seat = await remoteSeat(t);
  assert.equal((await seat.run('settings', 'board.url', `${seat.box.origin}${seat.box.path}`)).status, 0);
  assert.equal((await seat.run('settings', 'board.token', '--', seat.box.key)).status, 0);
  const me = await seat.run('whoami', '--json');
  assert.equal(me.status, 0, me.stdout + me.stderr);
  const document = JSON.parse(me.stdout);
  assert.equal(document.id, seat.env.PULLBOARD_AGENT);
  assert.equal(document.lane, 'app');
  const text = await seat.run('whoami');
  assert.match(text.stdout, new RegExp(`^${seat.env.PULLBOARD_AGENT} \\(app lane\\) via ${seat.box.origin.replace(/[.]/gu, '\\.')}`, 'u'));
  assert.equal(cloneBoard(seat.clone), false, 'whoami opened no local board');
});

test('cli.io-remote-board.an-unreachable-board-url-or-a-wrong: an unreachable board.url or a wrong token refuses with a code and a next step [P7]', { timeout: 60_000 }, // budget: hang ceiling for fixture init, a served board and five CLI calls, not a throughput claim.
async (t) => {
  const seat = await remoteSeat(t);
  await seat.run('settings', 'board.url', seat.box.origin);
  await seat.run('settings', 'board.token', '--', 'not-the-serve-key');
  const wrong = await seat.run('show', String(seat.item));
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /^pullboard: \[BOARD_TOKEN\] .*\nnext: .+/mu);
  await seat.run('settings', 'board.url', 'http://127.0.0.1:9');
  const away = await seat.run('whoami');
  assert.equal(away.status, 1);
  assert.match(away.stderr, /^pullboard: \[BOARD_UNREACHABLE\] .*\nnext: .+/mu);
  assert.equal(cloneBoard(seat.clone), false, 'a refused read opened no local board');
});

/** A stand-in board host that records each move posted to it and answers it as recorded. */
async function recordingHost(t) {
  const moves = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (part) => { body += part; });
    request.on('end', () => {
      moves.push({ path: request.url, seatKey: request.headers['x-pullboard-seat-key'] ?? null, body: JSON.parse(body || 'null') });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: 1, event: null, result: {} }));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { server.close(done); server.closeIdleConnections(); }));
  return { moves, url: `http://127.0.0.1:${server.address().port}/api/v1/boards/fixture` };
}

test('cli.io-remote-board.join-keeps-and-moves-send-seat-key: a join by URL keeps the key the served board issued, and a move as that seat sends it, never as another seat [P7,#10790]', { timeout: 60_000 }, // budget: hang ceiling for fixture init, a served board and six CLI calls, not a throughput claim.
async (t) => {
  const seat = await remoteSeat(t);
  const own = (agent, ...args) => runCliInProcess(args, { cwd: seat.clone, env: { ...seat.env, PULLBOARD_AGENT: agent } });
  assert.equal((await own('', 'settings', 'board.url', seat.box.origin)).status, 0);
  assert.equal((await own('', 'settings', 'board.token', '--', seat.box.key)).status, 0);
  const joined = await own('', 'join', 'app', '--model', FIXTURE_MODEL, '--json');
  assert.equal(joined.status, 0, joined.stdout + joined.stderr);
  const agent = JSON.parse(joined.stdout).agent;
  const key = String(runFixtureGit(['config', '--worktree', '--get', 'pullboard.seatKey'], { cwd: seat.clone, env: seat.env })).trim();
  assert.match(key, /^[\w-]{43}$/u, 'the clone keeps the seat key its join was issued');
  const host = await recordingHost(t);
  assert.equal((await own('', 'settings', 'board.url', host.url)).status, 0);
  const moved = await own('', 'fact', String(seat.item), 'note', 'from the clone');
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  const other = await own(seat.agent, 'fact', String(seat.item), 'note', 'as another seat');
  assert.equal(other.status, 0, other.stdout + other.stderr);
  assert.deepEqual(host.moves.map((move) => [move.path, move.body.agent, move.seatKey]), [
    ['/api/v1/boards/fixture/moves', agent, key],
    ['/api/v1/boards/fixture/moves', seat.agent, null],
  ], 'the move as the joined seat carries its key; a move naming another seat carries none');
});

test('cli.io-remote-board.whoami-reads-the-seat-route: clause 1: whoami with board.url set requests the seat\'s agent route and never the board state, and prints the seat\'s lane [P7]', { timeout: 60_000 }, // budget: hang ceiling for fixture init, a served board and a recording relay, not a throughput claim.
async (t) => {
  const seat = await remoteSeat(t);
  const relay = await pathRecorder(t, seat.box.origin);
  assert.equal((await seat.run('settings', 'board.url', `${relay.origin}${seat.box.path}`)).status, 0);
  assert.equal((await seat.run('settings', 'board.token', '--', seat.box.key)).status, 0);
  relay.paths.length = 0;
  const me = await seat.run('whoami', '--json');
  assert.equal(me.status, 0, me.stdout + me.stderr);
  assert.equal(JSON.parse(me.stdout).lane, 'app');
  assert.ok(relay.paths.includes(`GET ${seat.box.path}/agents/${seat.env.PULLBOARD_AGENT}`), `the agent route was requested: ${relay.paths}`);
  assert.deepEqual(relay.paths.filter((path) => path.endsWith('/state')), [], 'no GET .../state was requested');
});
