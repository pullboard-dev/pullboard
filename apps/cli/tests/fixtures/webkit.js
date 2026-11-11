/**
 * A real WebKit for browser tests, with no package [H5,C7]. It drives the WebKit build Playwright keeps in its browser
 * cache (Playwright.app on macOS) over that build's own inspector pipe: JSON messages separated by NUL bytes on file
 * descriptors 3 (to the browser) and 4 (from it). Nothing here downloads a browser; a machine without such a build gets
 * null from findWebkitExecutable, and a test names that reason when it skips its WebKit column.
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import {
  tmpdir,
  userInfo,
} from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import { requireBrowserSlot } from './chrome.js';

/** How long one protocol command may take before the fixture names it as stuck. */
const COMMAND_TIMEOUT_MS = 15_000;

/**
 * The WebKit executable to drive: PULLBOARD_WEBKIT when set, else the newest Playwright WebKit build in this user's
 * browser cache on macOS, else null.
 *
 * @returns {string | null}
 */
export function findWebkitExecutable() {
  if (process.env.PULLBOARD_WEBKIT) return existsSync(process.env.PULLBOARD_WEBKIT) ? process.env.PULLBOARD_WEBKIT : null;
  if (process.platform !== 'darwin') return null;
  // The account's own home, not $HOME, which a test runner may point at a private folder.
  const cache = join(userInfo().homedir, 'Library', 'Caches', 'ms-playwright');
  let builds = [];
  try { builds = readdirSync(cache).filter((name) => /^webkit-\d+$/u.test(name)); } catch { return null; }
  builds.sort((left, right) => Number(right.slice(7)) - Number(left.slice(7)));
  for (const build of builds) {
    const executable = join(cache, build, 'Playwright.app', 'Contents', 'MacOS', 'Playwright');
    if (existsSync(executable)) return executable;
  }
  return null;
}

/** Wait a little without holding the event loop. */
function pause(ms) {
  return new Promise((resolvePause) => setTimeout(resolvePause, ms)); // budget: hang ceiling for one poll interval, no speed claim.
}

/**
 * Start a headless WebKit with its own profile folder.
 *
 * @param {{ executable?: string, commandTimeoutMs?: number }} [options]
 * @returns {Promise<{ newPage: (options?: { cookies?: object[], proxyServer?: string }) => Promise<object>, close: () => Promise<void>, stderr: () => string }>}
 */
