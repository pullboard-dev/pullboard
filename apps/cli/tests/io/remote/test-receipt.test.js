/** A seat with board.url set runs pullboard test here and records its receipt on the served board, opening no board.sqlite [P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { apiHttpBox } from '../../fixtures/api.js';
import { FIXTURE_BRIEF } from '../../fixtures/api.js';
import { FIXTURE_MODEL } from '../../fixtures/testkit.js';
import { fixturePolicy } from '../../fixtures/testkit.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { runCliInProcess } from '../../fixtures/process.js';

/** One successful CLI call on the board host's own checkouts, run in this process. */
async function served(box, cwd, ...args) {
  const ran = await runCliInProcess([...args, '--json'], { cwd, env: box.env });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  return JSON.parse(ran.stdout);
}

/** A served board whose repo runs named tests with node --test, one claimed seat, and a boardless clone set to its URL. */
async function remoteSeat(t) {
  const box = await apiHttpBox(t);
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env: box.env, stdio: 'pipe' });
  fixturePolicy({ repo: box.root, git }, { affectedTests: `${JSON.stringify(process.execPath)} --test` });
  mkdirSync(join(box.root, 'app'));
  writeFileSync(join(box.root, 'app', 'pass.test.js'), "import { test } from 'node:test';\ntest('passes', () => {});\n");
  writeFileSync(join(box.root, 'app', 'fail.test.js'), "import { test } from 'node:test';\ntest('fails', () => { throw new Error('red on purpose'); });\n");
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'chore: fixture tests');
  const seat = await served(box, box.root, 'worktree', 'app', '--model', FIXTURE_MODEL, '--family', 'codex');
  const clone = join(box.dir, 'studio');
  git(box.dir, 'clone', '-q', box.root, clone);
  const machine = join(box.dir, 'studio-home');
  mkdirSync(machine);
  /** Run the real CLI dispatch in the clone as the seat, awaited, so the in-process server keeps answering. */
  const run = (...args) => runCliInProcess(args, { cwd: clone, env: { ...box.env, PULLBOARD_MACHINE_HOME: machine, PULLBOARD_AGENT: seat.agent } });
  assert.equal((await run('settings', 'board.url', box.origin)).status, 0);
  assert.equal((await run('settings', 'board.token', '--', box.key)).status, 0);
  const id = (await served(box, box.root, 'add', 'app', 'Remote tested item', '--specs', 'G1', '--criterion', 'Test it by URL', '--brief', FIXTURE_BRIEF)).item.item_id;
  const claimed = await run('claim', String(id));
  assert.equal(claimed.status, 0, claimed.stdout + claimed.stderr);
  const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: clone, env: box.env, stdio: 'pipe', encoding: 'utf8' }).trim();
  return { box, clone, run, id, head };
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

/** The fact texts the served board's events carry for one item. */
async function factTexts(box, id) {
  const { events } = (await box.call(`${box.path}/events`)).document;
  return events.filter((event) => event.event_kind === 'fact' && event.item_id === id).map((event) => JSON.stringify(event));
}

test('cli.io-remote-test-receipt.pullboard-test-with-board-url-set-records: clause 1: pullboard test with board.url set records its receipt on the served board and opens no local board.sqlite [P7]', { timeout: 90_000 }, // budget: hang ceiling for fixture init, a served board, two node --test runs and six CLI calls, not a throughput claim.
async (t) => {
  const { box, clone, run, id, head } = await remoteSeat(t);
  const green = await run('test', 'app/pass.test.js');
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.match(green.stdout, new RegExp(`^test receipt: green pullboard test run of app/pass\\.test\\.js at ${head} .*recorded on #${id} via http://`, 'mu'));
  const red = await run('test', 'app/fail.test.js');
  assert.equal(red.status, 1, 'a red run exits 1');
  assert.match(red.stdout, /red on purpose/u, 'a red run shows its failing output');
  const facts = await factTexts(box, id);
  assert.ok(facts.some((fact) => fact.includes(`test receipt: green pullboard test run of app/pass.test.js at ${head}`)), `the green receipt reached the served board: ${facts}`);
  assert.ok(facts.some((fact) => fact.includes('test receipt: red pullboard test run of app/fail.test.js')), 'the red receipt reached the served board');
  assert.equal(existsSync(join(clone, '.git', 'pullboard', 'board.sqlite')), false, 'no local board.sqlite was opened');
});

test('cli.io-remote-test-receipt.show-id-on-the-served-board-lists: clause 2: show <id> on the served board lists the receipt for the item [P7]', { timeout: 90_000 }, // budget: hang ceiling for fixture init, a served board, one node --test run and five CLI calls, not a throughput claim.
async (t) => {
  const { box, run, id, head } = await remoteSeat(t);
  const ran = await run('test', 'app/pass.test.js');
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const shown = await runCliInProcess(['show', String(id)], { cwd: box.root, env: box.env });
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  assert.match(shown.stdout, new RegExp(`test receipt: green pullboard test run of app/pass\\.test\\.js at ${head}`, 'u'), shown.stdout);
});

test('cli.io-remote-test-receipt.claim-from-seat-route: clause 2: pullboard test in a URL-joined clone finds the seat\'s claimed item from its agent route and requests no GET .../state [P7]', { timeout: 90_000 }, // budget: hang ceiling for fixture init, a served board, one node --test run and a recording relay, not a throughput claim.
async (t) => {
  const { box, run, id, head } = await remoteSeat(t);
  const relay = await pathRecorder(t, box.origin);
  assert.equal((await run('settings', 'board.url', `${relay.origin}${box.path}`)).status, 0);
  relay.paths.length = 0;
  const ran = await run('test', 'app/pass.test.js');
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, new RegExp(`at ${head} .*recorded on #${id} via http://`, 'u'));
  assert.ok(relay.paths.some((path) => /^GET .*\/agents\/[^/]+$/u.test(path)), `the agent route was requested: ${relay.paths}`);
  assert.deepEqual(relay.paths.filter((path) => path.endsWith('/state')), [], 'no GET .../state was requested');
});
