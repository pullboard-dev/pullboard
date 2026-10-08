/** Real Chrome readiness over the disposable demo's exported API (I13,A10). */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { browser, waitForDemoBoard } from './capture-browser.mjs';

/** Let the browser process a pending protocol reply without releasing either server barrier. */
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));

/** Make a server barrier and a signal for the first request waiting behind it. */
function barrier() {
  let release;
  let observed;
  return { pending: new Promise((resolve) => { release = resolve; }), received: new Promise((resolve) => { observed = resolve; }), release: () => release(), observed: () => observed() };
}

test('demo capture waits for the intended HTTP document and populated board in Chrome [I13,A10]', { timeout: 90_000 }, async (t) => {
  const chrome = [process.env.PULLBOARD_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find((file) => spawnSync(file, ['--version'], { stdio: 'ignore' }).status === 0);
  if (!chrome) return t.skip('Install Chrome to prove demo capture readiness.');
  const base = await mkdtemp(join(tmpdir(), 'pullboard-demo-capture-'));
  const document = barrier();
  const state = barrier();
  const stylesheet = barrier();
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/') { document.observed(); await document.pending; }
    if (path.endsWith('/view.css')) { stylesheet.observed(); await stylesheet.pending; }
    if (path.endsWith('/state.json')) { state.observed(); await state.pending; }
    try {
      const body = await readFile(new URL('../demo/' + (path === '/' ? 'index.html' : path.slice(1)), import.meta.url));
      response.setHeader('Content-Type', path.endsWith('.json') ? 'application/json' : path.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let opened = false;
  const opening = browser(chrome, join(base, 'profile'), url).then((view) => { opened = true; return view; });
  // Attach immediately so a genuine bootstrap failure cannot become an unhandled rejection.
  opening.catch(() => {});
  let view;
  try {
    await Promise.race([document.received, opening.then(() => document.received)]);
    await pause(150);
    assert.equal(opened, false, 'about:blank complete must not count as the intended HTTP document');
    document.release();
    await Promise.race([stylesheet.received, opening.then(() => stylesheet.received)]);
    await pause(150);
    assert.equal(opened, false, 'a committed HTTP document with a pending stylesheet must not count as complete');
    stylesheet.release();
    view = await opening;
    assert.equal(await view.evaluate('location.href'), url);
    let ready = false;
    const populated = waitForDemoBoard(view, 'demo-board').then(() => { ready = true; });
    populated.catch(() => {});
    await state.received;
    await pause(150);
    assert.equal(ready, false, 'complete HTML must not count as populated board data');
    state.release();
    await populated;
    assert.equal(await view.evaluate("data.project.root === 'demo-board' && !!document.querySelector('#chain .row[data-item=\"1\"]')"), true);
    assert.equal(await view.evaluate("localStorage.setItem('capture-proof', 'ready'); localStorage.getItem('capture-proof')"), 'ready');
    await assert.rejects(view.waitFor('false', 'impossible capture state', 150), /did not become ready: impossible capture state/);
  } finally {
    document.release(); state.release(); stylesheet.release();
    if (!view) view = await opening.catch(() => null);
    if (view) await view.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(base, { recursive: true, force: true });
  }
});
