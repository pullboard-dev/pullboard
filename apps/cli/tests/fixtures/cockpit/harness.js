import { quitOwnedChrome } from '../chrome/shutdown.js';
import { chromeLaunchArgs } from '../chrome/args.js';
/** Shared real-board, VM and Chrome fixtures for the cockpit checks [N26]. */
import assert from 'node:assert/strict';
import {
  execFileSync,
  spawn,
} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  request,
} from 'node:http';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import vm from 'node:vm';
import {
  stableChrome,
  press,
  pressTab,
  tapTouch,
} from './stable.js';
import { closeBoard } from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { fetchFresh } from '../http.js';
import { main as viewMain } from '../native.js';
import {
  guardChromeGroup,
  requireBrowserSlot,
} from '../chrome.js';
import {
  BIN,
  scratch,
  SPEC,
  machine,
  project,
} from './machine.js';

/** The target the view sets (#371): 44px where a finger taps, here a window under 900px; 32px under the tests' mouse. */
const tapTarget = (width) => (width < 900 ? 44 : 32);

/**
 * web-1 builds an item: claims it, commits a file in its lane through the hooks, and submits it.
 */
function build(box, p, id, file) {
  const key = `${p.baseBranch}:${id}`;
  let branch = p.itemBranches.get(key);
  if (!branch) {
    branch = `${p.baseBranch}-item-${id}`;
    box.git(p.web, 'switch', '-q', '-c', branch, p.baseBranch);
    p.itemBranches.set(key, branch);
  } else {
    box.git(p.web, 'switch', '-q', branch);
  }
  p.branch = branch;
  box.run(p.web, 'claim', String(id));
  mkdirSync(join(p.web, 'web'), { recursive: true });
  writeFileSync(join(p.web, 'web', file), `${file}\n`);
  box.git(p.web, 'add', '-A');
  box.git(p.web, 'commit', '-q', '-m', `feat(web): ${file} [G1]`);
  // Setup names its next item explicitly; the native handoff itself is tested by post-move-handoff cases.
  box.run(p.web, 'submit', String(id), '--no-next');
}

/**
 * The in-process twin of build: the same claim, commit and submit, with the CLI calls awaited in this process instead of launched.
 * Why: a journey's before() seeds a whole board, and a launch per call ran it past the wall limit.
 */
async function buildLocal(box, p, id, file, { queued = false } = {}) {
  const key = `${p.baseBranch}:${id}`;
  let branch = p.itemBranches.get(key);
  if (!branch) {
    branch = `${p.baseBranch}-item-${id}`;
    box.git(p.web, 'switch', '-q', '-c', branch, p.baseBranch);
    p.itemBranches.set(key, branch);
  } else {
    box.git(p.web, 'switch', '-q', branch);
  }
  p.branch = branch;
  await box.inProcess(p.web, 'claim', String(id));
  mkdirSync(join(p.web, 'web'), { recursive: true });
  writeFileSync(join(p.web, 'web', file), `${file}\n`);
  box.git(p.web, 'add', '-A');
  box.git(p.web, 'commit', '-q', '-m', `feat(web): ${file} [G1]`);
  await (queued ? box.inProcessQueued : box.inProcess)(p.web, 'submit', String(id), '--no-next');
}

/**
 * The coordinator sends an item back from a checkout of its submitted commit, as a verifier does.
 */
function sendBack(box, p, id, note) {
  box.git(p.repo, 'switch', '-q', '--detach', p.itemBranches.get(`${p.baseBranch}:${id}`) ?? p.branch);
  const item = JSON.parse(box.run(p.repo, 'show', String(id), '--json'));
  const clause = JSON.parse(item.item_frozen).criterion;
  box.run(p.repo, 'verify', String(id), 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--clause', clause, '--note', note, '--as', 'coordinator');
  box.git(p.repo, 'switch', '-q', 'main');
}

/** Include the transport cause, which fetch's top-level error alone conceals. */
function fetchReason(error, seen = new Set()) {
  if (!error || seen.has(error)) return '';
  seen.add(error);
  const detail = `${error.name ?? 'Error'}: ${error.message ?? String(error)}${error.code ? ` (${error.code})` : ''}`;
  const causes = [error.cause, ...(error.errors ?? [])].map((cause) => fetchReason(cause, seen)).filter(Boolean);
  return [detail, ...causes].join('; caused by ');
}

/** Retry a fixture read once after a transport failure; never replay a potentially applied move. */
async function fetchView(url, init = {}) {
  const method = (init.method ?? 'GET').toUpperCase();
  const attempts = method === 'GET' ? 2 : 1;
  const failures = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
    } catch (error) {
      failures.push(`attempt ${attempt}: ${fetchReason(error)}`);
    }
  }
  const address = new URL(url);
  throw new Error(`${method} ${address.origin}${address.pathname} failed after ${attempts} attempt${attempts === 1 ? '' : 's'}; ${failures.join('; ')}`);
}

/** Send a single request to the real view server on a fresh connection, without replaying it. */
function fetchLive(url, init = {}) {
  return fetchFresh(url, init);
}

