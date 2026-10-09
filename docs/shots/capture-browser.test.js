/** Real Chrome readiness over the disposable demo's exported API (I13,A10). */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
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

/** Wait for one named lifecycle message from the owned profile writer. */
function waitForWriterMessage(writer, expected) {
  return new Promise((resolve) => {
    /** Resolve on the requested message and stop listening. */
    const receive = (message) => {
      if (message !== expected) return;
      writer.off('message', receive);
      resolve(message);
    };
    writer.on('message', receive);
  });
}

/** Remove a capture profile, retrying transient filesystem races while Chrome flushes data. */
async function removeCaptureFolder(folder) {
  await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test('capture cleanup retries while a closed browser flushes its profile [I13,A10]', { timeout: 10_000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'pullboard-cleanup-regression-'));
  const profile = join(base, 'profile');
  await mkdir(profile);
  await Promise.all(Array.from({ length: 3000 }, (_, index) => writeFile(join(profile, `seed-${index}`), 'profile data')));
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const profile = process.argv[1];
    let sequence = 0;
    process.stdout.write('ready\\n');
    let deadline;
    /** Keep writing profile files briefly after the simulated close signal. */
    function flush() {
      let wrote = false;
      try { fs.writeFileSync(path.join(profile, 'flush-' + sequence++), 'profile data'); wrote = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (wrote && sequence >= 5 && sequence % 5 === 0) process.send('flush');
      if (Date.now() < deadline) setTimeout(flush, 0);
      else process.exit(0);
    }
    process.on('message', (message) => {
      if (message === 'close') process.send('closing');
      if (message === 'prepare') process.send('prepared');
      if (message === 'flush') {
        try { fs.writeFileSync(path.join(profile, 'flush-' + sequence++), 'profile data'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        process.send('first-flush');
      }
      if (message === 'continue') {
        deadline = Date.now() + 300;
        flush();
      }
    });
  `;
  const writer = spawn(process.execPath, ['-e', script, profile], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
  const closed = once(writer, 'close');
  try {
    const [ready] = await once(writer.stdout, 'data');
    assert.equal(ready.toString(), 'ready\n', 'the profile writer is ready before cleanup begins');
    const closing = waitForWriterMessage(writer, 'closing');
    const prepared = waitForWriterMessage(writer, 'prepared');
    writer.send('close');
    assert.equal(await closing, 'closing');
    writer.send('prepare');
    assert.equal(await prepared, 'prepared');
    const firstFlush = waitForWriterMessage(writer, 'first-flush');
    writer.send('flush');
    assert.equal(await firstFlush, 'first-flush');
    let cleanupStarted = true;
    let writesDuringCleanup = 0;
    writer.on('message', (message) => { if (cleanupStarted && message === 'flush') writesDuringCleanup++; });
    const cleanup = removeCaptureFolder(base);
    writer.send('continue');
    const [exit] = await Promise.all([closed, cleanup]);
    cleanupStarted = false;
    const [code, signal] = exit;
    assert.equal(code, 0, `the stand-in browser exits cleanly: ${signal ?? ''}`);
    assert.ok(writesDuringCleanup > 0, 'the profile writer flushes while cleanup is running');
    await assert.rejects(readdir(base), { code: 'ENOENT' }, 'cleanup removes the profile while the writer flushes');
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) writer.kill();
    await closed;
    await removeCaptureFolder(base);
  }
});

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
    await Promise.race([state.received, populated.then(() => state.received)]);
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
    // close() waits for Chrome's process close before its profile can be removed.
    if (view) await view.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await removeCaptureFolder(base);
  }
});
