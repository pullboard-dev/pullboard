/** @pullboard-test-input apps/cli/tests/fixtures/view/pty.py */
import { cliCockpitRenderer$cockpitPage as cockpitSource } from '../../index.js';
/**
 * End to end on real repos: the CLI runs as its own process, git runs the installed hooks, and
 * worktrees are real worktrees (B1–B3, B6, V3, V4, V7, L3, L4, C3, I1, I2, P2).
 */
import assert from 'node:assert/strict';
import {
  runFixtureExecFile as execFileSync,
} from '../../tests/fixtures/child.js';
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import {
  createServer,
  request,
} from 'node:http';
import { connect } from 'node:net';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoardForRead } from '../../../lib/index.js';

import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fetchFresh } from '../../tests/fixtures/http.js';
import { fetchPrintedViewLink } from '../../tests/fixtures/view/link.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  BIN, sandboxes, sandbox, CONFIG, SPEC, project, holdingGate,
  launch, waitFor, gateEvents, commitFile, attackCommit, privateCheckSubmission,
  startView, LIGHT_BRIEF,
} = e2e;

/** Stop the exact detached view server returned by an isolated fixture invocation. */
function stopOwnedView(pid, signal = 'SIGTERM') {
  try { process.kill(pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

/** Wait until the owned listener has closed, treating only a refused socket as completion. */
async function waitForViewStopped(url) {
  const deadline = Date.now() + 5_000; // budget: hang ceiling for observing graceful SIGTERM cleanup.
  while (Date.now() < deadline) {
    try {
      const response = await fetchPrintedViewLink(url, { signal: AbortSignal.timeout(500) });
      if (!response.ok) throw new Error('the view listener remained open after its owner stopped');
    } catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') return;
      if (error.message.includes('listener remained open')) throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error('the owned view listener did not close after SIGTERM');
}

test('cli.journeys-view-e2e.an-agent-s-pullboard-view-prints: an agent\'s pullboard view prints its link and returns [N26,N32]', async () => {
  const box = project(CONFIG.gate);
  const env = { ...box.env };
  delete env.AI_AGENT;
  const args = [BIN, 'view', '--no-open', '--port', '0', '--json'];
  const owned = [];
  try {
    const started = execFileSync(process.execPath, args, { cwd: box.repo, env, encoding: 'utf8', timeout: 40_000 });
    const first = JSON.parse(started);
    owned.push({ pid: first.pid, port: first.port, url: first.url });
    assert.equal(first.reused, false, 'the first unattended start owns the newly bound listener');
    assert.ok(Number.isInteger(first.pid), 'the successful response identifies its owning process');
    assert.ok(Number.isFinite(Date.parse(first.boundAt)), 'the response reports the actual bind time');
    const firstUrl = new URL(first.url);
    assert.equal(firstUrl.pathname, '/');
    const stateFile = join(env.PULLBOARD_HOME, `view-${first.port}.json`);
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal((statSync(stateFile).mode & 0o077) === 0, true, 'the persisted session secret is private to this user');
    assert.equal(state.pid === first.pid && state.boundAt === first.boundAt, true, 'the runtime record matches the successful bind receipt');
    assert.equal(state.secret === firstUrl.searchParams.get('k'), true, 'the private record authenticates the returned link');
    const page = await fetchPrintedViewLink(firstUrl);
    assert.equal(page.status, 200, 'the returned link fetches the live view page');
    const receiptFile = join(box.repo, '.git', 'pullboard', 'view-bind.json');
    assert.equal(existsSync(receiptFile), true, 'a fresh bind writes the setup receipt');
    const firstReceipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    assert.equal(firstReceipt.boundAt, first.boundAt, 'the setup receipt records this actual fresh bind');
    rmSync(receiptFile);

    const secondResult = execFileSync(process.execPath, [BIN, 'view', '--no-open', '--port', String(first.port), '--json'], {
      cwd: box.repo, env, encoding: 'utf8', timeout: 40_000,
    });
    const second = JSON.parse(secondResult);
    assert.equal(second.reused, true, 'a second start reuses the authenticated listener');
    assert.equal(second.url === first.url, true, 'the second start returns the same private link');
    assert.equal(second.pid === first.pid, true, 'the second start identifies the same owner');
    assert.equal(second.boundAt === first.boundAt, true, 'reusing a server preserves its real bind time');
    assert.equal(existsSync(receiptFile), false, 'named-port reuse does not mint a fresh setup receipt');

    const agentEnv = { ...env, AI_AGENT: '1' };
    const agentStarted = execFileSync(process.execPath, [BIN, 'view', '--no-open', '--port', '0', '--json'], {
      cwd: box.repo, env: agentEnv, encoding: 'utf8', timeout: 40_000,
    });
    const agent = JSON.parse(agentStarted);
    owned.push({ pid: agent.pid, port: agent.port, url: agent.url });
    assert.equal(agent.reused, false, 'an explicit agent start also creates and returns its owned view');
    assert.equal((await fetchPrintedViewLink(agent.url)).status, 200, 'the explicit agent link fetches its live page');
    assert.equal(existsSync(receiptFile), true, 'a new port-0 bind writes a new setup receipt');
    const agentReceipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    assert.equal(agentReceipt.boundAt, agent.boundAt, 'a new port-0 bind records its actual setup receipt');
  } finally {
    try {
      const port = JSON.parse(readFileSync(join(env.PULLBOARD_HOME, 'view.json'), 'utf8')).port;
      const state = JSON.parse(readFileSync(join(env.PULLBOARD_HOME, `view-${port}.json`), 'utf8'));
      if (!owned.some((view) => view.pid === state.pid)) owned.push({ pid: state.pid, url: `http://127.0.0.1:${state.port}/?k=${encodeURIComponent(state.secret)}` });
    } catch { /* No server record means the fixture never bound. */ }
    let cleanupError;
    for (const view of owned.reverse()) {
      if (!Number.isInteger(view.pid)) continue;
      try {
        stopOwnedView(view.pid);
        await waitForViewStopped(view.url);
      }
      catch (error) {
        cleanupError ??= error;
        try {
          stopOwnedView(view.pid, 'SIGKILL');
          await waitForViewStopped(view.url);
        } catch (forceError) { cleanupError ??= forceError; }
      }
    }
    if (cleanupError) throw cleanupError;
  }
});

test('cli.journeys-view-e2e.a-printed-view-link-opens-through: a printed view link opens through its cookie redirect [N39,N26]', async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, cookie: req.headers.cookie ?? '' });
    if (req.url === '/?k=legacy-key') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('legacy view page');
    } else if (req.url === '/?k=fixture-key') {
      res.writeHead(303, {
        location: '/',
        'set-cookie': 'pb_view=fixture-cookie; Path=/; HttpOnly; SameSite=Strict',
      }).end();
    } else if (req.url === '/?k=invalid-userinfo') {
      const target = new URL('/', origin);
      target.username = 'user';
      target.password = 'pass';
      res.writeHead(303, {
        location: target.href,
        'set-cookie': 'pb_view=fixture-cookie; Path=/; HttpOnly; SameSite=Strict',
      }).end();
    } else if (req.url === '/?k=foreign-domain') {
      res.writeHead(303, {
        location: '/',
        'set-cookie': 'pb_view=foreign-cookie; Path=/; HttpOnly; SameSite=Strict; Domain=foreign.invalid',
      }).end();
    } else if (req.url === '/' && req.headers.cookie === 'pb_view=fixture-cookie') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('browser opened the view');
    } else {
      res.writeHead(403).end('the clean address requires the cookie');
    }
  });
  await new Promise((ready, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ready);
  });
  t.after(() => new Promise((done) => server.close(done)));

  const origin = `http://127.0.0.1:${server.address().port}`;
  const legacy = await fetchPrintedViewLink(`${origin}/?k=legacy-key`);
  assert.equal(legacy.status, 200);
  assert.equal(await legacy.text(), 'legacy view page');
  assert.deepEqual(requests.splice(0), [{ url: '/?k=legacy-key', cookie: '' }]);

  const page = await fetchPrintedViewLink(`${origin}/?k=fixture-key`);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), 'browser opened the view');
  assert.deepEqual(requests, [
    { url: '/?k=fixture-key', cookie: '' },
    { url: '/', cookie: 'pb_view=fixture-cookie' },
  ]);

  requests.length = 0;
  await assert.rejects(fetchPrintedViewLink(`${origin}/?k=invalid-userinfo`), { name: 'AssertionError' });
  assert.deepEqual(requests, [{ url: '/?k=invalid-userinfo', cookie: '' }]);

  requests.length = 0;
  await assert.rejects(fetchPrintedViewLink(`${origin}/?k=foreign-domain`), { name: 'AssertionError' });
  assert.deepEqual(requests, [{ url: '/?k=foreign-domain', cookie: '' }]);
});