/** Make the caller's abort reason usable by fetch, event handlers, and owned cleanup. */
function fixtureAbortError(signal, message = 'fixture startup was aborted') {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** Reject promptly on an optional fixture signal while keeping its reason intact. */
function throwIfFixtureAborted(signal) {
  if (signal?.aborted) throw fixtureAbortError(signal);
}

/**
 * Start the production view in this process on a free loopback port, giving this process the machine's environment until stop() is called.
 * Why: the view child cost seconds to start, and the view reads its board registry from the environment on every request, so a
 * browser that reaches it directly needs that environment in place for as long as the view runs [C7,#8362].
 */
async function startViewInProcess(box) {
  const saved = { ...process.env };
  const restore = () => { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, saved); };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, box.env, { PULLBOARD_VIEW_FOREGROUND: '1' });
  let stdout = '';
  let stderr = '';
  let pending;
  let timer;
  let link;
  try {
    const ready = new Promise((found, fail) => {
      timer = setTimeout(() => fail(new Error(`view readiness deadline (30000ms) expired; stderr:\n${stderr}`)), 30_000); // budget: hang ceiling for view readiness; no throughput claim.
      pending = viewMain(['view', '--no-open', '--port', '0', '--json'], {
        cwd: box.dir,
        stdin: process.stdin,
        stdout: { isTTY: false, write(text) {
          stdout += String(text);
          try { found(JSON.parse(stdout)); } catch { /* Wait until the one JSON document is complete. */ }
          return true;
        } },
        stderr: { isTTY: false, write(text) { stderr += String(text); return true; } },
      }).then((code) => { fail(new Error(`view exited before readiness with code ${code}; stderr:\n${stderr}`)); return code; }, (error) => { fail(error); });
    });
    link = new URL((await ready).url);
  } catch (error) {
    clearTimeout(timer);
    process.emit('SIGTERM');
    await pending;
    restore();
    throw error;
  }
  clearTimeout(timer);
  let stopped;
  /** Stop this view once and put the previous environment back. */
  const stop = () => {
    stopped ??= (async () => { process.emit('SIGTERM'); await pending; restore(); })();
    return stopped;
  };
  let cookie;
  try {
    const opened = await fetchLive(link, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    assert.equal(opened.status, 303, 'the printed link exchanges its key');
    cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0];
    await opened.arrayBuffer();
    const ready = await fetchLive(new URL(opened.headers.get('location') ?? '/', link), { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
    assert.equal(ready.status, 200, 'the view answers before the test fetches its page');
    await ready.arrayBuffer();
  } catch (error) {
    await stop();
    throw error;
  }
  return { link, key: link.searchParams.get('k'), cookie, base: `http://127.0.0.1:${link.port}`, stop };
}

/** Start the real view and wait for a complete HTTP answer, rather than just its printed link; inProcess runs it in this process instead of a child [C7]. */
async function startView(box, { bin = BIN, signal, onOwned, inProcess = false } = {}) {
  if (inProcess) return startViewInProcess(box);
  throwIfFixtureAborted(signal);
  const child = spawn(process.execPath, [bin, 'view', '--no-open', '--port', '0'], { cwd: box.dir, env: { ...box.env, PULLBOARD_VIEW_FOREGROUND: '1' } });
  let stopPromise;
  let rejectStartup;
  const abortStartup = () => {
    void stop();
    rejectStartup?.(fixtureAbortError(signal));
  };
  /** Stop only this fixture's already-owned view child, at most once. */
  const stop = () => {
    if (stopPromise) return stopPromise;
    signal?.removeEventListener('abort', abortStartup);
    stopPromise = new Promise((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done();
      child.once('exit', done);
      child.kill('SIGTERM');
    });
    return stopPromise;
  };
  let cookie;
  try { onOwned?.(stop); }
  catch (error) { await stop(); throw error; }
  signal?.addEventListener('abort', abortStartup, { once: true });
  let link;
  try {
    link = await new Promise((found, fail) => {
      let out = '';
      rejectStartup = fail;
      const cleanup = () => {
        child.stdout.off('data', onData);
        child.off('exit', onExit);
        signal?.removeEventListener('abort', onAbort);
        rejectStartup = null;
      };
      const onData = (chunk) => {
        out += chunk;
        const match = /Pullboard view: (http:\/\/127\.0\.0\.1:\d+\/\?k=\S+)/.exec(out);
        if (match) { cleanup(); found(new URL(match[1])); }
      };
      const onExit = (code) => { cleanup(); fail(new Error(`view exited ${code}: ${out}`)); };
      const onAbort = () => {
        const error = fixtureAbortError(signal);
        cleanup();
        void stop();
        fail(error);
      };
      child.stdout.on('data', onData);
      child.on('exit', onExit);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
    throwIfFixtureAborted(signal);
    const opened = await fetchLive(link, { redirect: 'manual', signal: signal
      ? AbortSignal.any([AbortSignal.timeout(30_000), signal]) : AbortSignal.timeout(30_000) });
    assert.equal(opened.status, 303, 'the printed link exchanges its key');
    cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0];
    await opened.arrayBuffer();
    const ready = await fetchLive(new URL(opened.headers.get('location') ?? '/', link), { headers: { cookie }, signal: signal
      ? AbortSignal.any([AbortSignal.timeout(30_000), signal]) : AbortSignal.timeout(30_000) });
    assert.equal(ready.status, 200, 'the view answers before the test fetches its page');
    await ready.arrayBuffer();
  } catch (error) {
    await stop();
    throw error;
  }
  return { link, key: link.searchParams.get('k'), cookie, base: `http://127.0.0.1:${link.port}`, stop };
}

/**
 * The page's stylesheet as the view serves it, behind its secret.
 */
async function styleOf(view) {
  return (await fetchLive(`${view.base}/view.css`, { headers: { 'x-pullboard-key': view.key } })).text();
}

/**
 * Fetch one of the view's own pages at its clean address, as the browser does once the printed link has
 * traded its key for the session cookie (N39).
 *
 * @param {{ base: string, cookie?: string }} view
 * @param {string} [path]
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
function fetchPage(view, path = '/', init = {}) {
  return fetchLive(`${view.base}${path}`, { ...init, headers: { ...init.headers, ...(view.cookie ? { cookie: view.cookie } : {}) } });
}

/**
 * An element as the page's script uses one: what it writes, how often it rewrote its markup, its
 * classes and attributes, the listeners it adds, and how often it was scrolled into view.
 */
function element(id) {
  const classes = new Set();
  let html = '';
  let text = '';
  return {
    id,
    // A browser keeps both as strings, whatever the script assigns.
    get innerHTML() { return html; },
    set innerHTML(value) { html = String(value ?? ''); this.writes += 1; },
    writes: 0,
    // A change to a node inside, which leaves the rest of the markup where it is.
    patch(change) { html = change(html); },
    get textContent() { return text; },
    set textContent(value) { text = String(value ?? ''); },
    value: '',
    hidden: false,
    dataset: {},
    style: {},
    attributes: {},
    listeners: {},
    scrolled: 0,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force = !classes.has(name)) => {
        if (force) classes.add(name);
        else classes.delete(name);
        return force;
      },
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); },
    focus() {},
    scrollIntoView() { this.scrolled += 1; },
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
    // The palette's search box hint is added beside its box.
    parentNode: { appendChild() {} },
    querySelectorAll: () => [],
    querySelector: () => null,
    prepend() {},
    // The notch preview appends its veil and panel to the body and listens on the element and its document [#6651].
    append() {},
    contains: () => false,
    removeEventListener() {},
    replaceWith() {},
  };
}

/**
 * The ages an element holds, as the nodes a browser would hand the page for [data-ago]: each knows
 * the moment it counts from, and setting its text changes that node alone.
 */
