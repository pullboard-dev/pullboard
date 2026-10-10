/** Cockpit fixture checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import diagnosticsChannel from 'node:diagnostics_channel';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { addItem, closeBoard, openBoard } from '../../src/board.js';
import { exportBoard, importBoard } from '../../src/exchange.js';
import { projectState } from '../../src/serve.js';
import { scratch, machine, project, build, fetchView, fetchLive, startView, styleOf, openPage, boardId, boardOf, assertObservationsEqual, chromeExecutable, startSnapshotChrome, openSnapshotChrome, stopOwnedChrome, closeSnapshotChrome } from './fixture.js';


test('borrowed board presentation keeps parity, shows staged rows, and leaves the caller connection open [N26,H16]', () => {
  const box = machine();
  const p = project(box, 'projector');
  box.run(p.repo, 'add', 'web', 'Existing projection row', '--criterion', 'same native data');
  const source = openBoard(join(p.repo, '.git', 'pullboard', 'board.sqlite'));
  const staged = openBoard(':memory:');
  try {
    importBoard(staged, exportBoard(source));
    const ordinary = projectState(p.repo);
    assert.deepEqual(projectState(p.repo, { board: staged }), ordinary, 'borrowed and ordinary projections share the same fields and values');
    const before = exportBoard(source);
    const stagedId = addItem(staged, { by: 'coordinator', lane: 'web', title: 'Staged recovery row', criterion: 'visible only in staged snapshot' });
    const stagedState = projectState(p.repo, { board: staged });
    assert.ok(stagedState.items.some(item => item.id === stagedId && item.title === 'Staged recovery row'));
    assert.ok(!projectState(p.repo).items.some(item => item.title === 'Staged recovery row'), 'staged-only rows never change the native board');
    assert.deepEqual(exportBoard(source), before, 'projection from the staged connection does not mutate source rows');
    assert.equal(staged.db.prepare('SELECT 1 AS open').get().open, 1, 'the caller-owned staged connection stays open');
  } finally {
    closeBoard(staged);
    closeBoard(source);
  }
});

test('[N38,C7] real cockpit fixture reads close API and stylesheet connections', async (t) => {
  const box = machine();
  const fixtureProject = project(box, 'wire proof');
  const channel = diagnosticsChannel.channel('undici:client:sendHeaders');
  const sent = [];
  let origin = null;
  /** Record the headers Undici is actually about to send to this fixture's view origin. */
  function recordHeaders({ request: outgoing, headers }) {
    if (origin && String(outgoing?.origin) === origin) sent.push({ path: outgoing.path, headers: String(headers) });
  }
  channel.subscribe(recordHeaders);
  let view;
  try {
    view = await startView(box);
    origin = new URL(view.base).origin;
    await styleOf(view);
    assert.notEqual(await boardId(view, fixtureProject.repo), 'not-registered');
  } finally {
    channel.unsubscribe(recordHeaders);
    await view?.stop();
  }
  const closes = (request) => /(?:^|\r?\n)connection:\s*close(?:\r?\n|$)/iu.test(request.headers);
  assert.ok(sent.some((request) => request.path.startsWith('/view.css') && closes(request)),
    'the real stylesheet request sends Connection: close');
  assert.ok(sent.some((request) => request.path.startsWith('/api/v1/boards') && closes(request)),
    'the real API listing request sends Connection: close');
});

