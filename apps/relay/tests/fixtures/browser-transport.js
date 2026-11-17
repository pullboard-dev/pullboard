/** In-memory browser stand-ins so the relay's browser transport runs under node with no network [H5,H15,C7]. */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

/** Named globals the browser transport reads; each is restored to its prior descriptor afterward. */
const NAMES = ['localStorage', 'sessionStorage', 'indexedDB', 'fetch', 'location', 'history', 'document', 'addEventListener', 'removeEventListener'];

/** A Web Storage look-alike over a Map. */
function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    clear: () => map.clear(),
  };
}

/** Answer a request-like object after the caller has attached its handlers, as IndexedDB does. */
function later(request, run) {
  setTimeout(() => { request.result = run(); request.onsuccess?.({ target: request }); }, 0);
  return request;
}

/** The least IndexedDB the device key store uses: one database, one 'keys' store, get, put, delete. */
function memoryIndexedDB() {
  const rows = new Map();
  let created = false;
  const store = {
    get: key => later({}, () => rows.get(key)),
    put: (value, key) => later({}, () => { rows.set(key, value); return key; }),
    delete: key => later({}, () => { rows.delete(key); }),
  };
  return {
    open() {
      const request = {};
      setTimeout(() => {
        const db = {
          close() {},
          transaction() {
            const transaction = { objectStore: () => store, abort() {} };
            setTimeout(() => setTimeout(() => transaction.oncomplete?.({}), 0), 0);
            return transaction;
          },
          createObjectStore() {},
        };
        request.result = db;
        if (!created) { created = true; request.onupgradeneeded?.({}); }
        request.onsuccess?.({ target: request });
      }, 0);
      return request;
    },
  };
}

/**
 * Install the stand-ins on globalThis. `responses` maps a request path to its JSON document, or to
 * `{ status, body }`; an unlisted path answers 404. Returns the paths fetched, in order, and `restore()`.
 * `restore()` also fires `pagehide`, which stops the transport's own timers so the process can exit.
 */
export function installBrowserTransport({ responses = {}, origin = 'https://relay.test', hash = '' } = {}) {
  const saved = new Map(NAMES.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const listeners = new Map();
  const requests = [];
  const root = { dataset: {}, querySelector: () => null };
  const stand = {
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    indexedDB: memoryIndexedDB(),
    location: { hash, pathname: '/', search: '', origin, replace() {} },
    history: { replaceState() {} },
    document: { documentElement: root, getElementById: () => null, querySelector: () => null },
    addEventListener: (type, listener) => { listeners.set(type, [...listeners.get(type) ?? [], listener]); },
    removeEventListener: (type, listener) => { listeners.set(type, (listeners.get(type) ?? []).filter(value => value !== listener)); },
    async fetch(url) {
      const path = new URL(String(url), origin).pathname;
      requests.push(path);
      const answer = responses[path];
      const status = answer?.status ?? (answer === undefined ? 404 : 200);
      const body = answer?.body ?? answer ?? { error: { code: 'NO_ROUTE', message: 'No stub for ' + path } };
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    },
  };
  for (const [name, value] of Object.entries(stand)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return {
    requests,
    storage: { local: stand.localStorage, session: stand.sessionStorage },
    restore() {
      for (const listener of listeners.get('pagehide') ?? []) listener({});
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

const PAGE = new URL('../../src/io/browser/page.js', import.meta.url);

/** The loader hooks' source: a relative import with no file behind it resolves to its public relay alias's file. */
const ALIAS_HOOKS = `
let aliases = {};
export function initialize(data) { aliases = data; }
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (error) {
    const target = error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') ? aliases[specifier.split('/').pop()] : null;
    if (!target) throw error;
    return next(target, context);
  }
}`;

/**
 * Let node import the browser client, whose modules are served under public relay aliases (./seal.js and the like) that
 * have no file beside it. The alias table is read from page.js, so it cannot drift from what a real browser is served.
 */
export function registerBrowserAliases({ engine = 1 } = {}) {
  const aliases = {};
  for (const [, name, path] of readFileSync(PAGE, 'utf8').matchAll(/'\/relay\/([\w.-]+)': new URL\('([^']+)', import\.meta\.url\)/gu)) {
    aliases[name] = new URL(path, PAGE).href;
  }
  // page.js generates engine.js from the state door, which a relay-cell fixture may not import; the caller names the engine a test needs (an empty inventory reads none).
  aliases['engine.js'] = 'data:text/javascript,' + encodeURIComponent(`export const ENGINE_VERSION = ${engine};`);
  register('data:text/javascript,' + encodeURIComponent(ALIAS_HOOKS), { parentURL: import.meta.url, data: aliases });
}