function ageNodes(element) {
  const AGE = /<time((?: class="[^"]*")?) data-ago="([^"]*)"([^>]*)>([^<]*)<\/time>/g;
  return [...element.innerHTML.matchAll(AGE)].map((match, n) => ({
    dataset: { ago: match[2] },
    classList: { contains: (name) => (/class="([^"]*)"/.exec(match[1])?.[1] ?? '').split(' ').includes(name) },
    set textContent(text) {
      let k = 0;
      element.patch((html) => html.replace(AGE, (whole, cls, at, rest) => (k++ === n ? `<time${cls} data-ago="${at}"${rest}>${text}</time>` : whole)));
    },
  }));
}

/**
 * What a click lands on: an element with these data attributes, this id, and these classes on it
 * or its ancestors, as the page's closest() calls find it.
 */
function target({ id = '', classes = '', ...data }) {
  const matches = (selector) => {
    if (selector.startsWith('#')) return selector.slice(1) === id;
    if (selector.startsWith('.')) return classes.split(' ').includes(selector.slice(1));
    // A click target is never the root element, so a `:not(:root)` guard on a data selector always holds.
    const attribute = /^\[data-([a-z-]+)\](?::not\(:root\))?$/.exec(selector);
    return attribute ? attribute[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) in data : false;
  };
  const self = { id, dataset: data, hasAttribute: name => matches('[' + name + ']'), closest: (selectors) => (selectors.split(',').some((selector) => matches(selector.trim())) ? self : null) };
  return self;
}

/**
 * Wait until the page has no request out and its answers have been rendered.
 */
async function settle(inflight) {
  for (let quiet = 0; quiet < 3; quiet = inflight.size ? 0 : quiet + 1) {
    if (inflight.size) await Promise.allSettled([...inflight]);
    await new Promise((done) => setImmediate(done));
  }
}

/**
 * A browser's local storage for the page. The test keeps it, so a second load of the page finds
 * what the first one left, as after a reload.
 */
function storage() {
  const items = new Map();
  return { getItem: (key) => (items.has(key) ? items.get(key) : null), setItem: (key, value) => { items.set(key, String(value)); } };
}

/**
 * The browser's Date with its clock moved some days on, as the page would read it then.
 */
function daysOn(days) {
  const shift = days * 86_400_000;
  return class extends Date {
    constructor(...args) {
      super(...(args.length ? args : [Date.now() + shift]));
    }

    static now() {
      return Date.now() + shift;
    }
  };
}

/**
 * Open the page a view serves, at a window width, and wait for its first board; `later` moves the
 * page's clock that many days on, and `store` is its local storage, if it has one. With `hold`, the
 * page's requests wait for release(), so the page shows as it is before its first board. show(id)
 * is what that region holds; click() and type() act as the person would.
 */
async function openPage(view, { width = 1280, later = 0, store = null, hold = false } = {}) {
  const session = view.cookie ? { cookie: view.cookie } : {};
  const html = await (await fetchLive(view.cookie ? new URL('/', view.link) : view.link, { headers: session, signal: AbortSignal.timeout(30_000) })).text();
  const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const known = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const elements = new Map();
  const node = (id) => {
    if (!elements.has(id)) elements.set(id, Object.assign(element(id), { ownerDocument: document }));
    return elements.get(id);
  };
  const clicks = [];
  const inflight = new Set();
  const requests = [];
  const document = {
    body: Object.assign(element('body'), { appendChild() {} }),
    documentElement: element('html'),
    hidden: false,
    getElementById: (id) => (known.has(id) ? node(id) : null),
    // The palette builds its overlay at load: a created element is a plain node the page may append and listen on.
    createElement: () => Object.assign(element('created'), { ownerDocument: document }),
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === '[data-ago]' ? [...elements.values()].flatMap(ageNodes) : []),
    addEventListener: (type, listener) => { if (type === 'click') clicks.push(listener); },
  };
  document.body.ownerDocument = document;
  // The body starts with the classes its markup gives it, as at first paint.
  for (const name of (/<body class="([^"]*)">/.exec(html)?.[1] ?? '').split(' ').filter(Boolean)) document.body.classList.add(name);
  let release = () => {};
  const held = new Promise((done) => { release = done; });
  if (!hold) release();
  // The page's own timers, so close() can stop a page whose server is gone: its retry timers re-arm forever and
  // would keep the test file's process from exiting (#8027).
  const timers = new Set();
  let closed = false;
  /** Run a page timer like the browser's, held so close() can cancel it. */
  const pageTimeout = (callback, ms, ...args) => {
    if (closed) return 0;
    const timer = setTimeout(() => { timers.delete(timer); callback(...args); }, ms);
    timers.add(timer);
    return timer;
  };
  /** Cancel a page timer the page itself clears. */
  const pageClearTimeout = (timer) => { timers.delete(timer); clearTimeout(timer); };
  const context = vm.createContext({
    document,
    location: { search: '' },
    navigator: { platform: '', userAgent: '' },
    URLSearchParams,
    structuredClone,
    innerWidth: width,
    innerHeight: 800,
    matchMedia: (query) => ({ matches: width <= Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? Infinity) }),
    setInterval: () => 0,
    ...(later ? { Date: daysOn(later) } : {}),
    ...(store ? { localStorage: store } : {}),
    setTimeout: pageTimeout,
    clearTimeout: pageClearTimeout,
    fetch: (path, init = {}) => {
      requests.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
      const answer = held.then(() => fetchLive(`${view.base}${path}`, { ...init, headers: { ...init.headers, ...session }, signal: init.signal ?? AbortSignal.timeout(30_000) })).then(async (res) => {
        const body = await res.json();
        return { ok: res.ok, status: res.status, headers: res.headers, json: async () => body };
      });
      inflight.add(answer);
      const done = () => inflight.delete(answer);
      answer.then(done, done);
      return answer;
    },
  });
  // The page reads window.scrollY to keep the reading position; this page never scrolls.
  context.scrollY = 0;
  context.window = context;
  vm.runInContext(script, context);
  if (!hold) await settle(inflight);
  return {
    html,
    requests,
    /** Stop the page as closing its tab would: no timer it set, or sets later, runs. */
    close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
    // Let the held requests go, and wait for what they bring.
    async release() {
      release();
      await settle(inflight);
    },
    show: (id) => node(id).innerHTML,
    element: node,
    run: (code) => vm.runInContext(code, context),
    async click(on) {
      const event = { target: target(on) };
      for (const listener of clicks) listener(event);
      await settle(inflight);
    },
    async type(id, text) {
      node(id).value = text;
      for (const listener of node(id).listeners.input ?? []) listener({ target: node(id) });
      await settle(inflight);
    },
    // A click on a button with its own listener, or a form's submit.
    async fire(id, type) {
      for (const listener of node(id).listeners[type] ?? []) listener({ target: node(id), preventDefault() {} });
      await settle(inflight);
    },
  };
}

/**
 * The project rows the sidebar shows: name, needs count, the line under it, and which is current.
 */
function projectRows(html) {
  return html.split('<button').slice(1).map((row) => {
    const small = /<small[^>]*>([^]*?)<\/small>/.exec(row)?.[1] ?? '';
    const asks = /<span class="asks">([^<]*)<\/span>/.exec(small)?.[1] ?? '';
    return {
      root: /data-root="([^"]*)"/.exec(row)?.[1],
      name: /class="pname">([^<]*)</.exec(row)?.[1],
      // What needs the person leads the line in the warning colour; their count is the sum of its parts.
      needs: asks ? String(asks.split(' · ').reduce((n, part) => n + Number(/^\d+/.exec(part)?.[0] ?? 0), 0)) : '',
      line: small.replace(/<[^>]*>/g, ''),
      current: /aria-current="true"/.test(row),
    };
  });
}
/**
 * The products the sidebar shows: name, rows met, how full the bar is, and the item counts with the
 * state each dot is coloured for.
 */
function productEntries(html) {
  return html.split('<div class="prod"').slice(1).map((entry) => ({
    name: /<b>([^<]*)<\/b>/.exec(entry)?.[1],
    met: /<span>([^<]*) rows met<\/span>/.exec(entry)?.[1],
    bar: Number(/<rect width="(\d+)" height="1"\/>/.exec(entry)?.[1]),
    items: [...entry.matchAll(/<span><i class="dot ([a-z]*)"><\/i>(\d+) ([a-z ]+)<\/span>/g)].map((match) => `${match[2]} ${match[3]} (${match[1] || 'grey'})`),
  }));
}
/**
 * An item's timeline as rows: the state classes on its dot, its time, its event, who made it, and the
 * stay it began, with any running age read as its text.
 */
function timelineRows(html) {
  return [...html.matchAll(/<li class="([^"]*)"[^>]*><span class="tl-marker [^]*?<span class="tl-sentence">([^]*?)<\/span><time>([^<]*)<\/time><\/div>(?:<small>([^]*?)<\/small>)?[^]*?<\/li>/g)].map((match) => ({
    dot: match[1],
    time: match[3],
    event: match[2].replace(/<span class="tl-kind[^]*?<\/span>/g, '').replace(/<[^>]*>/g, '').trim(),
    stay: (match[4] ?? '').replace(/<time data-ago="[^"]+">([^<]*)<\/time>/, '$1'),
  }));
}
/**
 * The agents the panel shows: id, the path on hover, its last move, what it holds and how many more,
 * whether it reads idle, and its entry's text with the tags taken out. An agent holding work is a row
 * showing its first thing, or every thing once picked; an agent holding nothing is a pill.
 */
function agentEntries(html) {
  const rows = html.split(/<div class="agent-card[^"]*">/).slice(1).map((entry) => {
    /** Read the approved stage and its explanatory marks from an agent's item presentation. */
    const stage = (html) => {
      const word = /<b class="stage-word">([^<]*)<\/b>/.exec(html)?.[1] || '';
      const marks = [...html.matchAll(/class="stage-mark[^\"]*"[^>]*>([^<]*)<\/span>/g)].map((mark) => mark[1]);
      return [word, ...marks].filter(Boolean).join(' · ');
    };
    const opened = [...entry.matchAll(/class="agent-work" data-item="(\d+)"[^>]*><span>([^]*?)<\/span>([^]*?)<\/div>/g)]
      .map((match) => `${match[2]}: ${stage(match[3])}`);
    // The stage is beside the name; what the agent holds follows at the full width.
    const what = /<span class="agent-what"><i>(#\d+)<\/i> ([^]*?)<\/span>/.exec(entry);
    const word = /<span class="agent-state">([^]*?)<span class="agent-doing">/.exec(entry)?.[1];
    const first = what && word ? [null, what[1], what[2], stage(word)] : null;
    return {
      id: /data-agent="([^"]*)"/.exec(entry)?.[1],
      path: /title="Shouts with [^"]* \(([^"()]*)\)(?: · \+\d+ more items?)?"/.exec(entry)?.[1],
      age: /<time[^>]*>([^<]*)<\/time>/.exec(entry)?.[1],
      holds: opened.length ? opened : first ? [`${first[1]} ${first[2]}: ${first[3]}`] : [],
      more: Number(/title="[^"]* · \+(\d+) more items?"/.exec(entry)?.[1] ?? 0),
      idle: false,
      text: entry.replace(/<[^>]*>/g, ' '),
    };
  });
  const pills = [...html.matchAll(/<button class="agent-pill[^"]*" data-agent="([^"]*)" title="[^"]* \(([^"]*)\)"[^>]*>([^]*?)<\/button>/g)]
    .map((match) => ({ id: match[1], path: match[2], age: undefined, holds: [], more: 0, idle: true, text: match[3].replace(/<[^>]*>/g, ' ') }));
  return [...rows, ...pills];
}
/**
 * The lifecycle drawing: each box's state, title, count, the moves that keep it and whether it has a
 * second border; each route's title, the pair of states its title starts with, its class, its
 * points, and the words drawn with it, if any; and what the box of the first state says came back.
 */
function drawing(svg) {
  return {
    boxes: [...svg.matchAll(/<g class="s-([^"]+)"><title>([^<]*)<\/title>([^]*?)<\/g>(?=<g class="s-|<\/svg>)/g)].map((match) => ({
      state: match[1],
      title: match[2],
      count: Number(/<text class="n"[^>]*>(\d+)<\/text>/.exec(match[3])[1]),
      keeps: [...match[3].matchAll(/<text class="keep( idle)?"[^>]*>([^<]*)<\/text>/g)].map((line) => line[2].trim()).join(' ') + (/class="keep idle"/.test(match[3]) ? ' (none yet)' : ''),
      double: match[3].includes('<rect class="box inner"'),
    })),
    routes: [...svg.matchAll(/<g><title>([^<]*)<\/title><path class="edge([^"]*)" d="([^"]*)"[^>]*\/>((?:<text class="tag[^"]*"[^>]*>[^<]*<\/text>)*)<\/g>/g)].map((match) => ({
      title: match[1],
      pair: /^[\w-]+, (\w+) to (\w+),/.exec(match[1]).slice(1).join('>'),
      back: match[2] === ' back',
      points: [...match[3].matchAll(/([\d.]+) ([\d.]+)/g)].map((point) => [Number(point[1]), Number(point[2])]),
      label: match[4] ? [...match[4].matchAll(/>([^<]*)<\/text>/g)].map((line) => line[1]).join(' · ') + (match[4].includes(' idle') ? ' (none yet)' : '') : null,
    })),
    sentBack: /<text class="sub"[^>]*>([^<]*)<\/text>/.exec(svg)?.[1],
  };
}

