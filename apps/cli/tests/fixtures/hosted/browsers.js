/**
 * Real Chromium and real WebKit behind one small interface, for the hosted-shapes matrix [H5,H17,N26]. Each engine
 * opens isolated contexts (their own cookies and storage), and each page routes every request it makes through the
 * test: nothing reaches the real network. A route answers a request by continuing it to another URL (event streams
 * stay live), by fulfilling it with a body, or by failing it, as a refused connection does.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findChromeExecutable,
  startChrome,
} from '../chrome.js';
import {
  findWebkitExecutable,
  startWebkit,
} from '../webkit.js';

/** How long one browser command may take before the matrix names it as stuck. */
const COMMAND_MS = 15_000;

/** Wait a little without holding the event loop. */
function pause(ms) {
  return new Promise((resolvePause) => setTimeout(resolvePause, ms)); // budget: hang ceiling for one poll interval, no speed claim.
}

/**
 * The engines this machine can run, each with the reason it cannot when it cannot.
 *
 * @returns {{ name: 'chromium' | 'webkit', available: boolean, reason: string }[]}
 */
export function hostedEngines() {
  return [
    { name: 'chromium', available: Boolean(findChromeExecutable()), reason: 'Chrome is not installed; set PULLBOARD_CHROME' },
    { name: 'webkit', available: Boolean(findWebkitExecutable()), reason: 'no Playwright WebKit build on this machine; set PULLBOARD_WEBKIT to one' },
  ];
}

/**
 * Wrap a page's evaluate in the shared page API: a JSON value from a synchronous expression, and a poll for a truthy one.
 *
 * @param {(expression: string) => Promise<any>} evaluate
 */
function pageApi(evaluate) {
  return {
    evaluate,
    /** Poll an expression until it is truthy and return its value, or null at the deadline. */
    async poll(expression, timeoutMs) {
      const end = Date.now() + timeoutMs;
      do {
        try {
          const value = await evaluate(expression);
          if (value) return value;
        } catch { /* A document mid-navigation answers on the next poll. */ }
        await pause(30);
      } while (Date.now() < end);
      return null;
    },
  };
}

/**
 * Open Chromium with a browser-level DevTools connection, so each context is a real isolated browser context.
 *
 * @returns {Promise<{ name: 'chromium', newContext: () => Promise<object>, close: () => Promise<void> }>}
 */
async function openChromium() {
  const chrome = await startChrome({ commandTimeoutMs: COMMAND_MS });
  const [port, path] = readFileSync(join(chrome.profileDirectory, 'DevToolsActivePort'), 'utf8').split('\n');
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((opened, failed) => {
    socket.addEventListener('open', opened, { once: true });
    socket.addEventListener('error', () => failed(new Error('Chromium browser socket failed')), { once: true });
  });
  const pending = new Map();
  const sessions = new Map();
  let nextId = 0;
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data));
    const waiting = message.id !== undefined ? pending.get(message.id) : null;
    if (waiting) {
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      message.error ? waiting.reject(new Error(`Chromium ${waiting.method}: ${message.error.message}`)) : waiting.resolve(message.result ?? {});
    } else if (message.sessionId) sessions.get(message.sessionId)?.(message);
  });
  /** Send one command to the browser, or to one attached page session. */
  function send(method, params = {}, sessionId) {
    return new Promise((resolveSend, rejectSend) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); rejectSend(new Error(`Chromium ${method} did not answer within ${COMMAND_MS}ms`)); }, COMMAND_MS);
      pending.set(id, { resolve: resolveSend, reject: rejectSend, timer, method });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  return {
    name: 'chromium',
    /** One isolated browser context: its own cookies, storage and IndexedDB. */
    async newContext() {
      const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: false });
      // The hosted page reads this computer's loopback addresses, which Chrome gates behind a local-network permission
      // a person grants once; versions name it differently.
      for (const permissions of [['loopbackNetwork', 'localNetwork', 'localNetworkAccess'], ['localNetworkAccess'], ['localNetwork']]) {
        try { await send('Browser.grantPermissions', { origin: 'https://app.pullboard.dev', permissions, browserContextId }); break; }
        catch { /* Try the next name this Chrome version knows. */ }
      }
      return {
        /**
         * Open a page in this context with every request routed by `route`.
         *
         * @param {{ route: (request: { url: string, method: string, headers: object }) => Promise<object>, phone?: boolean, bootstrap?: string }} options
         */
        async newPage({ route, phone = false, bootstrap = '' }) {
          const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
          const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
          const exceptions = [];
          sessions.set(sessionId, (message) => {
            if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'exception');
            if (message.method !== 'Fetch.requestPaused') return;
            const { requestId, request } = message.params;
            void (async () => {
              const answer = await route({ url: request.url, method: request.method, headers: request.headers });
              if (answer.kind === 'continue') {
                await send('Fetch.continueRequest', { requestId, url: answer.url,
                  headers: Object.entries(answer.headers).map(([name, value]) => ({ name, value })) }, sessionId);
              } else if (answer.kind === 'fulfill') {
                await send('Fetch.fulfillRequest', { requestId, responseCode: answer.status,
                  responseHeaders: Object.entries(answer.headers).map(([name, value]) => ({ name, value })),
                  body: Buffer.from(answer.body).toString('base64') }, sessionId);
              } else await send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }, sessionId);
            })().catch(() => send('Fetch.failRequest', { requestId, errorReason: 'Failed' }, sessionId).catch(() => {}));
          });
          await send('Runtime.enable', {}, sessionId);
          await send('Page.enable', {}, sessionId);
          await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);
          if (phone) {
            await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
            await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
          }
          if (bootstrap) await send('Page.addScriptToEvaluateOnNewDocument', { source: bootstrap }, sessionId);
          /** Evaluate a synchronous expression and return its JSON value. */
          const evaluate = async (expression) => {
            const result = await send('Runtime.evaluate', { expression: `JSON.stringify((() => (${expression}))())`, returnByValue: true }, sessionId);
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'page threw');
            return result.result?.value === undefined ? undefined : JSON.parse(result.result.value);
          };
          return {
            ...pageApi(evaluate),
            exceptions,
            navigate: (url) => send('Page.navigate', { url }, sessionId),
            async close() {
              sessions.delete(sessionId);
              await send('Target.closeTarget', { targetId }).catch(() => {});
            },
          };
        },
        close: () => send('Target.disposeBrowserContext', { browserContextId }).catch(() => {}),
      };
    },
    async close() {
      try { socket.close(); } catch { /* The socket already closed. */ }
      await chrome.close();
    },
  };
}

