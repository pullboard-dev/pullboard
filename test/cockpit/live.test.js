// pullboard: browser
/** @pullboard-test-gui */
/** The view follows the board's event stream instead of a timer, in real Chrome [N26,A2]. */
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as forward } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SPEC, browserPause, boardId, boardOf, chromeExecutable, closeSnapshotChrome, fetchLive, machine, openPage, openSnapshotChrome, pickProject, project, startView } from './fixture.js';

/** The page's HTTP requests from a mark on, as method and path, leaving out data: URLs. */
function sent(chrome, mark = 0) {
  return chrome.requests.slice(mark).filter((request) => /^https?:/.test(request.url)).map((request) => request.method + ' ' + new URL(request.url).pathname);
}

/** One request header, whatever case Chrome reports it in. */
function header(request, name) {
  return Object.entries(request.headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
}

/** The event-stream reads the page opened, each with the event it asked to start after. */
function streamReads(chrome) {
  return chrome.requests.filter((request) => /^https?:/.test(request.url) && /\/api\/v1\/boards\/[^/]+\/events$/.test(new URL(request.url).pathname)
    && /text\/event-stream/.test(header(request, 'accept') ?? '')).map((request) => header(request, 'last-event-id'));
}

/** The multiplexed event-stream reads the page opened (#600), each with the boards it names. */
function groupStreamReads(chrome) {
  return chrome.requests.filter((request) => /^https?:/.test(request.url) && new URL(request.url).pathname === '/api/v1/events'
    && /text\/event-stream/.test(header(request, 'accept') ?? '')).map((request) => (new URL(request.url).searchParams.get('boards') ?? '').split(',').sort());
}

/**
 * A loopback HTTP proxy in front of the real view, so a test can cut every connection through it and refuse new ones
 * until it is restored, as a lost network does. It names the view's own host, which the view's secret check requires.
 */
async function cuttableProxy(view) {
  const target = new URL(view.base);
  const sockets = new Set(), upstreams = new Set();
  let down = false;
  const server = createServer((req, res) => {
    const upstream = forward({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, host: target.host } }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    upstreams.add(upstream);
    upstream.on('close', () => upstreams.delete(upstream));
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  server.on('connection', (socket) => {
    if (down) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  /** Drop every open connection, upstream and down. */
  const drop = () => { for (const socket of sockets) socket.destroy(); for (const upstream of upstreams) upstream.destroy(); };
  return {
    href: `http://127.0.0.1:${server.address().port}/?k=${encodeURIComponent(view.key)}`,
    cut() { down = true; drop(); },
    restore() { down = false; },
    close: () => new Promise((closed) => { down = true; drop(); server.close(() => closed()); }),
  };
}

/** Wait until the page's stream is open and the read it makes on opening has landed, so the page is quiet. */
async function liveReady(chrome) {
  await chrome.waitFor("typeof stream !== 'undefined' && stream?.status === 'up' && catching === null && catchRoots.size === 0 && !catchEvery");
}

/** A board with one open item, served by the real view and opened in real Chrome on the Items list. */
async function liveBoard(name, { proxied = false } = {}) {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the live view checks');
  const box = machine();
  const alpha = project(box, name);
  box.run(alpha.repo, 'add', 'web', 'Header', '--specs', 'G1', '--criterion', 'renders');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), `pullboard-${name}-chrome-`));
  let chrome, proxy;
  try {
    proxy = proxied ? await cuttableProxy(view) : null;
    chrome = await openSnapshotChrome(executable, proxy?.href ?? view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=\"items\"]')"); // a person opens Items before the list is drawn, since pages open on the Dashboard.
    await chrome.waitFor('data?.project?.items?.some(item => item.id === 1) && !!document.querySelector(\'#chain [data-item="1"]\')');
    await liveReady(chrome);
  } catch (error) {
    if (chrome) await closeSnapshotChrome(chrome);
    await proxy?.close();
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
    throw error;
  }
  /** Stop this test's Chrome, proxy and view, and remove its profile. */
  const close = async () => {
    await closeSnapshotChrome(chrome);
    await proxy?.close();
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  };
  return { box, alpha, view, chrome, proxy, close };
}

/** Record in the page when an expression first holds after a DOM change, on the page's own clock. */
async function watchFor(chrome, name, expression) {
  await chrome.stable(`(() => {
    window[${JSON.stringify(name)}] = null;
    const seen = () => { if (window[${JSON.stringify(name)}] === null && (${expression})) window[${JSON.stringify(name)}] = Date.now(); };
    new MutationObserver(seen).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    return true;
  })()`);
}

/** When the board recorded its latest event of a kind for an item, read back through the API. */
async function eventAt(view, root, kind, item) {
  const id = await boardId(view, root);
  const response = await fetchLive(`${view.base}/api/v1/boards/${id}/events`, { headers: { 'x-pullboard-key': view.key } });
  assert.equal(response.status, 200);
  const event = (await response.json()).events.filter((row) => row.event_kind === kind && row.item_id === item).at(-1);
  assert.ok(event, `the board recorded a ${kind} event for #${item}`);
  return Date.parse(event.event_at);
}

test('the view shows a move as it happens [N26,A2]', { timeout: 120_000 }, async (t) => {
  const { box, alpha, view, chrome, close } = await liveBoard('live-move');
  try {
    // A quiet board draws no reads: the old view polled every 3000 ms, so any timer would show in this window.
    const quiet = chrome.requests.length;
    await browserPause(3_500); // budget: declared quiet window, longer than the 3000 ms timer the view used to read on.
    assert.deepEqual(sent(chrome, quiet), [], 'the page makes no request while the board is quiet');
    const latest = (await boardOf(view, alpha.repo)).events[0].event_id;
    assert.deepEqual(streamReads(chrome), [String(latest)], 'the page follows the board\'s event stream after the latest event it read');

    await watchFor(chrome, '__claimShownAt', 'document.querySelector(\'#chain [data-item="1"] .chip.item-seat.building\')');
    const before = chrome.requests.length;
    box.run(alpha.web, 'claim', '1');
    await chrome.waitFor('window.__claimShownAt !== null', 15_000); // budget: hang ceiling for the claim to arrive; the latency is judged below.
    const shownAt = await chrome.stable('window.__claimShownAt');
    const latency = shownAt - await eventAt(view, alpha.repo, 'claim', 1);
    t.diagnostic(`the claim appeared ${latency} ms after the board recorded it`);
    assert.ok(latency <= 2_000, `the claim appears ${latency} ms after the board recorded it`); // budget: declared by #545's frozen criterion: a move appears within 2000 ms.
    // What the page read for it came after the move, and the stream it follows stayed open.
    // The move is on the open item, so the page also reads that item's detail again (#548).
    const moveReads = sent(chrome, before);
    assert.ok(moveReads.some((line) => /^GET \/api\/v1\/boards\/[^/]+\/state$/.test(line)), `the page reread public state for the move: ${JSON.stringify(moveReads)}`);
    assert.ok(moveReads.every((line) => /^GET \/api\/v1\/boards(?:\/[^/]+\/(?:state|shouts\/\d+|items\/\d+))?$/.test(line)), `the page read the board for the move: ${JSON.stringify(moveReads)}`);
    assert.equal(streamReads(chrome).length, 1, 'the page kept the one stream it opened');
    assert.equal(await chrome.stable("document.querySelector('#live').textContent"), '', 'the live line says the page is live');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    await close();
  }
});

// #555: the catch-up asks the server what changed since the state the page holds (#552) and applies that delta.
test('the view catches up with a delta after a move [N26,A2]', { timeout: 120_000 }, async () => {
  const { box, alpha, view, chrome, close } = await liveBoard('live-delta');
  try {
    const held = (await boardOf(view, alpha.repo)).events[0].event_id;
    const mark = chrome.requests.length;
    box.run(alpha.web, 'claim', '1');
    await chrome.waitFor('!!document.querySelector(\'#chain [data-item="1"] .chip.item-seat.building\')', 15_000); // budget: hang ceiling for the claim to arrive.
    await liveReady(chrome);
    /** The since cursor of each state read the page made from a request mark on, null for a full read. */
    const reads = (from) => chrome.requests.slice(from).filter((request) => /^https?:/.test(request.url) && /^\/api\/v1\/boards\/[^/]+\/state$/.test(new URL(request.url).pathname))
      .map((request) => new URL(request.url).searchParams.get('since'));
    assert.deepEqual(reads(mark), [String(held)], `the page asked once what changed since the event it held, and read no full state: ${JSON.stringify(reads(mark))}`);
    assert.equal(await chrome.stable('data.project.items.find((item) => item.id === 1).status'), 'claimed', 'the item shows the move');
    // The delta's result is the page's next base: the move after it asks from the claim on.
    const claimed = (await boardOf(view, alpha.repo)).events[0].event_id;
    const again = chrome.requests.length;
    box.run(alpha.repo, 'add', 'web', 'After the delta', '--specs', 'G1', '--criterion', 'renders');
    await chrome.waitFor('!!document.querySelector(\'#chain [data-item="2"]\')', 15_000); // budget: hang ceiling for the new item to arrive.
    await liveReady(chrome);
    assert.deepEqual(reads(again), [String(claimed)], `the next catch-up asks from the state the delta made: ${JSON.stringify(reads(again))}`);
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    await close();
  }
});

test('an idle view makes no requests [N26,A2]', { timeout: 150_000 }, async () => {
  const { box, alpha, chrome, close } = await liveBoard('live-idle');
  try {
    await chrome.waitFor('document.querySelector(\'#live\').textContent === \'\'');
    const mark = chrome.requests.length;
    await browserPause(30_000); // budget: declared by #545's frozen criterion: an unchanged board for 30 seconds.
    assert.deepEqual(sent(chrome, mark), [], 'the page makes no request while the board is unchanged for 30 seconds');
    assert.equal(await chrome.stable("document.querySelector('#live').textContent"), '', 'and it is still live');
    // The quiet was the stream waiting, not a page that stopped: a move after it still arrives.
    box.run(alpha.repo, 'add', 'web', 'After the quiet', '--specs', 'G1', '--criterion', 'renders');
    await chrome.waitFor('!!document.querySelector(\'#chain [data-item="2"]\')', 15_000); // budget: hang ceiling for the new item to arrive.
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    await close();
  }
});

test('a dropped stream reconnects from its last event [N26,A2]', { timeout: 120_000 }, async () => {
  const { box, alpha, view, chrome, proxy, close } = await liveBoard('live-drop', { proxied: true });
  try {
    await chrome.waitFor('document.querySelector(\'#live\').textContent === \'\'');
    const latest = (await boardOf(view, alpha.repo)).events[0].event_id;
    // The connection drops and stays down: the live line says the page is not live.
    proxy.cut();
    await chrome.waitFor('/^(offline|reconnecting)/.test(document.querySelector(\'#live\').textContent)', 15_000); // budget: hang ceiling for the dropped stream to show.
    // A move while the page is cut off is one the reopened stream must bring.
    box.run(alpha.web, 'claim', '1');
    proxy.restore();
    await chrome.waitFor('!!document.querySelector(\'#chain [data-item="1"] .chip.item-seat.building\')', 30_000); // budget: hang ceiling for one reconnect after the stream's longest 15000 ms wait.
    await chrome.waitFor('document.querySelector(\'#live\').textContent === \'\'');
    const reads = streamReads(chrome);
    assert.ok(reads.length >= 2, `the page opened the stream again: ${JSON.stringify(reads)}`);
    assert.deepEqual([...new Set(reads)], [String(latest)], 'every reopened stream names the last event the page received, as Last-Event-ID');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    await close();
  }
});

// core-188's first static concern (#545 review): an edit with no event, made while the stream is down, is not in
// Last-Event-ID's replay, and the reopened stream's changed signal starts after it.
test('a change with no event while the stream is down shows once it reconnects [N26,A2]', { timeout: 120_000 }, async () => {
  const { alpha, chrome, proxy, close } = await liveBoard('live-gap', { proxied: true });
  try {
    await chrome.waitFor('document.querySelector(\'#live\').textContent === \'\'');
    proxy.cut();
    await chrome.waitFor('/^(offline|reconnecting)/.test(document.querySelector(\'#live\').textContent)', 15_000); // budget: hang ceiling for the dropped stream to show.
    appendFileSync(join(alpha.repo, 'SPEC.md'), '- G3 [pending, must] Should the page wave back? | gate: web test\n');
    proxy.restore();
    await chrome.waitFor('data?.project?.spec?.some(row => row.id === "G3")', 30_000); // budget: hang ceiling for one reconnect after the stream's longest 15000 ms wait.
    await chrome.waitFor('document.querySelector(\'#live\').textContent === \'\'');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    await close();
  }
});

// core-188's second static concern (#545 review): with the board left and opened again, the first answer for it can
// arrive after the newer one. It must not be drawn over it.
test('an older answer for a board opened again is not drawn over a newer one [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'stale-alpha');
  const beta = project(box, 'stale-beta');
  box.run(alpha.repo, 'add', 'web', 'Older', '--specs', 'G1', '--criterion', 'renders');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.equal(page.run('view.root'), alpha.repo, 'the page opens on the first board');
    // Hold the next read of alpha's state, so the first answer for alpha arrives last.
    page.run(`(() => {
      const real = fetch, id = data.projects.find((row) => row.root === ${JSON.stringify(alpha.repo)}).id;
      let armed = true;
      globalThis.__releaseOlder = () => {};
      fetch = (path, init) => {
        if (!armed || !path.includes('/boards/' + id + '/state')) return real(path, init);
        armed = false;
        // The read happens now, before the newer item exists; only its answer waits.
        const answer = globalThis.__olderRead = real(path, init);
        return new Promise((resolve) => { globalThis.__releaseOlder = () => resolve(answer); });
      };
    })()`);
    const older = page.run('refresh()');
    // The held read is sent and answered before the board changes; only the page has not seen the answer yet.
    while (!page.run('Boolean(globalThis.__olderRead)')) await new Promise((resolve) => setImmediate(resolve));
    await page.run('__olderRead');
    await page.run(`view.root = ${JSON.stringify(beta.repo)}; refresh()`);
    box.run(alpha.repo, 'add', 'web', 'Newer', '--specs', 'G1', '--criterion', 'renders');
    await page.run(`view.root = ${JSON.stringify(alpha.repo)}; refresh()`);
    const titles = () => JSON.parse(page.run('JSON.stringify(data.project.items.map((item) => item.title).sort())'));
    assert.deepEqual(titles(), ['Newer', 'Older'], 'the newer answer shows both items');
    page.run('__releaseOlder()');
    await older;
    assert.deepEqual(titles(), ['Newer', 'Older'], 'the older answer, arriving last, is not drawn over it');
  } finally {
    await view.stop();
  }
});