/**
 * Where each piece of text in a drawing sits: its words, and a box from a little above its baseline
 * to a little below, as wide as the widest a font is likely to set it at the size its class gives.
 */
function textBoxes(svg) {
  const sizes = { tag: [12, 0.58], keep: [11, 0.58], sub: [11, 0.58], name: [11, 0.7], n: [22, 0.64] };
  return [...svg.matchAll(/<text class="([^"]+)" x="([\d.-]+)" y="([\d.-]+)" text-anchor="(start|middle|end)">([^<]*)<\/text>/g)].map(([, cls, x, y, anchor, words]) => {
    const [size, per] = sizes[cls.split(' ')[0]];
    const width = words.replace(/&[a-z#0-9]+;/g, '&').length * size * per;
    const left = anchor === 'start' ? Number(x) : anchor === 'end' ? Number(x) - width : Number(x) - width / 2;
    return { words, inside: cls !== 'tag' && !cls.startsWith('tag '), left, right: left + width, top: Number(y) - size * 0.8, bottom: Number(y) + size * 0.25 };
  });
}

/** Whether two boxes, each with left, right, top and bottom, come within a gap of each other. */
const meet = (a, b, gap = 0) => a.left - gap < b.right && b.left - gap < a.right && a.top - gap < b.bottom && b.top - gap < a.bottom;
/**
 * The coordinator accepts an item from a checkout of its submitted commit.
 */
function accept(box, p, id) {
  box.git(p.repo, 'switch', '-q', '--detach', p.itemBranches.get(`${p.baseBranch}:${id}`) ?? p.branch);
  box.run(p.repo, 'verify', String(id), 'accept', '--note', 'the page shows it', '--as', 'coordinator');
  box.git(p.repo, 'switch', '-q', 'main');
}

/**
 * The in-process twin of accept: the coordinator's accept, awaited in this process instead of launched.
 */
async function acceptLocal(box, p, id) {
  box.git(p.repo, 'switch', '-q', '--detach', p.itemBranches.get(`${p.baseBranch}:${id}`) ?? p.branch);
  await box.inProcess(p.repo, 'verify', String(id), 'accept', '--note', 'the page shows it', '--as', 'coordinator');
  box.git(p.repo, 'switch', '-q', 'main');
}

/**
 * One item's row in the list, or '' when the list does not show it.
 */
function needEntries(html) {
  return [...html.matchAll(/<li class="row ask"(?: data-go="([^"]*)")?><span class="dot ask"><\/span><div><div class="t">(?:<span>([^<]*)<\/span>)?([^]*?)<\/div>(?:<span class="row-age">[^]*?<\/span>)?<div class="meta"><span class="why"><b>NEEDS YOU<\/b> ([^<]*)<\/span><\/div><\/div><span class="chip warn">([^<]*)<\/span><\/li>/g)]
    .map((row) => [row[1] ?? null, row[2] ?? null, row[3], row[4], row[5]]);
}

/** Open the Items page's collapsed questions-and-sentinels group so its rows can be pressed and measured [N26]. */
async function openItemsNeeds(chrome) {
  await chrome.waitFor("(() => { const group = document.querySelector('#needs details[data-items-needs]'); if (group && !group.open) group.open = true; return !!group?.open; })()");
}

/**
 * One item's row in the list, or '' when the list does not show it.
 */
function itemRow(html, id) {
  return html.split('<li').find((row) => row.includes(`data-item="${id}"`)) ?? '';
}

/**
 * The persistent API identity for a registered project, or an intentionally absent test identity.
 */
async function boardId(view, root) {
  const response = await fetchLive(`${view.base}/api/v1/boards`, { headers: { 'x-pullboard-key': view.key } });
  assert.equal(response.status, 200);
  return (await response.json()).boards.find((board) => board.root === root)?.id ?? 'not-registered';
}

/** The board as the shared API serves it for one project. */
async function boardOf(view, root) {
  const id = await boardId(view, root);
  const res = await fetchLive(`${view.base}/api/v1/boards/${id}/state?detail=full`, { headers: { 'x-pullboard-key': view.key } });
  assert.equal(res.status, 200);
  return (await res.json()).state;
}

/** Check each reported queue age before comparing observations, so independent clocks stay exact. */
function assertObservationAges(observation) {
  if (Object.hasOwn(observation ?? {}, 'observedAt')) {
    assert.equal(typeof observation.observedAt, 'string', 'project.observedAt is a read timestamp');
    assert.ok(Number.isFinite(Date.parse(observation.observedAt)), 'project.observedAt is a valid read timestamp');
  }
  const flow = observation?.proofStats?.flow;
  for (const [state, queue] of Object.entries(flow?.queues ?? {})) {
    const oldest = queue?.oldest;
    if (!oldest || !Object.hasOwn(oldest, 'ageMinutes')) continue;
    const label = `project.proofStats.flow.queues.${state}.oldest`;
    assert.equal(typeof flow.asOf, 'string', `${label} has flow.asOf`);
    assert.equal(typeof oldest.since, 'string', `${label} has oldest.since`);
    const asOf = Date.parse(flow.asOf);
    const since = Date.parse(oldest.since);
    assert.ok(Number.isFinite(asOf), `${label} has a valid flow.asOf timestamp`);
    assert.ok(Number.isFinite(since), `${label} has a valid oldest.since timestamp`);
    assert.equal(oldest.ageMinutes, (asOf - since) / 60000, `${label}.ageMinutes matches its own asOf and since`);
  }
}

/** Remove only observation clocks and derived ages while preserving all invariant fields. */
function withoutObservationAges(value, path = []) {
  if (Array.isArray(value)) return value.map((entry, index) => withoutObservationAges(entry, [...path, String(index)]));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => {
      const flowClock = path.length === 2 && path[0] === 'proofStats' && path[1] === 'flow' && key === 'asOf';
      const queueAge = path.length === 5 && path[0] === 'proofStats' && path[1] === 'flow'
        && path[2] === 'queues' && path[4] === 'oldest' && key === 'ageMinutes';
      const readClock = path.length === 0 && key === 'observedAt';
      return !flowClock && !queueAge && !readClock;
    })
    .map(([key, entry]) => [key, withoutObservationAges(entry, [...path, key])]));
}

