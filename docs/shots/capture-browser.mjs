/** Real Chrome capture with explicit document and data readiness (I13,A10). */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluationValue } from './devtools-evaluation.mjs';

/** Allow Chrome or the page's next response to advance before another read-only observation. */
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));

/** Stop this owned Chrome process and await its sockets and profile release. */
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise((resolveStop) => child.once('close', resolveStop));
}

/** Start Chrome with a disposable profile and return the DevTools connection for its page. */
export async function browser(chrome, profile, url) {
  const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-proxy-server', '--use-mock-keychain', '--password-store=basic', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1100', 'about:blank'], { stdio: 'ignore' });
  let socket;
  let port;
  try {
    for (let n = 0; n < 100 && !port; n++) {
      try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch {}
      if (!port) await pause(100);
    }
    if (!port) throw new Error('Chrome did not start');
    const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
    if (!response.ok) throw new Error('Chrome could not open the demo view');
    const target = await response.json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, fail) => { socket.addEventListener('open', ok, { once: true }); socket.addEventListener('error', fail, { once: true }); });
    let id = 0;
    const pending = new Map();
    socket.addEventListener('message', ({ data }) => { const m = JSON.parse(String(data)); const waiter = pending.get(m.id); if (waiter) { pending.delete(m.id); m.error ? waiter.reject(new Error('Chrome operation failed: ' + m.error.message)) : waiter.resolve(m.result); } });
    /** Bound a protocol operation so a stalled renderer cannot strand Chrome or a capture. */
    const send = (method, params = {}) => new Promise((ok, fail) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); fail(new Error(`Chrome operation timed out: ${method}`)); }, 30_000);
      pending.set(key, { resolve: (value) => { clearTimeout(timer); ok(value); }, reject: (error) => { clearTimeout(timer); fail(error); } });
      socket.send(JSON.stringify({ id: key, method, params }));
    });
    await send('Page.enable');
    await send('Runtime.enable');
    const evaluate = async (expression) => evaluationValue(await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }));
    /** Wait for a read-only page condition; a timeout is a failed capture, never a silent success. */
    async function waitFor(expression, label, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await pause(100);
      }
      throw new Error(`The demo page did not become ready: ${label}`);
    }
    await send('Page.navigate', { url });
    await waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`, 'intended HTTP document');
    return {
      evaluate,
      waitFor,
      viewport: (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }),
      screenshot: async (path) => { const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(path, Buffer.from(result.data, 'base64')); },
      close: async () => { socket.close(); await stop(child); },
    };
  } catch (error) {
    socket?.close();
    await stop(child);
    throw error;
  }
}

/** Wait for this demo's API data and rendered controls before storage writes or selection. */
export async function waitForDemoBoard(view, repo) {
  const ready = `typeof data !== 'undefined' && data?.project?.root === ${JSON.stringify(repo)} && data.root === view.root && data.projects.some(project => project.root === ${JSON.stringify(repo)} && project.ok && project.name === 'Demo board') && data.project.items.some(item => item.id === 1 && item.title === 'Reviewed and accepted' && item.verdicts.some(verdict => verdict.decision === 'REJECT') && item.verdicts.at(-1)?.decision === 'ACCEPT') && !!document.querySelector('#state-chips [data-state=all]')`;
  await view.waitFor(ready, 'populated demo board and complete review history');
}