// The #545 landing failure: a catch-up that read only the shown board, while the view restarted, found it unreadable
// and the other boards kept, and so moved the page to another board as if the shown one were gone.
test('a catch-up that cannot read the shown board keeps it shown [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'kept-alpha');
  project(box, 'kept-beta');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.equal(page.run('view.root'), alpha.repo, 'the page opens on the first board');
    page.run(`(() => {
      const real = fetch, id = data.projects.find((row) => row.root === ${JSON.stringify(alpha.repo)}).id;
      fetch = (path, init) => path.includes('/boards/' + id + '/state')
        ? Promise.resolve({ ok: false, status: 503, json: async () => ({ version: 1, error: { code: 'SERVICE_ERROR', message: 'the view is restarting' } }) })
        : real(path, init);
    })()`);
    await assert.rejects(page.run(`refresh(new Set([${JSON.stringify(alpha.repo)}]))`), /did not answer/, 'the catch-up fails as a read');
    assert.equal(page.run('view.root'), alpha.repo, 'the page stays on the board it shows');
  } finally {
    await view.stop();
  }
});

// #555's fallback: when the server cannot extend the state the page holds, as after it forgot that base, the
// answer resets and the page loads a fresh snapshot instead.
test('a catch-up whose base the server does not keep loads a fresh snapshot [N26,A2]', async () => {
  const box = machine();
  const alpha = project(box, 'reset-alpha');
  box.run(alpha.repo, 'add', 'web', 'Before', '--specs', 'G1', '--criterion', 'renders');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    // Sequence 0 is a base this server never sent, so its answer resets with BASE_NOT_KEPT.
    page.run('[...sentStates.values()].forEach((held) => { held.sequence = 0; })');
    box.run(alpha.repo, 'add', 'web', 'After', '--specs', 'G1', '--criterion', 'renders');
    const mark = page.requests.length;
    await page.run(`refresh(new Set([${JSON.stringify(alpha.repo)}]))`);
    const reads = page.requests.slice(mark).map((request) => request.path).filter((path) => /\/state(?:\?|$)/.test(path))
      .map((path) => new URL(path, 'http://page').searchParams.get('since'));
    assert.deepEqual(reads, ['0', null], 'the page asked for a delta, was told to reset, and read one fresh snapshot');
    assert.deepEqual(JSON.parse(page.run('JSON.stringify(data.project.items.map((item) => item.title).sort())')), ['After', 'Before'], 'the fresh snapshot shows the change');
    assert.equal(page.run(`[...sentStates.values()][0].sequence`), page.run('data.project.sequence'), 'the fresh snapshot is the next base');
  } finally {
    await view.stop();
  }
});