/** Validate clocks independently, then compare every field except declared observation stamps and derived ages. */
function assertObservationsEqual(expected, actual, message) {
  assertObservationAges(expected);
  assertObservationAges(actual);
  assert.deepEqual(withoutObservationAges(actual), withoutObservationAges(expected), message);
}

/** Unwrap only the name layout spans so full-card assertions keep checking their text and structure. */
function shoutNameText(html) {
  return html.replace(/<span class="agent-address" role="group" aria-label="[^"]*">([^<]*)<\/span>/g, '$1').replace(/<span class="agent-label(?: prefix)?" title="[^"]*" role="group" aria-label="[^"]*"><span class="agent-(?:id|model)">([^]*?)<\/span><span class="agent-(?:id|model)">([^]*?)<\/span><\/span>/g, '$1$2');
}

/** Find an installed Chrome without making browser availability a product-test failure. */
function chromeExecutable() {
  return [process.env.PULLBOARD_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find((candidate) => candidate && existsSync(candidate));
}

/** Wait briefly without retaining a timer after the wait completes. */
function browserPause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Start Chrome, retry once, and wait for its DevTools port before giving up. */
async function startSnapshotChrome(executable, profile, { timeoutMs = 30_000, signal, onOwned } = {}) {
  throwIfFixtureAborted(signal);
  const args = chromeLaunchArgs(profile);
  let lastFailure = '';
  let lastFailureKind = '';
  const firstLaunchStartedAt = Date.now();
  const launchAttempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    throwIfFixtureAborted(signal);
    if (attempt > 1) {
      process.stderr.write(`${JSON.stringify({ event: 'chrome-relaunch', attempt, elapsedMs: Date.now() - firstLaunchStartedAt,
        previousFailure: lastFailureKind })}\n`);
      rmSync(join(profile, 'DevToolsActivePort'), { force: true });
    }
    const startedAt = Date.now();
    requireBrowserSlot();
    const child = spawn(executable, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    if (child.pid) guardChromeGroup(child.pid, { profile });
    const stopped = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    let stopPromise;
    let onAbort;
    /** Stop only this launch's owned Chrome group, at most once. */
    const stop = () => {
      if (stopPromise) return stopPromise;
      signal?.removeEventListener('abort', onAbort);
      stopPromise = (async () => {
        await quitOwnedChrome(child, profile, stopped);
        await stopOwnedChrome(child, stopped);
      })();
      return stopPromise;
    };
    onAbort = () => { void stop().catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try { onOwned?.(stop); }
    catch (error) { await stop(); throw error; }
    if (signal?.aborted) {
      await stop();
      throw fixtureAbortError(signal);
    }
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_192); });
    let exit;
    const deadline = Date.now() + timeoutMs;
    let port;
    while (Date.now() < deadline) {
      if (signal?.aborted) break;
      try {
        const candidate = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
        if (/^\d+$/.test(candidate) && child.exitCode === null && child.signalCode === null) {
          port = candidate;
          break;
        }
      } catch { /* Chrome has not published its port yet. */ }
      const remaining = Math.max(1, deadline - Date.now());
      exit = await Promise.race([
        stopped.then((status) => ({ status })),
        browserPause(Math.min(100, remaining)).then(() => null),
      ]);
      if (exit) break;
    }
    if (port) {
      if (signal?.aborted) {
        await stop();
        throw fixtureAbortError(signal);
      }
      launchAttempts.push({ attempt, elapsedMs: Date.now() - startedAt, portPublished: true });
      return { child, stopped, port, startedAt, launchAttempts, stderr: () => stderr, stop };
    }
    const details = [stderr.trim(), exit?.status?.signal && `signal ${exit.status.signal}`,
      exit?.status && exit.status.code !== null && `exit ${exit.status.code}`].filter(Boolean).join('; ') || 'no stderr';
    lastFailure = exit
      ? `Chrome exited before publishing DevToolsActivePort (${details})`
      : `Chrome did not publish DevToolsActivePort within ${timeoutMs}ms (${details})`;
    lastFailureKind = exit ? 'process-exited-before-devtools-port' : 'devtools-port-timeout';
    launchAttempts.push({ attempt, elapsedMs: Date.now() - startedAt, portPublished: false,
      failure: lastFailureKind, exitCode: exit?.status?.code ?? null, signal: exit?.status?.signal ?? null });
    await stop();
    if (signal?.aborted) throw fixtureAbortError(signal);
  }
  throw new Error(`Chrome failed to start after 2 launches; attempts: ${JSON.stringify(launchAttempts)}; final stderr: ${lastFailure}`);
}

/** Read a bounded, sanitized view of DevTools targets after a command times out. */
async function snapshotDevToolsTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) });
  if (!response.ok) throw new Error(`target list returned HTTP ${response.status}`);
  const targets = await response.json();
  if (!Array.isArray(targets)) throw new Error('target list was not an array');
  return targets.slice(0, 20).map((target) => {
    let safeUrl = { scheme: 'unknown', path: '', omitted: true };
    try {
      const parsed = new URL(target.url ?? '');
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        safeUrl = { scheme: parsed.protocol.slice(0, -1), path: parsed.pathname.slice(0, 160), omitted: false };
      } else if (parsed.protocol === 'about:' && parsed.pathname === 'blank') {
        safeUrl = { scheme: 'about', path: 'about:blank', omitted: false };
      } else {
        safeUrl = { scheme: parsed.protocol.slice(0, 20).replace(/:$/, '') || 'unknown', path: '', omitted: true };
      }
    } catch { /* A malformed target URL is still represented by its type and id. */ }
    return { id: String(target.id ?? '').slice(0, 80), type: String(target.type ?? '').slice(0, 40), url: safeUrl };
  });
}