export async function startWebkit({ executable = findWebkitExecutable(), commandTimeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  requireBrowserSlot();
  if (!executable) throw new Error('WebKit was not found; set PULLBOARD_WEBKIT to a Playwright WebKit build.');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-webkit-'));
  const frameworks = dirname(dirname(dirname(dirname(executable))));
  const child = spawn(executable, ['--inspector-pipe', '--headless', '--no-startup-window', `--user-data-dir=${profile}`], {
    // WebKit keeps a CryptoKey in IndexedDB only by wrapping it with a master key from the account's keychain, which
    // lives under the real home; a test runner's private HOME has none, and the store then refuses the key.
    detached: true, env: { ...process.env, HOME: userInfo().homedir, DYLD_FRAMEWORK_PATH: frameworks, DYLD_LIBRARY_PATH: frameworks },
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
  const exited = new Promise((resolveExit) => child.once('close', resolveExit));
  const toBrowser = child.stdio[3];
  const fromBrowser = child.stdio[4];
  const pending = new Map();
  const listeners = new Set();
  let nextId = 0;
  let buffer = '';
  fromBrowser.setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\0'); end >= 0; end = buffer.indexOf('\0')) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiting = message.id !== undefined ? pending.get(message.id) : null;
      if (waiting) {
        pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.error) waiting.reject(new Error(`WebKit ${waiting.method}: ${message.error.message ?? 'refused'}`));
        else waiting.resolve(message.result ?? {});
      } else for (const listener of listeners) listener(message);
    }
  });
  /** Send one browser-level command, optionally addressed to a page proxy. */
  function send(method, params = {}, pageProxyId) {
    return new Promise((resolveSend, rejectSend) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); rejectSend(new Error(`WebKit ${method} did not answer within ${commandTimeoutMs}ms`)); }, commandTimeoutMs);
      pending.set(id, { resolve: resolveSend, reject: rejectSend, timer, method });
      toBrowser.write(JSON.stringify({ id, method, params, ...(pageProxyId ? { pageProxyId } : {}) }) + '\0');
    });
  }
  await send('Playwright.enable');

  /**
   * Open one page in a fresh browser context: its own cookies and storage, so each matrix cell starts from exactly
   * the state it names.
   *
   * `prepare(send)` runs on every page target before it starts, including the new target a cross-site navigation
   * makes, so interception and the bootstrap script hold on every document; `onMessage` sees each target event.
   *
   * @param {{ cookies?: object[], proxyServer?: string, prepare?: (send: (method: string, params?: object) => Promise<any>) => Promise<void>, onMessage?: (message: object, send: (method: string, params?: object) => Promise<any>) => void, phone?: boolean }} [options]
   */
  async function newPage({ cookies = [], proxyServer, prepare, onMessage, phone = false, context = null } = {}) {
    // A page joins an existing context when given one, so it shares that context's storage and IndexedDB.
    const { browserContextId } = context ? { browserContextId: context } : await send('Playwright.createContext', proxyServer ? { proxyServer } : {});
    if (proxyServer) await send('Playwright.setIgnoreCertificateErrors', { browserContextId, ignore: true });
    if (cookies.length) await send('Playwright.setCookies', { browserContextId, cookies });
    let targetId = null;
    let pageProxyId = null;
    let innerId = 0;
    const innerPending = new Map();
    const exceptions = [];
    const listener = (message) => {
      if (pageProxyId && message.pageProxyId !== pageProxyId) return;
      if (message.method === 'Target.targetCreated' && message.params.targetInfo.type === 'page') {
        const created = message.params.targetInfo;
        const proxy = message.pageProxyId;
        void (async () => {
          try { if (prepare) await prepare((method, params) => toTarget(created.targetId, proxy, method, params)); }
          catch (error) { exceptions.push({ setup: error.message }); }
          // The first target counts as ready only once prepared, so no request of the first navigation escapes it.
          if (!created.isProvisional) targetId = created.targetId;
          if (created.isPaused) await send('Target.resume', { targetId: created.targetId }, proxy).catch(() => {});
        })();
      } else if (message.method === 'Target.didCommitProvisionalTarget') {
        targetId = message.params.newTargetId;
      } else if (message.method === 'Target.dispatchMessageFromTarget') {
        const inner = JSON.parse(message.params.message);
        const waiting = inner.id !== undefined ? innerPending.get(inner.id) : null;
        if (waiting) { innerPending.delete(inner.id); waiting(inner); }
        else if (onMessage && inner.method) onMessage(inner, (method, params) => toTarget(message.params.targetId, message.pageProxyId, method, params));
        if (waiting) return;
        if (inner.method === 'Runtime.exceptionThrown' || inner.method === 'Console.messageAdded' && inner.params?.message?.level === 'error') exceptions.push(inner.params);
      }
    };
    /** Send one command to a named target of this page and wait for its answer. */
    function toTarget(target, proxy, method, params = {}) {
      return new Promise((resolveTarget, rejectTarget) => {
        const id = ++innerId;
        const timer = setTimeout(() => { innerPending.delete(id); rejectTarget(new Error(`WebKit page ${method} did not answer within ${commandTimeoutMs}ms`)); }, commandTimeoutMs);
        innerPending.set(id, (inner) => { clearTimeout(timer); inner.error ? rejectTarget(new Error(`WebKit page ${method}: ${inner.error.message}`)) : resolveTarget(inner.result); });
        send('Target.sendMessageToTarget', { targetId: target, message: JSON.stringify({ id, method, params }) }, proxy).catch((error) => { clearTimeout(timer); innerPending.delete(id); rejectTarget(error); });
      });
    }
    listeners.add(listener);
    ({ pageProxyId } = await send('Playwright.createPage', { browserContextId }));
    if (phone) {
      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, fixedLayout: false, deviceScaleFactor: 2 }, pageProxyId);
      await send('Page.setTouchEmulationEnabled', { enabled: true }, pageProxyId).catch(() => {});
    }
    const deadline = Date.now() + commandTimeoutMs;
    while (!targetId && Date.now() < deadline) await pause(10);
    if (!targetId) throw new Error('WebKit created no page target');
    /** Send one command to the page's current target and wait for its answer. */
    function page(method, params = {}) { return toTarget(targetId, pageProxyId, method, params); }
    /** Evaluate an expression in the page and return its JSON value. */
    async function evaluate(expression) {
      const result = await page('Runtime.evaluate', { expression: `JSON.stringify((() => (${expression}))())`, returnByValue: true });
      if (result.wasThrown) throw new Error(`WebKit page threw: ${result.result?.description ?? 'an exception'}`);
      return result.result?.value === undefined ? undefined : JSON.parse(result.result.value);
    }
    /** Poll an expression until it is truthy, then return its value; a navigation in flight is retried. */
    async function waitFor(expression, timeoutMs = commandTimeoutMs) {
      const end = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < end) {
        try {
          const value = await evaluate(expression);
          if (value) return value;
        } catch (error) { last = error; }
        await pause(25);
      }
      throw new Error(`WebKit condition did not hold within ${timeoutMs}ms: ${expression.slice(0, 160)}${last ? ` (${last.message})` : ''}`);
    }
    return {
      browserContextId,
      exceptions,
      navigate: (url) => send('Playwright.navigate', { url, pageProxyId }),
      evaluate,
      waitFor,
      cookies: async () => (await send('Playwright.getAllCookies', { browserContextId })).cookies,
      /** Close the page; its context goes too unless it is kept for other pages. */
      async close({ keepContext = false } = {}) {
        listeners.delete(listener);
        try { await send('Playwright.closePage', { pageProxyId }); } catch { /* The page already closed. */ }
        if (!keepContext) { try { await send('Playwright.deleteContext', { browserContextId }); } catch { /* The context already closed. */ } }
      },
    };
  }

  let closed = false;
  return {
    newPage,
    /** Remove one browser context and everything stored in it. */
    deleteContext: (browserContextId) => send('Playwright.deleteContext', { browserContextId }),
    stderr: () => stderr,
    async close() {
      if (closed) return;
      closed = true;
      try { await send('Playwright.close'); } catch { /* The browser already stopped. */ }
      const stopped = await Promise.race([exited.then(() => true), pause(3_000).then(() => false)]); // budget: hang ceiling for WebKit shutdown.
      if (!stopped) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The group already exited. */ } await exited; }
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