/** Prove a reset response loads exactly one fresh snapshot and establishes the next delta base. */
async function resetDeltaBase(label, corrupt) {
  const box = machine();
  const alpha = project(box, label);
  box.run(alpha.repo, 'add', 'web', 'Before reset', '--specs', 'G1', '--criterion', 'renders');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    page.run(corrupt);
    const since = page.run('[...sentStates.values()][0].sequence');
    box.run(alpha.repo, 'add', 'web', 'After reset', '--specs', 'G1', '--criterion', 'renders');
    const mark = page.requests.length;
    await page.run(`refresh(new Set([${JSON.stringify(alpha.repo)}]))`);
    const reads = page.requests.slice(mark).map((request) => request.path).filter((path) => /\/state(?:\?|$)/.test(path))
      .map((path) => new URL(path, 'http://page').searchParams.get('since'));
    assert.deepEqual(reads, [String(since), null], 'a reset is followed by exactly one full snapshot');
    assert.deepEqual(JSON.parse(page.run('JSON.stringify(data.project.items.map((item) => item.title).sort())')),
      ['After reset', 'Before reset'], 'the recovered snapshot shows the real move');
    assert.equal(page.run('[...sentStates.values()][0].sequence'), page.run('data.project.sequence'),
      'the recovered snapshot replaces the obsolete delta base');
  } finally {
    await view.stop();
  }
}