test('cli.journeys-view-e2e.a-person-running-view-with-json: a person running view with JSON in a terminal keeps the server in that terminal [N26,N32]', () => {
  let box = sandbox();
  box.env.PULLBOARD_MODEL ??= 'Fixture Model';
  box = project(CONFIG.gate, box);
  const helper = resolve(import.meta.dirname, '../../tests/fixtures/view/pty.py');
  const result = JSON.parse(execFileSync('python3', [helper], {
    cwd: box.repo,
    env: box.env,
    input: JSON.stringify({ repo: box.repo, node: process.execPath, bin: BIN, env: box.env }),
    encoding: 'utf8',
    timeout: 45_000,
  }));
  assert.equal(result.actualStdoutTTY, true);
  assert.equal(result.aiAgent, false);
  assert.equal(result.jsonMode, true);
  assert.equal(result.pageStatus, 200);
  assert.equal(result.parentRemainedForeground, true);
  assert.equal(result.serverPidMatchesParent, true);
  assert.equal(result.processesGone, true);
  assert.equal(result.listenerClosed, true);
});

test('cli.journeys-view-e2e.view-serves-every-project-on-this: view serves every project on this machine, on loopback, behind its secret and its own Host [N26, I8]', async () => {
  const box = project();
  await fixtureAdd(box.runLocal, box.repo, 'web', 'Page', '--specs', 'G1', '--criterion', 'renders');
  await box.runLocal(box.repo, 'shout', 'web-1', 'the heading is in G1');
  const registry = JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'projects.json'), 'utf8'));
  assert.deepEqual(registry.projects.map((entry) => entry.root), [box.repo]);
  const view = await startView(box, box.repo);
  try {
    assert.equal((await fetchFresh(`${view.base}/`)).status, 403, 'no secret');
    const badSecret = await fetchFresh(`${view.base}/api/v1/boards`, { headers: { 'x-pullboard-key': 'guess' } });
    assert.equal(badSecret.status, 401, 'a wrong secret');
    assert.equal((await badSecret.json()).error.code, 'AUTH_REQUIRED');
    const page = await view.page();
    assert.match(await page.text(), /<title>Pullboard<\/title>/);
    const { boards, warnings, project: shown } = await view.state(box.repo);
    assert.deepEqual(boards.map((entry) => [entry.root, entry.name]), [[box.repo, 'repo']]);
    assert.deepEqual(warnings, []);
    assert.equal(shown.items.filter((item) => item.status === 'open').length, 1);
    assert.deepEqual(shown.items.map((item) => [item.id, item.title, item.status, item.specs]), [[1, 'Page', 'open', ['G1']]]);
    assert.equal(shown.shouts[0].shout_text, 'the heading is in G1');
    assert.deepEqual(shown.spec.map((row) => [row.id, row.status]), [['G1', 'approved'], ['G2', 'approved']]);
    assert.ok(shown.agents.some((agent) => agent.agent_id === 'web-1'));
    const rebound = await new Promise((done) => {
      request({ host: '127.0.0.1', port: view.link.port, path: '/api/v1/boards', headers: { host: `evil.example:${view.link.port}`, 'x-pullboard-key': view.key } }, (res) => done(res.statusCode)).end();
    });
    assert.equal(rebound, 401, 'the right secret from another Host, as DNS rebinding would send it');
  } finally {
    await view.stop();
  }
});