test('the page uses only API v1 for state, code and every offered move [A3,N26,N27]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  const commit = box.git(alpha.web, 'rev-parse', 'HEAD');
  const ref = `web/greeting.html:1@${commit}`;
  box.run(alpha.web, 'shout', 'all', ref);
  const ask = JSON.parse(box.run(alpha.repo, 'shout', 'person', 'Ship the greeting?', '--decision', '--json')).id;
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const id = await boardId(view, alpha.repo);
    await page.click({ tab: 'shouts' });
    await page.click({ code: ref });
    assert.match(page.show('feed'), /<i>1<\/i>greeting\.html/);
    assert.equal(await page.run("act('add', {lane:'web', title:'API item', specs:'G1', brief:'Files: web/api.html'})"), true);
    assert.equal(await page.run("act('shout', {to:'web', text:'API greeting'})"), true);
    assert.equal(await page.run(`act('answer', {id:${ask}, text:'Ship it.'})`), true);
    assert.equal(await page.run("act('hold', {lane:'web', reason:'Awaiting the next decision'})"), true);
    assert.equal(await page.run("act('release', {lane:'web'})"), true);
    const moves = page.requests.filter((request) => request.method === 'POST');
    assert.deepEqual(moves.map((request) => request.body.verb), ['add', 'shout', 'answer', 'hold', 'hold']);
    assert.equal(moves[2].body.args.as, 'person');
    assert.equal(moves[2].body.item, ask);
    assert.equal(moves[4].body.args.off, true);
    assert.ok(page.requests.every((request) => /^\/api\/v1\/boards(?:$|\/[^/]+\/(?:state|code|moves)(?:\?|$))/.test(request.path)), 'every page request uses a public v1 path');
    assert.ok(page.requests.some((request) => request.path === '/api/v1/boards'));
    assert.ok(page.requests.some((request) => request.path === `/api/v1/boards/${id}/state`));
    assert.ok(page.requests.some((request) => request.path.startsWith(`/api/v1/boards/${id}/code?`)));
    assert.ok(moves.every((request) => request.path === `/api/v1/boards/${id}/moves`));
    assert.doesNotMatch(page.html, /['"]\/api\/(?:state|act|code)(?:[?'"])/, 'the served page contains no legacy API calls');
    const state = await boardOf(view, alpha.repo);
    assert.equal(state.items.find((item) => item.title === 'API item').brief, 'Files: web/api.html');
    assert.ok(state.shouts.some((shout) => shout.shout_text === 'API greeting'));
    assert.ok(state.shouts.some((shout) => shout.shout_answers === ask && shout.shout_from === 'person'));
    assert.deepEqual(state.holds, []);
    assert.deepEqual(state.decisions, []);

    const headers = { 'x-pullboard-key': view.key };
    for (const path of ['/api/state', '/api/code', '/api/act']) {
      const response = await fetchLive(`${view.base}${path}`, { headers });
      assert.equal(response.status, 404, `${path} remains unavailable`);
      const refused = await response.json();
      assert.equal(refused.version, 1);
      assert.equal(refused.error.code, 'NO_ENDPOINT');
    }
    assert.equal((await fetchLive(`${view.base}/api/v1/boards`)).status, 401);
    assert.equal((await fetchLive(`${view.base}/api/v1/boards`, { headers: { ...headers, origin: 'http://other.invalid' } })).status, 403);
    const events = await fetchLive(`${view.base}/api/v1/boards/${id}/events`, { headers });
    assert.equal(events.status, 200, 'any app can read the same event endpoint on the view address');
    assert.ok((await events.json()).events.some((event) => event.event_kind === 'shout'));
  } finally {
    await view.stop();
  }
});