/** Start one isolated headless Chrome and expose its page through a small CDP client. */
async function openSnapshotChrome(executable, url, profile, { signal, onOwned } = {}) {
  throwIfFixtureAborted(signal);
  let socket;
  let childStop;
  let closePromise;
  let removeAbortListener = () => {};
  /** Close this launch's socket and process group once, even across startup failure and caller cleanup. */
  const closeOwned = () => {
    if (closePromise) return closePromise;
    removeAbortListener();
    closePromise = (async () => {
      socket?.close();
      if (childStop) await childStop();
    })();
    return closePromise;
  };
  const onAbort = () => { void closeOwned().catch(() => {}); };
  const launched = await startSnapshotChrome(executable, profile, {
    signal,
    onOwned(stop) {
      childStop = stop;
      signal?.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal?.removeEventListener('abort', onAbort);
      try { onOwned?.(closeOwned); }
      catch (error) { void closeOwned().catch(() => {}); throw error; }
    },
  });
  const { child, stopped, port } = launched;
  let pageTargetEverAppearedBeforeTimeout = false;
  let pageTargetAppearedAtElapsedMs = null;
  let id = 0;
  const pending = new Map();
  const requests = [];
  const exceptions = [];
  try {
    throwIfFixtureAborted(signal);
    const startupFetchSignal = signal
      ? AbortSignal.any([AbortSignal.timeout(10_000), signal]) : AbortSignal.timeout(10_000);
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT', signal: startupFetchSignal })).json();
    if (target.type === 'page') {
      pageTargetEverAppearedBeforeTimeout = true;
      pageTargetAppearedAtElapsedMs = Date.now() - launched.startedAt;
    }
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('DevTools socket failed')); };
      const abort = () => { cleanup(); reject(fixtureAbortError(signal)); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('DevTools socket did not open')); }, 10_000); // budget: hang ceiling for the local DevTools socket-open handshake; no throughput claim.
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
      }
      if (message.method === 'Network.requestWillBeSent') {
        const request = message.params.request;
        requests.push({ method: request.method, url: request.url, headers: request.headers ?? {} });
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        exceptions.push(details.exception?.description ?? details.text);
      }
    });
    /** Send one CDP command and clear its timeout on either response or failure. */
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(fixtureAbortError(signal)); return; }
      const key = ++id;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        pending.delete(key);
      };
      const abort = () => { cleanup(); reject(fixtureAbortError(signal)); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`DevTools timed out: ${method}`)); }, 45_000); // budget: hang ceiling for one unanswered DevTools command; no throughput claim.
      pending.set(key, { resolve: (value) => { cleanup(); resolve(value); }, reject: (error) => { cleanup(); reject(error); }, timer });
      signal?.addEventListener('abort', abort, { once: true });
      try { socket.send(JSON.stringify({ id: key, method, params })); }
      catch (error) { cleanup(); reject(error); }
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    const firstStateDelayMs = Number(process.env.PULLBOARD_CHROME_FIRST_STATE_DELAY_MS ?? 0);
    if (Number.isSafeInteger(firstStateDelayMs) && firstStateDelayMs > 0 && firstStateDelayMs <= 30_000) {
      await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
        const nativeFetch = window.fetch.bind(window); let delayed = false;
        window.fetch = (input, init) => {
          const url = typeof input === 'string' ? input : input.url;
          const path = new URL(url, location.href).pathname;
          if (!delayed && /^\\/api\\/v1\\/boards\\/[^/]+\\/state$/.test(path)) {
            delayed = true;
            const state = window.__pullboardFirstStateDelay = { started: performance.now(), ended: null };
            return new Promise((resolve, reject) => setTimeout(() => {
              state.ended = performance.now();
              nativeFetch(input, init).then(resolve, reject);
            }, ${firstStateDelayMs}));
          }
          return nativeFetch(input, init);
        };
      })()` });
    }
    const chrome = await stableChrome({ child, stopped, socket, send, requests, exceptions });
    chrome.launchAttempts = launched.launchAttempts;
    chrome.stderr = launched.stderr;
    chrome.startedAt = launched.startedAt;
    chrome.close = closeOwned;
    await chrome.send('Page.navigate', { url });
    await chrome.waitFor("matchMedia('(prefers-reduced-motion: reduce)').matches");
    return chrome;
  } catch (error) {
    let message = error.message;
    if (/^DevTools timed out: /.test(message)) {
      const timeoutObservedAt = Date.now();
      const capture = {
        rootCauseStatus: 'NOT PROVEN',
        timeoutObservedAt,
        timeoutElapsedMsSinceLaunch: timeoutObservedAt - launched.startedAt,
        pageTargetEverAppearedBeforeTimeout,
        pageTargetAppearedAtElapsedMs,
        launchAttempts: launched.launchAttempts,
      };
      try {
        capture.targetListRequestStartedAt = Date.now();
        capture.targetListRequestStartedElapsedMs = capture.targetListRequestStartedAt - launched.startedAt;
        capture.targets = await snapshotDevToolsTargets(port);
        capture.targetListObservedAt = Date.now();
        capture.targetListObservedElapsedMs = capture.targetListObservedAt - launched.startedAt;
        capture.pageTargetObservedInTimeoutList = capture.targets.some((entry) => entry.type === 'page');
      } catch (captureError) {
        capture.targetListObservedAt = Date.now();
        capture.targetListObservedElapsedMs = capture.targetListObservedAt - launched.startedAt;
        capture.pageTargetObservedInTimeoutList = null;
        capture.targetListError = `${captureError.name}: ${captureError.message}`;
      }
      message = `${message}; ROOT-CAUSE STATUS: NOT PROVEN; Chrome timeout capture ${JSON.stringify(capture)}`;
    }
    await closeOwned();
    const chromeStderr = launched.stderr().trim();
    throw new Error(chromeStderr ? `${message}; Chrome stderr: ${chromeStderr}` : message, { cause: error });
  }
}

/** Check the owned group, since a leader's close event also waits for inherited pipes. */
function ownedChromeGroupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    // A permission error cannot prove that Chrome's sandboxed helpers have exited.
    return error.code !== 'ESRCH';
  }
}

/** Bound the whole group's lifetime, including helpers whose leader has already exited. */
async function waitForOwnedChromeGroup(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (ownedChromeGroupAlive(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await browserPause(Math.min(20, remaining));
  }
  return true;
}

/** Name surviving group members without exposing any browser arguments or profile paths. */
function ownedChromeGroupPids(pid) {
  const rows = execFileSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' });
  return rows.trim().split('\n').map(row => row.trim().split(/\s+/u))
    .filter(row => Number(row[1]) === pid).map(row => Number(row[0]));
}

/** Stop only an owned Chrome group, then release pipes held by independent crash reporters. */
async function stopOwnedChrome(child, stopped, { timeoutMs = 5_000, signal = process.kill } = {}) {
  const pid = child.pid;
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Chrome cleanup requires its owned group leader pid');
  const startedAt = Date.now();
  /** An already-exited group needs no signal; other signal failures must stay visible. */
  const send = name => {
    try { signal(-pid, name); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  if (ownedChromeGroupAlive(pid)) send('SIGTERM');
  if (!await waitForOwnedChromeGroup(pid, timeoutMs)) {
    send('SIGKILL');
    if (!await waitForOwnedChromeGroup(pid, timeoutMs)) {
      const pids = ownedChromeGroupPids(pid);
      throw new Error(`owned Chrome group ${pid} did not exit after SIGKILL; waited ${Date.now() - startedAt}ms; live pids: ${pids.join(', ') || 'none at final capture'}`);
    }
  }
  // An independent process can inherit stderr without belonging to the owned Chrome group.
  child.stderr?.destroy();
  let timer;
  try {
    const closed = await Promise.race([stopped.then(() => true), new Promise(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    })]);
    assert.ok(closed, `owned Chrome group ${pid} is gone but its leader did not close; waited ${Date.now() - startedAt}ms`);
  } finally { clearTimeout(timer); }
}

/** Close the CDP socket and stop only this test's isolated Chrome process group. */
async function closeSnapshotChrome(chrome) {
  if (typeof chrome.close === 'function') return chrome.close();
  chrome.socket.close();
  await stopOwnedChrome(chrome.child, chrome.stopped);
}

/** Capture bounded, sanitized browser state only when a Spec selection wait times out. */
async function watchSpecDecisionWait(chrome) {
  const pending = new Map();
  const onMessage = ({ data }) => {
    let message;
    try { message = JSON.parse(String(data)); } catch { return; }
    if (message.method === 'Network.requestWillBeSent') {
      const request = message.params.request;
      pending.set(message.params.requestId, { method: request.method, path: new URL(request.url).pathname.slice(0, 160) });
      while (pending.size > 20) pending.delete(pending.keys().next().value);
    } else if (message.method === 'Network.loadingFinished' || message.method === 'Network.loadingFailed') {
      pending.delete(message.params.requestId);
    }
  };
  chrome.socket.addEventListener('message', onMessage);
  await chrome.stable(`(() => {
    if (window.__pullboardSpecKeys) return;
    window.__pullboardSpecKeys = [];
    const record = (event) => {
      window.__pullboardSpecKeys.push({ type:event.type, key:event.key, code:event.code, target:event.target?.id || event.target?.tagName || '' });
      if (window.__pullboardSpecKeys.length > 20) window.__pullboardSpecKeys.shift();
    };
    document.addEventListener('keydown', record, true);
    document.addEventListener('keyup', record, true);
    window.__pullboardSpecKeysDispose = () => {
      document.removeEventListener('keydown', record, true);
      document.removeEventListener('keyup', record, true);
      delete window.__pullboardSpecKeys;
      delete window.__pullboardSpecKeysDispose;
    };
  })()`);
  return {
    /** Run the browser wait with its normal deadline and attach bounded state only on timeout. */
    async waitFor(expression, timeoutMs) {
      try {
        return timeoutMs === undefined ? await chrome.waitFor(expression) : await chrome.waitFor(expression, timeoutMs);
      } catch (error) {
        const page = JSON.parse(await chrome.stable(`JSON.stringify({
          selectedRow:typeof view === 'object' ? view.row?.spec ?? null : null,
          focusedElement:{tag:document.activeElement?.tagName||'',id:document.activeElement?.id||'',className:String(document.activeElement?.className||'')},
          lastKeyEvents:(window.__pullboardSpecKeys||[]).slice(-20)
        })`));
        const diagnostic = { ...page, pendingRequests: [...pending.values()] };
        error.diagnostic = diagnostic;
        error.message += `; Spec wait state ${JSON.stringify(diagnostic)}`;
        throw error;
      }
    },
    /** Remove the CDP and page listeners installed for this observation. */
    async dispose() {
      chrome.socket.removeEventListener('message', onMessage);
      pending.clear();
      await chrome.stable('window.__pullboardSpecKeysDispose?.()');
    },
  };
}

/**
 * Write to a project's board as it was some time ago, through the board's own writers on a clock set back:
 * a card's age, its day rule and whether its agent is at work all depend on when, and the CLI only writes now.
 */
function earlier(repo, at, write) {
  const board = openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'), { now: () => new Date(at) });
  try {
    return write(board);
  } finally {
    closeBoard(board);
  }
}

/** Visit a real conversation using its native controls before checking complete messages. */
async function openShoutConversation(chrome, key = 'none') {
  if (await chrome.stable("!!document.querySelector('#feed .conversation-heading')")) {
    await press(chrome, "document.querySelector('#feed [data-shout-thread=\"\"]')");
  }
  const selector = '#feed [data-shout-thread="' + key + '"]';
  await chrome.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
  await press(chrome, `document.querySelector(${JSON.stringify(selector)})`);
  await chrome.waitFor("!!document.querySelector('#feed .conversation-heading')");
}

/** Put the page in a width and a colour scheme, and wait for the shouts to lay out again. */
async function shoutsAt(chrome, width, scheme) {
  await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches && document.querySelector('#feed .sx-th')?.getBoundingClientRect().width > 0`);
  await chrome.stable('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
}