test('cli.journeys-view-e2e.from-the-view-the-person-adds: from the view the person adds items, shouts and holds lanes, through the CLI and its refusals [N27]', async () => {
  const box = project();
  const view = await startView(box, box.repo);
  try {
    const added = await view.act(box.repo, { verb: 'add', args: { lane: 'web', title: 'From the view', specs: 'G1' } });
    assert.equal(added.status, 200, JSON.stringify(added.document));
    assert.equal(added.document.event.event_kind, 'add');
    assert.equal(added.document.result.item.item_title, 'From the view');
    assert.equal(JSON.parse((await box.runLocal(box.repo, 'show', '1', '--json')).out).item_title, 'From the view');
    const refused = await view.act(box.repo, { verb: 'add', args: { lane: 'web', title: 'Ghost', specs: 'Z9' } });
    assert.equal(refused.status, 409);
    assert.equal(refused.document.error.code, 'UNKNOWN_SPEC');
    const shouted = await view.act(box.repo, { verb: 'shout', args: { to: 'web', text: 'from the person' } });
    assert.equal(shouted.status, 200);
    assert.equal(shouted.document.event.event_kind, 'shout');
    assert.equal(shouted.document.event.event_by, 'person');
    const inbox = JSON.parse((await box.runLocal(box.web, 'inbox', '--json')).out);
    assert.ok(inbox.shouts.some((row) => row.shout_from === 'person' && row.shout_to === 'web' && row.shout_text === 'from the person'),
      'the web seat receives the person\'s shout, read from inbox --json');
    const held = await view.act(box.repo, { verb: 'hold', args: { lane: 'web', reason: 'G1 is changing' } });
    assert.equal(held.status, 200);
    assert.equal(held.document.event.event_kind, 'hold');
    assert.equal(held.document.event.event_by, 'person');
    assert.equal(JSON.parse(held.document.event.event_detail).channel, 'view');
    const takeHeld = await box.runLocal(box.web, 'next', '--take', '--json');
    assert.notEqual(takeHeld.code, 0, 'next --take is refused while the lane is held');
    const heldError = JSON.parse(takeHeld.out).error;
    // The old assert proved the refusal names the hold (who and why), not only that nothing was free. The --json error
    // carries code, message and next, with no separate hold field, so the code is NOTHING_FREE and the hold stays a
    // wording check on the message below (the held lane and its reason are the contract).
    assert.equal(heldError.code, 'NOTHING_FREE');
    assert.ok(heldError.message.includes('person holds the web lane') && heldError.message.includes('G1 is changing'), 'the refusal names who holds the lane and why');
    const released = await view.act(box.repo, { verb: 'hold', args: { lane: 'web', off: true } });
    assert.equal(released.status, 200);
    assert.equal(released.document.event.event_kind, 'unhold');
    assert.equal(released.document.event.event_by, 'person');
    assert.equal(JSON.parse(released.document.event.event_detail).channel, 'view');
    const unknown = await view.act(box.dir, { verb: 'shout', args: { to: 'all', text: 'x' } });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.document.error.code, 'NO_BOARD');
    const before = await view.state(box.repo);
    const target = before.boards.find((entry) => entry.root === box.repo);
    const stranger = await fetchFresh(`${view.base}/api/v1/boards/${encodeURIComponent(target.id)}/moves`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'shout', args: { to: 'all', text: 'unauthorized move' } }),
    });
    assert.equal(stranger.status, 401);
    assert.equal((await stranger.json()).error.code, 'AUTH_REQUIRED');
    assert.deepEqual((await view.state(box.repo)).project.shouts, before.project.shouts, 'an unauthenticated move cannot write a shout');
  } finally {
    await view.stop();
  }
});