test('observation-time ages compare by their own clock [A10]', () => {
  const since = '2026-10-10T09:00:00.000Z';
  const firstAsOf = '2026-10-10T10:00:00.000Z';
  const secondAsOf = '2026-10-10T10:00:00.129Z';
  /** Build one synthetic board observation at the supplied capture time. */
  const snapshot = asOf => ({
    board: { id: 'same-board', event: { event_id: 42 } },
    proofStats: {
      flow: {
        asOf,
        total: 3,
        queues: {
          open: {
            count: 1,
            oldest: { id: 7, since, ageMinutes: (Date.parse(asOf) - Date.parse(since)) / 60000 },
          },
        },
      },
      other: { asOf: 'unchanged-time', ageMinutes: 3 },
    },
  });
  const first = snapshot(firstAsOf);
  const second = snapshot(secondAsOf);
  assertObservationsEqual(first, second, '129ms-separated observations match after validating their own ages');

  const wrongAge = structuredClone(second);
  wrongAge.proofStats.flow.queues.open.oldest.ageMinutes += 1;
  assert.throws(() => assertObservationsEqual(first, wrongAge, 'wrong age must be rejected'), error => error.code === 'ERR_ASSERTION' && /ageMinutes/u.test(error.message));

  const changedSince = structuredClone(second);
  changedSince.proofStats.flow.queues.open.oldest.since = '2026-10-10T08:59:59.000Z';
  changedSince.proofStats.flow.queues.open.oldest.ageMinutes = (Date.parse(secondAsOf) - Date.parse(changedSince.proofStats.flow.queues.open.oldest.since)) / 60000;
  assert.throws(() => assertObservationsEqual(first, changedSince, 'different since must be rejected'), error => error.code === 'ERR_ASSERTION');

  const changedInvariant = structuredClone(second);
  changedInvariant.proofStats.other.ageMinutes += 1;
  assert.throws(() => assertObservationsEqual(first, changedInvariant, 'unrelated ageMinutes must be retained'), error => error.code === 'ERR_ASSERTION');
});
test('view fixture retries one disconnected read with its cause and never repeats a move [N26]', async () => {
  const box = machine();
  project(box, 'transport');
  const view = await startView(box);
  const calls = new Map();
  const proxy = createServer((req, res) => {
    const count = (calls.get(req.url) ?? 0) + 1;
    calls.set(req.url, count);
    if (req.url !== '/retry' || count === 1) return req.socket.destroy();
    const upstream = request(view.link, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', (error) => res.destroy(error));
    upstream.end();
  });
  try {
    await new Promise((ready) => proxy.listen(0, '127.0.0.1', ready));
    const base = `http://127.0.0.1:${proxy.address().port}`;
    const response = await fetchView(`${base}/retry`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Pullboard/);
    assert.equal(calls.get('/retry'), 2, 'exactly one retry reaches the real view');
    await assert.rejects(fetchView(`${base}/fail`), /GET .*\/fail failed after 2 attempts; attempt 1: .*caused by .*; attempt 2: .*caused by /);
    assert.equal(calls.get('/fail'), 2, 'a failed retry stops with both transport reasons');
    await assert.rejects(fetchView(`${base}/move`, { method: 'POST', body: '{}' }), /POST .*\/move failed after 1 attempt; attempt 1: .*caused by /);
    assert.equal(calls.get('/move'), 1, 'an ambiguous move is never replayed');
  } finally {
    proxy.closeAllConnections();
    await new Promise((closed) => proxy.close(closed));
    await view.stop();
  }
});

test('Chrome startup waits past the old timeout, retries once, and reports final stderr [N26,A10]', { timeout: 45_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-chrome-launch-')));
  scratch.push(dir);
  const profile = join(dir, 'slow-profile');
  mkdirSync(profile);
  const attempts = join(dir, 'slow-attempts');
  const delayed = join(dir, 'delayed-chrome');
  writeFileSync(delayed, `#!/usr/bin/env node
const { readFileSync, writeFileSync, writeSync, mkdirSync } = require('node:fs');
const { dirname, join } = require('node:path');
const profile = process.argv.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
const attempts = join(dirname(profile), 'slow-attempts');
let count = 0;
try { count = Number(readFileSync(attempts, 'utf8')); } catch {}
writeFileSync(attempts, String(++count));
if (count === 1) { writeSync(2, 'first Chrome launch failed\\n'); process.exit(17); }
setTimeout(() => {
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'DevToolsActivePort'), '9333\\n/devtools/browser/fake\\n');
  setInterval(() => {}, 1000);
}, 10_100);
`);
  chmodSync(delayed, 0o755);
  const started = Date.now();
  const chrome = await startSnapshotChrome(delayed, profile);
  try {
    assert.ok(Date.now() - started > 10_000, 'the helper waits beyond its former ten-second limit');
    assert.equal(chrome.port, '9333');
    assert.equal(readFileSync(attempts, 'utf8'), '2', 'the failed first launch is retried exactly once');
  } finally {
    await stopOwnedChrome(chrome.child, chrome.stopped);
  }

  const failedAttempts = join(dir, 'failed-attempts');
  const failureProfile = join(dir, 'failure-profile');
  mkdirSync(failureProfile);
  const failing = join(dir, 'failing-chrome');
  writeFileSync(failing, `#!/usr/bin/env node
const { readFileSync, writeFileSync, writeSync } = require('node:fs');
const { dirname, join } = require('node:path');
const profile = process.argv.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
const attempts = join(dirname(profile), 'failed-attempts');
let count = 0;
try { count = Number(readFileSync(attempts, 'utf8')); } catch {}
writeFileSync(attempts, String(++count));
writeSync(2, 'Chrome final stderr marker\\n');
process.exit(19);
`);
  chmodSync(failing, 0o755);
  let failure;
  try { await startSnapshotChrome(failing, failureProfile); }
  catch (error) { failure = error; }
  assert.match(failure?.message ?? '', /Chrome final stderr marker/, 'a real launch failure includes Chrome stderr');
  assert.equal(readFileSync(failedAttempts, 'utf8'), '2', 'the failed launch is retried exactly once');
});

test('a Chrome wait whose condition throws while the next document loads keeps polling, and names its last error [N26,C7]', { timeout: 60_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run the browser wait proof.');
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    if (request.url === '/late') {
      // The head arrives now and the body 1.5 s later, so the next document parses without #late for a while.
      response.write('<!doctype html><html><head><title>late</title></head>');
      setTimeout(() => response.end('<body><p id="late">the late body arrived</p></body></html>'), 1500);
      return;
    }
    if (request.url === '/fault') {
      response.end('<!doctype html><script>window.__faultRan = true; throw new Error("page fault fixture");</script>');
      return;
    }
    response.end('<!doctype html><p id="first">first page</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-wait-chrome-'));
  let chrome;
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    chrome = await openSnapshotChrome(executable, `${origin}/first`, profile);
    await chrome.waitFor("document.querySelector('#first')?.textContent === 'first page'");
    await chrome.send('Page.navigate', { url: `${origin}/late` });
    await chrome.waitFor("document.querySelector('#late').textContent.includes('the late body arrived')");
    await assert.rejects(chrome.waitFor("document.querySelector('#never').textContent === 'never'", 1000),
      /^Error: Browser condition did not arrive: .*#never.*; it last threw: TypeError: Cannot read properties of null/u);
    assert.deepEqual(chrome.exceptions, [], 'a condition that throws is not a page exception');
    await chrome.send('Page.navigate', { url: `${origin}/fault` });
    await chrome.waitFor('window.__faultRan === true');
    assert.equal(chrome.exceptions.length, 1, 'an exception the page throws by itself is still collected');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
});