/** Open the project picker when a phone hides it, then choose a rendered project or group. */
async function pickProject(chrome, find) {
  // Under 900 px the switcher lives in the Menu drawer, whose project button opens the project list (dcf117ebc6).
  if (await chrome.stable('innerWidth <= 900')) {
    await chrome.click("document.querySelector('#menu-btn')");
    await chrome.click("document.querySelector('#mdrawer-proj')");
  } else if (await chrome.stable("getComputedStyle(document.querySelector('#side .side-body')).display === 'none'")) {
    await chrome.click("document.querySelector('#proj-switch')");
    await chrome.click('document.querySelector("[data-proj-all]")');
  }
  await chrome.click(find);
  await chrome.waitFor("!document.body.classList.contains('switching') && data?.root === view.root");
}

/** Go back (-1) or forward (1) one entry in the tab's history, as the browser's own buttons do. */
async function travel(chrome, step) {
  const { currentIndex, entries } = await chrome.send('Page.getNavigationHistory');
  await chrome.send('Page.navigateToHistoryEntry', { entryId: entries[currentIndex + step].id });
}

/**
 * Choose a Show or Lane option from the strip's Items controls as a person does: press the Show button, or pick the
 * lane in the Lane select. A choice is "state:<state>" or "lane:<lane>".
 */
async function chooseFilter(chrome, choice) {
  const [kind, value] = [choice.slice(0, choice.indexOf(':')), choice.slice(choice.indexOf(':') + 1)];
  if (kind === 'state') await press(chrome, `document.querySelector('#page-controls [data-page-ctl="state"][data-value="${value}"]')`);
  else await chrome.stable(`(() => { const select = document.querySelector('#page-controls select[data-page-ctl="lane"]'); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
}

/** Wait for a condition after a press; if it never arrives, say what the page shows and where the press landed. */
async function pressedInto(chrome, expression, timeoutMs = 10_000) {
  try {
    await chrome.waitFor(expression, timeoutMs);
  } catch (error) {
    const shows = await chrome.stable(`JSON.stringify({ panes: [...document.querySelectorAll('[data-pane]')].filter((each) => !each.hidden).map((each) => each.dataset.pane), address: location.pathname + location.search + location.hash, lit: document.querySelector('.tab.on')?.dataset.tab ?? null, viewTab: typeof view === 'object' ? view.tab : null, item: typeof view === 'object' ? view.item : null, scrollY: Math.round(scrollY), pressed: window.__pressed ?? null, entries: history.length })`).catch((failure) => 'an unreadable page: ' + failure.message);
    throw new Error(`${error.message}; the page shows ${shows}`, { cause: error });
  }
}

/** Wait for a page condition that may span a page load, when the page asked may still be loading. */
async function settled(chrome, expression, timeoutMs = 15_000) {
  return chrome.waitFor(expression, timeoutMs);
}

/** A page expression for the Roadmap row showing an id, such as #3 or beacon#1. */
function roadmapRow(id) {
  return `[...document.querySelectorAll('#roadmap .milestone-item')].find((row) => row.querySelector('.id')?.textContent === ${JSON.stringify(id)})`;
}

/** A page expression that is true when only this pane shows, at this address. */
function showing(pane, address) {
  return `[...document.querySelectorAll('[data-pane]')].filter((each) => !each.hidden).map((each) => each.dataset.pane).join() === ${JSON.stringify(pane)} && location.pathname + location.hash === ${JSON.stringify(address)}`;
}

/** Open each folded Roadmap part once so stories that inspect all items read visible rows. */
async function openRoadmapParts(chrome) {
  const keys = JSON.parse(await chrome.stable("JSON.stringify([...document.querySelectorAll('#roadmap [data-key]')].filter(part => part.querySelector('.milestone-head').getAttribute('aria-expanded') !== 'true').map(part => part.dataset.key))"));
  for (const key of keys) {
    const part = `[...document.querySelectorAll('#roadmap [data-key]')].find(part => part.dataset.key === ${JSON.stringify(key)})`;
    await press(chrome, `${part}.querySelector('.milestone-head')`);
    await chrome.waitFor(`${part}.querySelector('.milestone-head').getAttribute('aria-expanded') === 'true'`);
  }
}

/**
 * The Roadmap as Chrome draws it: the address and the pane shown, the page's width, and each card
 * with its count, the share of its bar that is filled, its note and its rows. A row has the id and
 * chip label the person reads, the chip's tone and colours, its dot's colour, its tooltip and title,
 * and how many lines the title takes and whether it is cut with an ellipsis.
 */
async function readRoadmap(chrome) {
  return JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const paint = (element) => getComputedStyle(element).color + ' on ' + getComputedStyle(element).backgroundColor;
    return {
      address: location.pathname + location.search + location.hash,
      shown: [...document.querySelectorAll('[data-pane]')].filter((pane) => !pane.hidden).map((pane) => pane.dataset.pane),
      tab: document.querySelector('.tab.on')?.dataset.tab,
      client: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
      cards: [...document.querySelectorAll('#roadmap .milestone')].map((card) => {
        const bar = card.querySelector('.milestone-progress');
        return {
          name: card.querySelector('h2').innerText,
          count: card.querySelector('.roadmap-left [aria-label]')?.getAttribute('aria-label') ?? card.querySelector('.milestone-count')?.innerText ?? null,
          filled: bar ? Math.round(1000 * bar.querySelector(':scope > rect').getBoundingClientRect().width / bar.getBoundingClientRect().width) / 1000 : null,
          progress: bar?.matches('.roadmap-summary-bar') ? [Number(bar.querySelector('[data-summary-segment=landed]').dataset.count), Number(bar.dataset.total)] : bar ? [Number(bar.getAttribute('aria-valuenow')), Number(bar.getAttribute('aria-valuemax'))] : null,
          empty: card.querySelector('.milestone-empty')?.innerText ?? null,
          note: card.querySelector('.milestone-note')?.innerText ?? null,
          rows: [...card.querySelectorAll('.milestone-item')].map((row) => {
            const chip = row.querySelector('.item-stage') || row.querySelector('.chip'), word = chip.querySelector('.stage-word') || chip, title = row.querySelector('.t'), clip = title.querySelector('.milestone-title') ?? title, style = getComputedStyle(clip), box = word.getBoundingClientRect();
            return {
              id: row.querySelector('.id').innerText, label: word.innerText.trim(), tone: chip.dataset.stage || [...chip.classList].filter((name) => ['ok', 'no', 'warn', 'busy', 'free'].includes(name)).join(' '),
              marks: [...chip.querySelectorAll('.stage-marks > *')].map(mark => mark.textContent.trim()), detail: chip.querySelector('.stage-detail')?.textContent || '',
              seen: box.width > 0 && box.height > 0 && getComputedStyle(word).visibility === 'visible',
              chip: paint(word), dot: getComputedStyle(row.querySelector('.dot')).backgroundColor,
              button: row.matches('button,[role="button"]'), tip: row.title, title: [...(title.querySelector('.milestone-title') ?? title).childNodes].slice(1).map((node) => node.textContent).join(''), // the id and title share .milestone-title (10d605f572)
              lines: Math.round(title.getBoundingClientRect().height / parseFloat(style.lineHeight)),
              // Since b83469ff53 the title's ellipsis is set on .milestone-title, inside .t beside the after-chips; since be3d0c2d76 .t is a block, so the inline span never overflows and the cut shows on .t.
              cut: [clip, title].some((node) => node.scrollWidth > node.clientWidth), ellipsis: style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap' && style.overflow === 'hidden',
            };
          }),
        };
      }),
    };
  })())`));
}