test('cli.journeys-view-e2e.the-view-answers-a-request-line: the view answers a request line no URL parser accepts with 403, and keeps serving [N26]', async () => {
  const box = project();
  const view = await startView(box, box.repo);
  try {
    const reply = await new Promise((done) => {
      const socket = connect(Number(view.link.port), '127.0.0.1', () => socket.write(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${view.link.port}\r\nConnection: close\r\n\r\n`));
      let text = '';
      socket.on('data', (chunk) => { text += chunk; });
      socket.on('close', () => done(text));
    });
    assert.match(reply, /^HTTP\/1\.1 403/);
    assert.equal((await view.page()).status, 200, 'still serving');
  } finally {
    await view.stop();
  }
});

test('cli.journeys-view-e2e.nothing-a-person-types-on-the: nothing a person types on the view sits inside what the refresh rewrites [N27]', () => {
  const page = cockpitSource();
  // Every refresh part is written through store.paint (#6613), which replaced the direct innerHTML assignments.
  const rewritten = [...new Set([...page.matchAll(/store\.paint\(\$\('([a-z-]+)'\)/g)].map((match) => match[1]))];
  // The items list is painted through a local named chain, the element with id="chain".
  if (page.includes('store.paint(chain,')) rewritten.push('chain');
  assert.ok(['lanes', 'chain', 'detail', 'needs'].every((id) => rewritten.includes(id)), 'the refresh rewrites these');
  for (const id of rewritten) {
    const opening = new RegExp(`id="${id}"[^>]*>([^]*?)</`).exec(page);
    assert.doesNotMatch(opening ? opening[1] : '', /<(input|textarea|form)/, `#${id} starts with no form`);
  }
  // copyWords' clipboard fallback (#764) creates a read-only field, selects it and removes it in the same call, so it
  // never holds anything a person typed; every other field the script could build is still refused.
  // The Spec tab's Answer box is the one other field; its refresh case in spec/cockpit.test.js proves the draft and focus survive.
  const script = page.slice(page.indexOf('<script>')).replace(/\nasync function copyWords\([^]*?\n}\n/, '\n')
    .replace(/'<form class="spec-answer-form"[^\n]*?<\/form>'/u, "''")
    // A shout thread's reply box (sx-reply, 154e174c55) is built when a person opens the thread; its unsent text is kept in shoutDrafts and put back after every draw, so a refresh never erases it (io/page/shouts.js).
    .replace(/'<i class="sx-si you"><\/i><input type="text"[^\n]*/u, "''")
    // The command palette's search box (pal-q) lives in its own overlay, opened and closed by the person, never in a refreshed part.
    .replace(/overlay\.innerHTML = '<div class="pal-veil" data-close="1"><div class="pal-box"[^\n]*/u, '');
  assert.doesNotMatch(script, /<input|<textarea|createElement\('(form|input|textarea)'\)/, 'the script never builds a field a refresh could erase');
});

test('cli.journeys-view-e2e.the-view-keeps-the-board-layout: the view keeps the board layout people know: switcher, tabs, a list and its detail, every verdict and the history [N26, N27]', async () => {
  const box = project();
  await fixtureAdd(box.runLocal, box.repo, 'web', 'Page', '--specs', 'G1', '--criterion', 'renders a heading');
  await box.runLocal(box.web, 'claim', '1');
  await commitFile(box, box.web, 'web/a.html', 'a', 'feat(web): page [G1]');
  // A pulled submit returns once its gate job is offered and the fixture settles that job, so the gate has recorded
  // its receipt before the reject below. The pull path starts no background review comparison [V4,C7,P7].
  await box.runLocal(box.web, 'submit', '1');
  // The settle returns when the job queue is quiet, which can be before the receipt is applied; wait for the submission itself.
  const submittedNow = () => {
    const board = openBoardForRead(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
    try { return store.getItem(board, 1).item_status === 'submitted'; } finally { store.closeBoard(board); }
  };
  await waitFor(submittedNow, 'the pulled gate to record the submission', 60_000); // budget: hang ceiling for the loopback runner's gate under runner load.
  box.git(box.repo, 'switch', '-q', '--detach', 'web/one');
  const rejected = await box.runLocal(box.repo, 'verify', '1', 'reject', '--reason', 'TEST_FAILURE', '--clause', 'renders a heading', '--note', 'no heading', '--as', 'coordinator');
  assert.equal(rejected.code, 0, rejected.out + rejected.err);
  box.git(box.repo, 'switch', '-q', 'main');
  const view = await startView(box, box.repo);
  try {
    const page = await (await view.page()).text();
    for (const region of ['id="proj-switch"', 'data-tab="items"', 'data-tab="shouts"', 'data-tab="spec"', 'data-tab="doctrine"', 'data-tab="activity"', 'id="chain"', 'id="detail"', 'id="add-form"', 'id="hold-form"']) {
      assert.ok(page.includes(region), region);
    }
    assert.match(
      page,
      /const filing = \[\.\.\.working\.filter\(\(l\) => p\.owning\.includes\(l\)\), 'coordinator', \.\.\.working\.filter\(\(l\) => !p\.owning\.includes\(l\)\)\]/,
      'new items default to a lane that owns folders, then the coordinator, verifier lanes last',
    );
    const item = (await view.state(box.repo)).project.items[0];
    assert.deepEqual(item.verdicts.map((verdict) => [verdict.decision, verdict.reason, verdict.note]), [['REJECT', 'TEST_FAILURE', 'no heading']]);
    // Facts (the gate job note, the tier-1 shadow, a review comparison when one runs) are noted apart from the moves.
    assert.deepEqual(item.history.map((event) => event.kind).filter((kind) => kind !== 'fact' && kind !== 'renew'), ['add', 'milestone_placed', 'claim', 'proof-run', 'submit', 'reject', 'escalate']);
    const board = openBoardForRead(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
    try {
      const [receipt] = store.proofReceipts(board, item.id);
      assert.equal(receipt.item, item.id, 'the visible proof belongs to this item');
      assert.equal(receipt.commit, item.commit, 'the visible proof checked the submitted commit');
      assert.equal(item.history.find((event) => event.kind === 'proof-run').by, receipt.seat, 'the history names the native executing seat');
    } finally {
      store.closeBoard(board);
    }
    assert.equal(item.criterion, 'renders a heading');
  } finally {
    await view.stop();
  }
});

/** Build an adversarial Git object directly; submit must be safe even when no commit hook ran. */