// A reset/restored board can have fewer events than the page holds; the corrected #555 bar includes BASE_AHEAD.
test('a catch-up ahead of the server loads a fresh snapshot [N26,A2]', async () => {
  await resetDeltaBase('reset-ahead', '[...sentStates.values()].forEach((held) => { held.sequence += 1000000; })');
});

// Event-log formats are versioned independently of a board's sequence.
test('a catch-up with a different event format loads a fresh snapshot [N26,A2]', async () => {
  await resetDeltaBase('reset-format', '[...sentStates.values()].forEach((held) => { held.version = "different-format"; })');
});

/**
 * A project group of `count` real repos, opened in real Chrome as the group, where a claim on `mover`'s item must
 * show within two seconds while the page follows every repo on one stream.
 */
async function groupClaim(t, name, count, mover) {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the live view checks');
  const box = machine();
  const repos = [];
  for (let index = 0; index < count; index++) repos.push(project(box, `${name}-${index}`, SPEC, { project: name, name: `${name} ${index}` }));
  box.run(repos[mover].repo, 'add', 'web', 'Group catch-up', '--specs', 'G1', '--criterion', 'updates');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), `pullboard-${name}-chrome-`));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    const group = `document.querySelector('#proj-list [data-root="group:${name}"]')`;
    await chrome.waitFor(`data?.projects?.length === ${count} && !!${group}`);
    await pickProject(chrome, group);
    await chrome.waitFor(`data?.group?.repos?.length === ${count} && document.querySelector('#live').textContent === ''`);
    await liveReady(chrome);
    const ids = (await Promise.all(repos.map((repo) => boardId(view, repo.repo)))).sort();
    assert.deepEqual(groupStreamReads(chrome).at(-1), ids, 'the group follows every repo it shows on one stream');
    const shown = `data?.group?.repos?.find(repo => repo.root === ${JSON.stringify(repos[mover].repo)})?.board.items.find(item => item.id === 1)?.status`;
    await watchFor(chrome, '__groupClaimAt', `${shown} === 'claimed'`);
    box.run(repos[mover].web, 'claim', '1');
    assert.equal((await boardOf(view, repos[mover].repo)).items.find((item) => item.id === 1).status, 'claimed', 'the board has the claim');
    await chrome.waitFor('window.__groupClaimAt !== null', 15_000); // budget: hang ceiling for the claim to arrive; the latency is judged below.
    const latency = await chrome.stable('window.__groupClaimAt') - await eventAt(view, repos[mover].repo, 'claim', 1);
    t.diagnostic(`a group of ${count} showed repo ${mover + 1}'s claim ${latency} ms after the board recorded it`);
    assert.ok(latency <= 2_000, `the group shows the claim ${latency} ms after the board recorded it`); // budget: declared by #545's frozen criterion: a move appears within 2000 ms.
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
}

// core-188's six-repo case (#545 review): one held stream per repo took all six of Chrome's connections to the view,
// so the catch-up read for a committed claim never left the page.
test('a group of six repos catches up on one stream [N26,A2]', { timeout: 120_000 }, async (t) => {
  await groupClaim(t, 'capacity', 6, 0);
});

// docs-28's two-repo case (#545 review): a move made only in a group's second repo must wake the page too.
test("a move made only in a group's second repo appears as fast as one in its first [N26,A2]", { timeout: 120_000 }, async (t) => {
  await groupClaim(t, 'second', 2, 1);
});