/**
 * How the tab bar lays out with each tab in turn picked, and so bold: each tab's box and its label's,
 * and the bar's edges. The tab picked now is picked again afterwards.
 */
async function tabBar(chrome) {
  const tabs = await chrome.stable("[...document.querySelectorAll('#tabs .tab')].filter(tab => tab.getClientRects().length).map(tab => tab.dataset.tab)");
  const picked = await chrome.stable("document.querySelector('#tabs .tab.on')?.dataset.tab");
  const layouts = [];
  try {
    for (const on of tabs) {
      await chrome.stable(`[...document.querySelectorAll('#tabs .tab')].forEach(tab => tab.classList.toggle('on', tab.dataset.tab === ${JSON.stringify(on)}))`);
      layouts.push(await chrome.stable(`(() => {
        const bar = document.querySelector('#tabs');
        return { on: ${JSON.stringify(on)}, bar: [bar.getBoundingClientRect().left, bar.getBoundingClientRect().right], tabs: [...bar.querySelectorAll('.tab')].filter(tab => tab.getClientRects().length).map(tab => {
          const range = document.createRange(); range.selectNodeContents(tab.firstChild);
          const box = tab.getBoundingClientRect(), label = range.getBoundingClientRect();
          return { tab: tab.dataset.tab, top: box.top, bottom: box.bottom, left: box.left, right: box.right, labelLeft: label.left, labelRight: label.right };
        }) };
      })()`, "[document.querySelector('#tabs'), ...[...document.querySelectorAll('#tabs .tab')].filter(tab => tab.getClientRects().length)]"));
    }
  } finally {
    await chrome.stable(`[...document.querySelectorAll('#tabs .tab')].forEach(tab => tab.classList.toggle('on', tab.dataset.tab === ${JSON.stringify(picked)}))`);
  }
  return { client: await chrome.stable('document.documentElement.clientWidth'), layouts };
}

/**
 * Let a test hold the view's own live updates while it observes one capture (#622). Since #545 the page re-reads the
 * board on its own three ways: the event-stream catch-up, the fallback read while the stream is down, and the relay's
 * timed read. Held, the catch-up and every timed read that calls refresh() wait; a refresh() the test calls, or an
 * action makes, still reads the board, and every response stays real. Call before the page loads.
 */
async function allowLiveHold(chrome) {
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const nativeInterval = window.setInterval.bind(window);
    window.__liveHold = { held: false, skipped: 0 };
    /** A timed read of the board waits while the hold is on; any other interval runs as it would. */
    window.setInterval = (callback, delay, ...args) => typeof callback === 'function' && /\\brefresh\\(/.test(String(callback))
      ? nativeInterval(() => { if (window.__liveHold.held) window.__liveHold.skipped += 1; else callback(); }, delay, ...args)
      : nativeInterval(callback, delay, ...args);
    /** Hold now, but only while no read is out, so no read already started lands after the hold. */
    window.__holdLive = () => {
      if (window.__liveHold.held) return true;
      if (catching || refreshStarted !== refreshDrawn.generation) return false;
      const live = catchUp;
      catchUp = () => { if (window.__liveHold.held) window.__liveHold.skipped += 1; else live(); };
      window.__liveHold.held = true;
      return true;
    };
  })()` });
}

/**
 * Wait until the page shows what ready says and no read is out, and hold its live updates in that same evaluation,
 * so no refresh lands between "ready" and the hold. The page must have been loaded after allowLiveHold.
 */
async function holdLive(chrome, ready, timeoutMs) {
  await chrome.waitFor(`(${ready}) && window.__holdLive()`, timeoutMs);
}

/** Serve a folder under a path prefix, as a static host does, recording each request and its status. */
async function serveFolder(folder, prefix) {
  const requests = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    /** Record the request with its status, then answer it. */
    const answer = (status, body, type) => { requests.push({ path, status }); response.writeHead(status, type ? { 'content-type': type, 'cache-control': 'no-store' } : {}).end(body); };
    if (!path.startsWith(prefix) || request.method !== 'GET') return answer(404);
    const file = resolve(folder, decodeURIComponent(path.slice(prefix.length)) || 'index.html');
    if (!file.startsWith(`${resolve(folder)}/`)) return answer(404);
    let body;
    try { body = readFileSync(file); } catch { return answer(404); }
    return answer(200, body, file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/json; charset=utf-8');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { base: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((done) => server.close(done)) };
}

/** Save the page, all of it, at a width and in a theme, when PULLBOARD_ROADMAP_PROOF names a folder. */
async function proofShot(chrome, name, width) {
  if (!process.env.PULLBOARD_ROADMAP_PROOF) return;
  mkdirSync(process.env.PULLBOARD_ROADMAP_PROOF, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await chrome.stable(`document.documentElement.dataset.theme = '${theme}'`);
    const height = await chrome.stable('Math.ceil(document.documentElement.scrollHeight)');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: Math.max(900, height), deviceScaleFactor: 2, mobile: false });
    await browserPause(150);
    const shot = await chrome.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.PULLBOARD_ROADMAP_PROOF, `${name}-${width}-${theme}.png`), Buffer.from(shot.data, 'base64'));
  }
  await chrome.stable('delete document.documentElement.dataset.theme');
  await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
}

/**
 * Type words into the view's top-bar search as a keyboard does, from an empty field, and wait for their results. On a
 * timeout it names the stage it stopped at: the field's value, what has focus, whether the page has window focus, and
 * whether the results are hidden and what closed them (#394).
 */
async function searchFor(chrome, words, timeoutMs) {
  await chrome.stable("document.querySelector('#q').focus(); document.querySelector('#q').select()");
  await chrome.send('Input.insertText', { text: words });
  try {
    await chrome.waitFor(`document.querySelector('#q').value === ${JSON.stringify(words)} && !document.querySelector('#find-results').hidden`, timeoutMs);
  } catch (error) {
    const state = await chrome.stable(`JSON.stringify((() => {
      const q = document.querySelector('#q'), results = document.querySelector('#find-results'), at = document.activeElement;
      return { value: q.value, focused: at ? (at.id ? '#' + at.id : at.tagName.toLowerCase()) : null, windowFocus: document.hasFocus(), resultsHidden: results.hidden, closedBy: results.dataset.why || null };
    })())`);
    throw new Error(`the search for ${JSON.stringify(words)} did not show its results: ${state}`, { cause: error });
  }
}

export { BIN, scratch, chooseFilter, tapTarget, SPEC, machine, project, build, buildLocal, acceptLocal, sendBack, fetchReason, fetchView, fetchLive, fetchPage, startView, styleOf, element, ageNodes, target, settle, storage, daysOn, openPage, projectRows, productEntries, timelineRows, agentEntries, drawing, textBoxes, meet, accept, needEntries, openItemsNeeds, itemRow, boardId, boardOf, assertObservationAges, withoutObservationAges, assertObservationsEqual, shoutNameText, chromeExecutable, browserPause, startSnapshotChrome, openSnapshotChrome, stopOwnedChrome, closeSnapshotChrome, watchSpecDecisionWait, earlier, openShoutConversation, shoutsAt, press, tapTouch, pickProject, travel, pressedInto, settled, roadmapRow, showing, readRoadmap, openRoadmapParts, tabBar, serveFolder, proofShot, searchFor, allowLiveHold, holdLive, pressTab };