/** How long an event stream answered whole stays open before it is cut. */
const STREAM_CUT_MS = 1_500;

/**
 * Fetch a continued request in full for WebKit, keeping its method, headers and body.
 *
 * @param {string} url
 * @param {{ method: string, headers: object, postData?: string }} request
 */
async function answerWhole(url, request) {
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !['host', 'content-length', 'cookie'].includes(name.toLowerCase())));
  const stream = /event-stream/iu.test(headers.accept ?? headers.Accept ?? '');
  const controller = new AbortController();
  const response = await fetch(url, { method: request.method, headers, redirect: 'manual', signal: controller.signal,
    ...(request.postData === undefined ? {} : { body: Buffer.from(request.postData, 'base64') }) });
  const chunks = [];
  if (stream) {
    const reader = response.body.getReader();
    const cut = setTimeout(() => controller.abort(), STREAM_CUT_MS); // budget: how long one stream answer lasts before the page reconnects.
    try { for (let part = await reader.read(); !part.done; part = await reader.read()) chunks.push(Buffer.from(part.value)); }
    catch { /* The cut ends the stream. */ }
    finally { clearTimeout(cut); }
  } else chunks.push(Buffer.from(await response.arrayBuffer()));
  const answer = Object.fromEntries([...response.headers].filter(([name]) => !['content-length', 'content-encoding', 'connection', 'transfer-encoding', 'keep-alive', 'date'].includes(name)));
  return { kind: 'fulfill', status: response.status, headers: answer, body: Buffer.concat(chunks) };
}

/**
 * Open WebKit; each context is a Playwright browser context with its own storage.
 *
 * @returns {Promise<{ name: 'webkit', newContext: () => Promise<object>, close: () => Promise<void> }>}
 */
async function openWebkit() {
  const webkit = await startWebkit({ commandTimeoutMs: COMMAND_MS });
  return {
    name: 'webkit',
    /** One isolated browser context. WebKit makes contexts per page, so the first page creates it and later pages reuse its storage through a shared page. */
    async newContext() {
      const pages = [];
      let contextId = null;
      return {
        /**
         * Open a page in this context with every request routed by `route`.
         *
         * @param {{ route: (request: { url: string, method: string, headers: object }) => Promise<object>, phone?: boolean, bootstrap?: string }} options
         */
        async newPage({ route, phone = false, bootstrap = '' }) {
          const page = await webkit.newPage({ phone, context: contextId,
            prepare: async (target) => {
              await target('Network.enable');
              await target('Page.enable').catch(() => {});
              await target('Runtime.enable').catch(() => {});
              await target('Page.setTouchEmulationEnabled', { enabled: phone }).catch(() => {});
              if (bootstrap) await target('Page.setBootstrapScript', { source: bootstrap });
              await target('Network.setInterceptionEnabled', { enabled: true });
              await target('Network.addInterception', { url: '', stage: 'request' });
            },
            onMessage: (message, target) => {
              if (message.method !== 'Network.requestIntercepted') return;
              const { requestId, request } = message.params;
              void (async () => {
                let answer = await route({ url: request.url, method: request.method, headers: request.headers });
                // WebKit treats a rewritten URL as a cross-origin redirect, which a preflighted read may not follow, so a
                // continued request is answered whole here instead; an event stream is cut after a moment, and the page
                // reconnects as it would after any dropped stream.
                if (answer.kind === 'continue') answer = await answerWhole(answer.url, request);
                if (answer.kind === 'fulfill') {
                  await target('Network.interceptRequestWithResponse', { requestId, content: Buffer.from(answer.body).toString('base64'), base64Encoded: true,
                    mimeType: answer.headers['content-type']?.split(';')[0] ?? 'application/octet-stream', status: answer.status, statusText: 'OK', headers: answer.headers });
                } else if (answer.kind === 'fail') await target('Network.interceptRequestWithError', { requestId, errorType: 'General' });
              })().catch(() => target('Network.interceptRequestWithError', { requestId, errorType: 'General' }).catch(() => {}));
            } });
          contextId ??= page.browserContextId;
          pages.push(page);
          return {
            ...pageApi(page.evaluate),
            exceptions: page.exceptions,
            navigate: (url) => page.navigate(url),
            close: () => page.close({ keepContext: true }),
          };
        },
        async close() {
          for (const page of pages) await page.close().catch(() => {});
          if (contextId) await webkit.deleteContext(contextId).catch(() => {});
        },
      };
    },
    close: () => webkit.close(),
  };
}

/**
 * Open one engine by name.
 *
 * @param {'chromium' | 'webkit'} name
 */
export function openEngine(name) {
  return name === 'webkit' ? openWebkit() : openChromium();
}
