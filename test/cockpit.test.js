/**
 * The view's page as the person sees it (N26, N27). Each test sets up real projects with the real
 * CLI, starts `pullboard view` over them, and runs the page it serves in a vm with just enough of a
 * document for its script: every element the page names by id records what the script writes into
 * it, and the script's requests go to that view. Nothing is stood in for but the browser.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import diagnosticsChannel from 'node:diagnostics_channel';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { loadDoctrine } from '../src/doctrine.js';
import { addItem, closeBoard, completeCheckBaseline, openBoard, register, shout as shoutOnBoard } from '../src/board.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { MACHINE } from '../src/machine.js';
import { cockpitPage, PULLBOARD_COMMANDS } from '../src/cockpit.js';
import { HELP } from '../src/cli.js';
import { exportView, portableSnapshot, projectState } from '../src/serve.js';
import { relayPresentation } from '../src/relay-presentation.js';
import { fetchFresh } from './http-fixture.js';
import { relayClientFixture } from './relay-client-fixture.js';
import { findChromeExecutable, relayWorkBudgetMs, startChrome } from './relay-browser-fixture.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const scratch = [];

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** The target the view sets (#371): 44px where a finger taps, here a window under 900px; 32px under the tests' mouse. */
const tapTarget = (width) => (width < 900 ? 44 : 32);

const SPEC = `# Demo spec

## G · Goals
- G1 [approved, must] The page renders. | gate: web test
- G2 [approved, must] The page says goodbye. | gate: web test
`;

/**
 * A scratch machine: its own project registry, a `pullboard` shim on the PATH so the hooks find the
 * CLI, and git kept apart from this machine's config. run() fails the test on any refusal.
 */
function machine() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-cockpit-')));
  scratch.push(dir);
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(dir, 'bin', 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  const run = (cwd, ...args) => {
    const result = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `pullboard ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };
  return { dir, env, git, run };
}

/**
 * A project registered on the machine: a repo set up by `pullboard init`, one web lane, and a
 * worktree joined to it as web-1. `extra` adds to its pullboard.json, such as products.
 */
function project(box, name, spec = SPEC, extra = {}) {
  const repo = join(box.dir, name);
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  box.run(repo, 'init');
  const config = { gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h', lanes: { web: { owns: ['web/'], specs: ['G'] } }, shared: [], ...extra };
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), spec);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up pullboard');
  const branch = `web/${name.replace(/[^a-z]/g, '')}`;
  const web = join(box.dir, `${name}-web`);
  box.git(repo, 'worktree', 'add', '-q', web, '-b', branch);
  box.run(web, 'join', 'web');
  return { repo, web, branch, baseBranch: branch, itemBranches: new Map() };
}

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
  box.run(p.web, 'submit', String(id));
}

/**
 * The coordinator sends an item back from a checkout of its submitted commit, as a verifier does.
 */
function sendBack(box, p, id, note) {
  box.git(p.repo, 'switch', '-q', '--detach', p.itemBranches.get(`${p.baseBranch}:${id}`) ?? p.branch);
  box.run(p.repo, 'verify', String(id), 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--note', note, '--as', 'coordinator');
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

/** Start the real view and wait for a complete HTTP answer, rather than just its printed link. */
async function startView(box, { bin = BIN } = {}) {
  const child = spawn(process.execPath, [bin, 'view', '--no-open'], { cwd: box.dir, env: box.env });
  const link = await new Promise((found, fail) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /Pullboard view: (http:\/\/127\.0\.0\.1:\d+\/\?k=\S+)/.exec(out);
      if (match) found(new URL(match[1]));
    });
    child.on('exit', (code) => fail(new Error(`view exited ${code}: ${out}`)));
  });
  const stop = () => new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once('exit', done);
    child.kill('SIGTERM');
  });
  try {
    const ready = await fetchLive(link, { signal: AbortSignal.timeout(30_000) });
    assert.equal(ready.status, 200, 'the view answers before the test fetches its page');
    await ready.arrayBuffer();
  } catch (error) {
    await stop();
    throw error;
  }
  return { link, key: link.searchParams.get('k'), base: `http://127.0.0.1:${link.port}`, stop };
}

/**
 * The page's stylesheet as the view serves it, behind its secret.
 */
async function styleOf(view) {
  return (await fetchLive(`${view.base}/view.css`, { headers: { 'x-pullboard-key': view.key } })).text();
}

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
    querySelectorAll: () => [],
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
    const attribute = /^\[data-([a-z-]+)\]$/.exec(selector);
    return attribute ? attribute[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) in data : false;
  };
  const self = { id, dataset: data, closest: (selectors) => (selectors.split(',').some((selector) => matches(selector.trim())) ? self : null) };
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
  const html = await (await fetchLive(view.link, { signal: AbortSignal.timeout(30_000) })).text();
  const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const known = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const elements = new Map();
  const node = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const clicks = [];
  const inflight = new Set();
  const requests = [];
  const document = {
    body: element('body'),
    documentElement: element('html'),
    hidden: false,
    getElementById: (id) => (known.has(id) ? node(id) : null),
    querySelectorAll: (selector) => (selector === '[data-ago]' ? [...elements.values()].flatMap(ageNodes) : []),
    addEventListener: (type, listener) => { if (type === 'click') clicks.push(listener); },
  };
  // The body starts with the classes its markup gives it, as at first paint.
  for (const name of (/<body class="([^"]*)">/.exec(html)?.[1] ?? '').split(' ').filter(Boolean)) document.body.classList.add(name);
  let release = () => {};
  const held = new Promise((done) => { release = done; });
  if (!hold) release();
  const context = vm.createContext({
    document,
    location: { search: `?k=${view.key}` },
    URLSearchParams,
    structuredClone,
    innerWidth: width,
    innerHeight: 800,
    matchMedia: (query) => ({ matches: width <= Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? Infinity) }),
    setInterval: () => 0,
    ...(later ? { Date: daysOn(later) } : {}),
    ...(store ? { localStorage: store } : {}),
    setTimeout,
    clearTimeout,
    fetch: (path, init = {}) => {
      requests.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
      const answer = held.then(() => fetchLive(`${view.base}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) })).then(async (res) => {
        const body = await res.json();
        return { ok: res.ok, status: res.status, json: async () => body };
      });
      inflight.add(answer);
      const done = () => inflight.delete(answer);
      answer.then(done, done);
      return answer;
    },
  });
  vm.runInContext(script, context);
  if (!hold) await settle(inflight);
  return {
    html,
    requests,
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

test('an added item confirmation names its returned id [A3,N27]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'An existing item', '--specs', 'G1');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const ids = [];
    for (const title of ['First page item', 'Second page item']) {
      await page.fire('new-item', 'click');
      page.element('add-lane').value = 'web';
      page.element('add-title').value = title;
      page.element('add-specs').value = 'G1';
      await page.fire('add-form', 'submit');
      const item = (await boardOf(view, alpha.repo)).items.find((row) => row.title === title);
      assert.ok(item, 'the real public move creates the submitted item');
      ids.push(item.id);
      assert.equal(page.element('console').className, 'console ok');
      assert.equal(page.element('console').textContent.split('\n').at(-1), `added #${item.id}`);
    }
    assert.notEqual(ids[0], ids[1], 'successive confirmations use their distinct returned ids');
  } finally {
    await view.stop();
  }
});

test('the sidebar lists every project and what needs the person [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  build(box, alpha, 1, 'greeting.html');
  sendBack(box, alpha, 1, 'no greeting on the page');
  build(box, alpha, 2, 'farewell.html');
  const beta = project(box, 'beta', `${SPEC}- G3 [pending] Should the page greet in French?\n`);
  box.run(beta.repo, 'hold', 'web', '--reason', 'G3 is open');
  const gamma = project(box, 'gam<i>ma');
  box.run(gamma.repo, 'add', 'web', 'Gamma page', '--specs', 'G1', '--criterion', 'renders');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const side = page.html.slice(page.html.indexOf('<aside class="side"'), page.html.indexOf('</aside>'));
    assert.match(side, /<nav id="proj-list"/, 'the project rows sit in the sidebar');
    for (const opening of side.match(/<(aside|div|nav)\b[^>]*>/g)) assert.doesNotMatch(opening, /\bhidden\b/, `${opening} shows without opening anything`);
    const style = await styleOf(view);
    assert.match(style, /\.shell \{ display: grid; grid-template-columns: var\(--side-w\) minmax\(0, 1fr\);/, 'a sidebar column beside the main one');
    assert.match(style, /@media \(max-width: 900px\) \{[^@]*\.side-body \{ display: none;[^@]*\.side\.open \.side-body \{ display: grid; \}/, 'under 900px the list folds behind the project button');

    assert.deepEqual(projectRows(page.show('proj-list')), [
      { root: alpha.repo, name: 'alpha', needs: '', line: '1 sent back · 1 to verify', current: true },
      { root: beta.repo, name: 'beta', needs: '2', line: '1 question · 1 lane held', current: false },
      { root: gamma.repo.replace('<', '&lt;').replace('>', '&gt;'), name: 'gam&lt;i&gt;ma', needs: '', line: '1 item open', current: false },
    ]);
    assert.match(page.show('chain'), /Greeting/);

    await page.click({ root: gamma.repo, classes: 'proj side' });
    assert.deepEqual(projectRows(page.show('proj-list')).map((row) => [row.name, row.current]), [['alpha', false], ['beta', false], ['gam&lt;i&gt;ma', true]]);
    assert.match(page.show('chain'), /Gamma page/, 'the main column shows the project picked');
    assert.doesNotMatch(page.show('chain'), /Greeting/);
    assert.equal(page.element('proj-name').textContent, 'gam<i>ma');
    assert.ok(!page.html.includes('proj-elsewhere'), 'the folded button carries no count: what needs the person in each project is in the list it opens');

    await page.click({ id: 'proj-switch', classes: 'switch-btn side' });
    assert.ok(page.element('side').classList.contains('open'), 'the project button opens the list');
    assert.equal(page.element('proj-switch').getAttribute('aria-expanded'), 'true');
    await page.click({ classes: 'row' });
    assert.ok(!page.element('side').classList.contains('open'), 'a click outside the sidebar folds it again');
  } finally {
    await view.stop();
  }
});

test('projects group repos with combined needs and activity, while ungrouped and unreadable repos stay clear [N33, N34, N36]', async () => {
  const box = machine();
  const core = project(box, 'core', `${SPEC}- G3 [pending] Should #1 greet in French?\n`, { name: 'Core API', project: 'Atlas' });
  box.run(core.repo, 'add', 'web', 'Core target #1', '--specs', 'G1', '--criterion', 'greets');
  build(box, core, 1, 'greeting.html');
  sendBack(box, core, 1, 'the page needs a greeting');
  const web = project(box, 'web', SPEC, { name: 'Web UI', project: 'Atlas' });
  box.run(web.repo, 'add', 'web', 'Target for #1', '--specs', 'G1', '--criterion', 'has a header');
  build(box, web, 1, 'header.html');
  box.run(web.repo, 'shout', 'person', 'Ship #1 today?', '--decision');
  const standalone = project(box, 'standalone', SPEC, { name: 'Scratchpad' });
  const broken = project(box, 'broken', SPEC, { name: 'Broken repo', project: 'Atlas' });
  const view = await startView(box);
  try {
    const headers = { 'x-pullboard-key': view.key };
    let response = await fetchLive(`${view.base}/api/v1/boards`, { headers });
    let state = await response.json();
    assert.deepEqual(state.boards.filter((repo) => repo.project === 'Atlas').map((repo) => repo.name), ['Core API', 'Web UI', 'Broken repo']);
    writeFileSync(join(broken.repo, 'pullboard.json'), '{not valid json');
    response = await fetchLive(`${view.base}/api/v1/boards`, { headers });
    state = await response.json();
    const unreadable = state.warnings.find((repo) => repo.root === broken.repo);
    assert.equal(unreadable.error.version, 1);
    assert.equal(unreadable.error.error.code, 'BOARD_UNAVAILABLE');
    assert.match(unreadable.error.error.message, /cannot be read/);
    assert.match(unreadable.error.error.message, /pullboard forget/);
    assert.doesNotMatch(unreadable.error.error.message, /BAD_CONFIG|SyntaxError/);

    const page = await openPage(view);
    const side = page.show('proj-list');
    assert.match(side, /class="repo-group"/);
    assert.match(side, /data-root="group:Atlas"/);
    assert.match(side, /Core API/);
    assert.match(side, /Web UI/);
    assert.match(side, /Scratchpad/);
    assert.match(side, /class="repo-error" role="status"><b>Broken repo:<\/b> registered project [^<]+ cannot be read; restore the repo or run pullboard forget/);
    assert.doesNotMatch(side, /class="small bad"|class="bad"/);

    await page.click({ root: 'group:Atlas' });
    assert.equal(page.element('group-view').hidden, false);
    assert.equal(page.element('tabs').hidden, true);
    assert.match(page.show('group-needs'), /Core API/);
    assert.match(page.show('group-needs'), /Web UI/);
    assert.match(page.show('group-needs'), /<b>Core API<\/b><code>G3<\/code><span>Should <button class="ref" data-root="[^"]+" data-go="item:1" title="Core target #1" type="button">#1<\/button> greet in French\?<\/span><button data-root="[^"]+" type="button"><em>answer in SPEC\.md →<\/em><\/button>/, "a question in one repo's spec");
    assert.match(page.show('group-needs'), /<b>Web UI<\/b><code>coordinator<\/code><span>Ship <button class="ref" data-root="[^"]+" data-go="item:1" title="Target for #1" type="button">#1<\/button> today\?<\/span><button data-root="[^"]+" type="button"><em>decision, /, "and a decision in another's");
    assert.doesNotMatch(page.show('group-needs'), /sent back|to verify|Greeting|Header/, "work sent back or waiting for a verdict is the agents', not the person's");
    assert.match(page.show('group-activity'), /Core API/);
    assert.match(page.show('group-activity'), /Web UI/);
    assert.match(page.show('group-activity'), /Greeting|Target/);
    const activityRefs = [...page.show('group-activity').matchAll(/<button class="ref" data-root="([^"]+)" data-go="item:1" title="([^"]+)"/g)].map((link) => [link[1], link[2]]);
    assert.ok(activityRefs.some(([root, title]) => root === core.repo && title === 'Core target #1'), 'activity links bind Core API #1 to its repo');
    assert.ok(activityRefs.some(([root, title]) => root === web.repo && title === 'Target for #1'), 'activity links bind Web UI #1 to its repo');

    assert.deepEqual([...page.show('group-needs').matchAll(/<button class="ref" data-root="([^"]+)" data-go="item:1" title="([^"]+)"/g)].map((link) => [link[1], link[2]]), [
      [core.repo, 'Core target #1'], [web.repo, 'Target for #1'],
    ], 'each duplicate #1 keeps the repo where it was written');
    page.run("view.tab = 'activity'");
    await page.click({ root: core.repo, go: 'item:1' });
    assert.equal(page.run('view.root'), core.repo, 'the Core API link opens its own repo');
    assert.equal(page.run('view.item'), 1, 'the Core API link opens its #1');
    assert.equal(page.run('view.tab'), 'items', 'the Core API link opens its item detail');
    await page.click({ root: 'group:Atlas' });
    page.run("view.tab = 'activity'");
    await page.click({ root: web.repo, go: 'item:1' });
    assert.equal(page.run('view.root'), web.repo, 'the Web UI link opens its own repo');
    assert.equal(page.run('view.item'), 1, 'the Web UI link opens its #1');
    assert.equal(page.run('view.tab'), 'items', 'the Web UI link opens its item detail');
    await page.click({ root: 'group:Atlas' });

    await page.click({ root: core.repo });
    assert.equal(page.element('group-view').hidden, true);
    assert.equal(page.element('tabs').hidden, false);
    assert.match(page.show('chain'), /Core target/);
    assert.doesNotMatch(page.show('chain'), /Header/);
    assert.ok(side.includes(`data-root="${standalone.repo}"`), 'the repo without a project stands alone');
  } finally {
    await view.stop();
  }
});

test('the project list collapses into the tab bar and stays collapsed [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for sidebar checks.');

  const box = machine();
  const demo = project(box, 'collapse-demo');
  const other = project(box, 'collapse-other');
  box.run(demo.repo, 'add', 'web', 'An item to show', '--specs', 'G1', '--criterion', 'shown');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-collapse-chrome-'));
  let chrome;
  /** Read the sidebar, the tab bar and the board's columns as the person sees them. */
  const read = async () => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    const box = (s) => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, shown: getComputedStyle(e).display !== 'none' && r.width > 0 }; };
    const logo = document.querySelector('#side-toggle');
    return { width: document.documentElement.clientWidth, logo: box('#side-toggle'), side: box('.side'), top: box('.top'), main: box('main'), switcher: box('#proj-switch'), list: box('#side-body'), theme: box('#theme'), live: box('#live'),
      columns: box('.two > :first-child').width + box('#detail').width, collapsed: document.documentElement.dataset.side || '', pressed: logo.getAttribute('aria-pressed'), title: logo.title,
      listPosition: getComputedStyle(document.querySelector('#side-body')).position, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1280 && !!document.querySelector("#chain .row") && !!document.querySelector("#detail h2")');
    // A classic 15px scrollbar, as Linux draws one, so every edge is measured against the content width.
    await chrome.evaluate("document.styleSheets[0].insertRule('html { overflow-y: scroll; }', 0); document.styleSheets[0].insertRule('::-webkit-scrollbar { width: 15px; }', 0)");
    await chrome.waitFor('document.documentElement.clientWidth === innerWidth - 15');
    const open = await read();
    assert.ok(open.side.width >= 200 && open.side.height >= 800 && !open.collapsed && open.pressed === 'false', `the sidebar starts open: ${JSON.stringify(open)}`);
    assert.ok(open.theme.right >= open.width - 16 && open.theme.top < open.top.bottom && open.live.right <= open.theme.left, `the light/dark button sits at the right end of the tab bar, clear of the live status: ${JSON.stringify(open)}`);

    await chrome.evaluate('document.querySelector("#side-toggle").click()');
    await chrome.waitFor('document.documentElement.dataset.side === "collapsed"');
    const collapsed = await read();
    assert.deepEqual([collapsed.pressed, collapsed.title], ['true', 'Show the project list'], 'the logo says it brings the list back');
    assert.ok(collapsed.side.height <= collapsed.top.height + 0.5 && collapsed.switcher.shown && Math.abs(collapsed.switcher.top - collapsed.top.top) < collapsed.top.height && collapsed.switcher.right <= collapsed.top.left + 0.5,
      `the sidebar is one switcher at the left of the tab bar, in its row: ${JSON.stringify(collapsed)}`);
    assert.ok(!collapsed.list.shown, 'the project list folds away until asked for');
    assert.ok(Math.abs(collapsed.logo.width - collapsed.logo.height) < 1 && collapsed.logo.height >= tapTarget(1280), `the logo alone is a square control, so its hover is a square: ${JSON.stringify(collapsed.logo)}`);
    assert.ok(collapsed.main.left <= 0.5 && collapsed.main.width >= collapsed.width - 0.5 && collapsed.columns >= open.columns + 200 && !collapsed.overflow,
      `the board takes the whole width: the list and detail gain at least 200px: ${JSON.stringify({ open: open.columns, collapsed: collapsed.columns, main: collapsed.main })}`);
    assert.ok(collapsed.theme.right >= collapsed.width - 16 && collapsed.live.right <= collapsed.theme.left, 'the light/dark button stays at the right end');

    await chrome.evaluate('document.querySelector("#proj-switch").click()');
    const dropdown = await read();
    assert.ok(dropdown.list.shown && dropdown.listPosition === 'absolute' && dropdown.list.top >= dropdown.top.bottom - 0.5 && dropdown.list.right <= dropdown.width, `the switcher opens the project list as a dropdown: ${JSON.stringify(dropdown.list)}`);
    await chrome.evaluate('document.querySelector("main").click()');
    assert.equal((await read()).list.shown, false, 'a click outside closes it');
    await chrome.evaluate('document.querySelector("#proj-switch").click()');
    await chrome.evaluate(`document.querySelector('#proj-list [data-root="${other.repo}"]').click()`);
    await chrome.waitFor(`document.querySelector('#proj-name').textContent === 'collapse-other'`);
    assert.equal((await read()).list.shown, false, 'a pick closes it and shows that project');

    await chrome.send('Page.reload');
    await chrome.waitFor('document.readyState === "complete" && !!document.querySelector("#proj-switch")');
    assert.equal((await read()).collapsed, 'collapsed', 'the choice is kept in this browser across a reload');

    await chrome.evaluate('document.querySelector("#side-toggle").click()');
    await chrome.waitFor('!document.documentElement.dataset.side');
    const back = await read();
    assert.ok(back.side.width >= 200 && back.list.shown && back.pressed === 'false' && back.title === 'Collapse the project list', `the logo brings the sidebar back as it was: ${JSON.stringify(back)}`);

    await chrome.evaluate('document.querySelector("#side-toggle").click()');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375');
    const phone = await read();
    await chrome.evaluate('document.querySelector("#side-toggle").click()');
    const tapped = await read();
    assert.ok(phone.switcher.shown && !phone.list.shown && phone.theme.right >= phone.width - 16 && phone.theme.top < phone.side.bottom, `a phone keeps its switcher, the light/dark button at the right of its top row: ${JSON.stringify(phone)}`);
    assert.equal(tapped.collapsed, phone.collapsed, 'on a phone the logo is only the logo');
    assert.ok(!phone.overflow, 'and nothing runs off the phone');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('a project with one repo shows once in the project list [N33, N26]', async () => {
  const box = machine();
  const solo = project(box, 'solo', SPEC, { name: 'Solo board', project: 'Solo' });
  box.run(solo.repo, 'shout', 'person', 'Ship it today?', '--decision');
  // The relay lists every board this way: its project is its own repository's name.
  const mirrored = project(box, 'mirrored', SPEC, { name: 'acme/site', project: 'acme/site' });
  project(box, 'core', SPEC, { name: 'Core API', project: 'Atlas' });
  project(box, 'web', SPEC, { name: 'Web UI', project: 'Atlas' });
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const side = page.show('proj-list');
    const once = (name) => side.split('<span class="pname">' + name + '</span>').length - 1;
    assert.doesNotMatch(side, /data-root="group:Solo"|data-root="group:acme\/site"/, 'a project with one repo has no group heading');
    assert.deepEqual([once('Solo board'), once('acme/site'), once('Solo')], [1, 1, 0], 'each one-repo project shows as its repo, once');
    assert.ok(side.includes(`data-root="${solo.repo}"`) && side.includes(`data-root="${mirrored.repo}"`), 'as a repo button of its own');
    assert.equal((side.match(/<span class="asks">1 decision<\/span>/g) || []).length, 1, "the lone repo's decision is counted once, not again on a heading");
    assert.match(side, /data-root="group:Atlas"/, 'two repos sharing a project still group');
    assert.deepEqual([once('Core API'), once('Web UI'), once('Atlas')], [1, 1, 1], 'under one heading');
    await page.click({ root: solo.repo });
    assert.deepEqual([page.element('group-view').hidden, page.element('tabs').hidden], [true, false], 'the lone repo opens on its own board');
  } finally {
    await view.stop();
  }
});

test('the view never scrolls sideways at 320px [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the 320px check.');

  const box = machine();
  const demo = project(box, 'narrow');
  box.run(demo.repo, 'add', 'web', 'A title long enough to need every bit of a narrow phone row, and then some more words', '--specs', 'G1', '--criterion', 'fits');
  box.run(demo.repo, 'add', 'web', 'Built, then sent back', '--specs', 'G1', '--criterion', 'back');
  build(box, demo, 2, 'two.txt');
  sendBack(box, demo, 2, 'It misses the edge the criterion names, a reason long enough to wrap on a phone.');
  const sha = box.git(demo.repo, 'rev-parse', 'HEAD').trim();
  box.run(demo.repo, 'shout', 'web', `Run \`pullboard next --verify\` and read SPEC.md:1-2@${sha} before you take #1.`);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-sideways-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('document.querySelectorAll("#chain .row").length === 2');
    // This machine's fonts first, then a wide one (Verdana here, DejaVu Sans on Linux) at 320 and at 305,
    // the room a 320px screen leaves beside a classic 15px scrollbar: Linux CI measured 324px of tabs there.
    for (const [width, font] of [[320, ''], [320, 'Verdana, "DejaVu Sans", sans-serif'], [305, 'Verdana, "DejaVu Sans", sans-serif']]) {
    await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await chrome.evaluate(`document.documentElement.style.setProperty('--sans', ${JSON.stringify(font || 'system-ui, sans-serif')})`);
    await chrome.waitFor(`innerWidth === ${width}`);
    for (const tab of ['items', 'shouts', 'spec', 'doctrine', 'activity', 'roadmap']) {
      await chrome.evaluate(`document.querySelector('[data-tab="${tab}"]').click()`);
      await chrome.waitFor(`!document.querySelector('[data-pane="${tab}"]').hidden`);
      const seen = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
        const edge = document.documentElement.clientWidth;
        // Name each element that runs past the edge with nothing above it to clip or scroll it.
        const clipped = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) if (!['visible', ''].includes(getComputedStyle(p).overflowX)) return true; return false; };
        const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).join('.') : '');
        const past = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > edge + 0.5 && !clipped(e); })
          .map((e) => name(e) + ' right ' + Math.round(e.getBoundingClientRect().right) + ': ' + (e.textContent || '').trim().slice(0, 40));
        return { scrollWidth: document.documentElement.scrollWidth, clientWidth: edge, past: past.slice(0, 8), more: Math.max(0, past.length - 8) };
      })())`));
      assert.ok(seen.scrollWidth <= seen.clientWidth, `${width}${font ? ' in a wide font' : ''}, ${tab}: the page scrolls sideways, ${seen.scrollWidth} wide in ${seen.clientWidth}; past the edge: ${seen.past.join(' | ')}${seen.more ? ` (+${seen.more} more)` : ''}`);
    }
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the tabs fit one row on a phone [N26]', async () => {
  const view = await startView(machine());
  try {
    const html = await (await fetchLive(view.link)).text();
    const style = await styleOf(view);
    const phone = /@media \(width < 480px\) \{\n([^@]*?)\n\}/.exec(style)?.[1] ?? '';
    assert.doesNotMatch(style, /max-width: 480px/, 'at 480px itself the tabs keep their row');
    assert.match(phone, /\.tabs \{ flex: 1; display: grid; grid-auto-flow: column; grid-auto-columns: auto;/, 'under 480px the tabs share the bar: each as wide as its label, plus an even share of the room left');
    assert.match(phone, /\.tab \{ display: grid; justify-items: center; align-content: center;/, 'each tab centres its label in its share');
    assert.match(style, /\n\.tabs \{ display: flex; flex-wrap: wrap; gap: 2px; \}\n/, 'wider, the tabs keep the row they have');
    const tabs = [...html.matchAll(/<button class="tab" data-tab="([a-z]+)" type="button">([A-Za-z]+)<\/button>/g)];
    assert.deepEqual(tabs.map((match) => match[2]), ['Items', 'Shouts', 'Spec', 'Doctrine', 'Activity', 'Roadmap'], 'six tabs, each its label alone: their counts are in the status bar');
  } finally {
    await view.stop();
  }
});
test('a pullboard command in prose chips only the command [N26]', async () => {
  // The page's command list is the CLI's: every "pullboard ..." that help --all prints (HELP.all) or a usage line
  // declares, choices in [a|b] or a|b, and commands after " | ", and nothing else.
  const declared = new Set();
  const read = (text) => {
    // Usage alternatives may follow an argument: spec approve <ids> | decline <ids>.
    for (const branch of text.matchAll(/pullboard ((?:[a-z-]+ )+)(?:<[^>]+> )?\| ([a-z-]+)/g)) {
      const shared = branch[1].trim().split(' ').slice(0, -1);
      read('pullboard ' + [...shared, branch[2]].join(' '));
    }
    for (const found of text.matchAll(/(?:^|[\s(`'"])pullboard ((?:\S+ ?)+?)(?= {2}|$|[;,.)](?:\s|$))/gm)) {
      const tokens = found[1].trim().split(' ');
      const phrase = [];
      for (let n = 0; n < tokens.length; n++) {
        const token = tokens[n];
        if (/^[a-z][a-zA-Z-]*$/.test(token)) { phrase.push(token); continue; }
        const choices = /^\[?([a-z][a-zA-Z-]*(?:\|[a-z][a-zA-Z-]*)+)\]?$/.exec(token);
        if (choices) for (const choice of choices[1].split('|')) declared.add([...phrase, choice].join(' '));
        else if (token === '|' && phrase.length === 1) {
          for (let k = n + 1; k < tokens.length; k += 2) { if (!/^[a-z][a-zA-Z-]*$/.test(tokens[k])) break; declared.add(tokens[k]); if (tokens[k + 1] !== '|') break; }
        }
        break;
      }
      if (phrase.length) declared.add(phrase.join(' '));
    }
  };
  read(HELP.all);
  for (const name of Object.keys(HELP.commands)) declared.add(name);
  for (const row of Object.values(HELP.commands)) for (const usage of row.usages) read(usage);
  for (const sub of ['milestone add', 'relay tokens', 'spec approve', 'prompt review']) assert.ok(declared.has(sub), `help --all declares ${sub}`);
  assert.deepEqual([...PULLBOARD_COMMANDS].sort(), [...declared].sort(), 'the view chips exactly the commands the CLI declares');
  assert.deepEqual(PULLBOARD_COMMANDS, [...PULLBOARD_COMMANDS].sort((a, b) => b.split(' ').length - a.split(' ').length), 'longest phrases first, so spec check wins over spec');

  const box = machine();
  const demo = project(box, 'commands');
  box.run(demo.repo, 'shout', 'all', [
    'pullboard spec check prints a line for docs/api.md with 0 errors.',
    'pullboard view serves every board.',
    'Run pullboard next --verify 235 then review it.',
    'pullboard verify 235 reject goes on in words.',
    'Turn pullboard relay on now, and pullboard hold web --reason "a pause" after that.',
    "pullboard's own page has no command.",
    'Then pullboard milestone add Launch for the person, and pullboard prompt review prints a guide.',
  ].join(' '));
  const view = await startView(box);
  try {
    const page = await openPage(view);
    page.run("view.tab = 'shouts'; render();");
    const feed = page.show('feed');
    const chips = [...feed.matchAll(/<code class="inline(?: [a-z]+)*"(?: title="[^"]*")?>([^<]*)<\/code>/g)].map((match) => match[1].replaceAll('&quot;', '"'));
    assert.deepEqual(chips.filter((chip) => chip.startsWith('pullboard')), ['pullboard spec check', 'pullboard view', 'pullboard next --verify 235', 'pullboard verify 235', 'pullboard relay on', 'pullboard hold', 'pullboard milestone add', 'pullboard prompt review'],
      `each chip is the command and its arguments, never the words after it: ${JSON.stringify(chips)}`);
    assert.ok(chips.includes('docs/api.md') && chips.includes('--reason'), 'a path and a flag in the prose after a command still chip on their own');
    for (const word of ['prints', 'serves', 'then', 'goes', 'now', 'after', 'own', 'for', 'a']) assert.ok(!chips.some((chip) => chip.split(' ').includes(word)), `"${word}" stays prose`);
  } finally {
    await view.stop();
  }
});

test('the view chips a command the CLI adds [N26]', async (t) => {
  const box = machine();
  const demo = project(box, 'help-copy');
  const cli = join(box.dir, 'cli-copy');
  mkdirSync(cli);
  for (const entry of ['bin', 'src', 'relay', 'test', 'skills', 'package.json']) {
    cpSync(resolve(import.meta.dirname, '..', entry), join(cli, entry), { recursive: true });
  }
  const helpFile = join(cli, 'src', 'help.js');
  const source = readFileSync(helpFile, 'utf8');
  writeFileSync(helpFile, source
    .replace('all: ALL_HELP,', "all: ALL_HELP + '\\n  pullboard blueprint apply <path>  a copied CLI extension',")
    .replace('commands: Object.freeze(commandHelpRows(ALL_HELP)),',
      "commands: Object.freeze({ ...commandHelpRows(ALL_HELP), 'blueprint inspect': { usages: ['pullboard blueprint inspect <path>'] } }),"));
  const copiedBin = join(cli, 'bin', 'pullboard.js');
  box.run(demo.repo, 'shout', 'all', 'A CLI extension says pullboard blueprint apply <file> and pullboard blueprint inspect <path>.');
  const view = await startView(box, { bin: copiedBin });
  /** Read actual rendered chips without depending on long-chip classes or title attributes. */
  const assertChips = (page, where) => {
    page.run("view.tab = 'shouts'; render();");
    const chips = [...page.show('feed').matchAll(/<code class="inline(?: [a-z]+)*"(?: title="[^"]*")?>([^<]*)<\/code>/g)].map(match => match[1]);
    for (const phrase of ['pullboard blueprint apply', 'pullboard blueprint inspect']) {
      assert.ok(chips.includes(phrase), `${where} chips the copied CLI command ${phrase}: ${JSON.stringify(chips)}`);
    }
  };
  try {
    assertChips(await openPage(view), 'the live page');
    const output = join(box.dir, 'snapshot');
    const exported = spawnSync(process.execPath, [copiedBin, 'view', '--export', output], { cwd: demo.repo, env: box.env, encoding: 'utf8' });
    assert.equal(exported.status, 0, exported.stderr);
    const snapshotServer = createServer((req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      let file = join(output, pathname === '/' ? 'index.html' : pathname.slice(1));
      if (!existsSync(file) && existsSync(file + '.json')) file += '.json';
      if (!existsSync(file)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': file.endsWith('.json') ? 'application/json' : 'text/html' });
      res.end(readFileSync(file));
    });
    await new Promise(resolveListen => snapshotServer.listen(0, '127.0.0.1', resolveListen));
    try {
      const base = `http://127.0.0.1:${snapshotServer.address().port}`;
      assertChips(await openPage({ link: new URL(base + '/'), key: '', base: base + '/' }), 'the exported page');
    } finally {
      snapshotServer.closeAllConnections();
      await new Promise(resolveClose => snapshotServer.close(resolveClose));
    }
    const { relayClientFixture: copiedRelayFixture } = await import(pathToFileURL(join(cli, 'test', 'relay-client-fixture.js')));
    const relay = await copiedRelayFixture(t);
    const session = await relay.phoneSession();
    const response = await fetchFresh(relay.origin + '/', { headers: { cookie: 'pb_session=' + session.token } });
    assert.equal(response.status, 200, 'the copied CLI relay serves its real authenticated person page');
    const html = await response.text();
    for (const phrase of ['blueprint apply', 'blueprint inspect']) {
      assert.match(html, new RegExp('pullboard \\(\\?:[^)]*' + phrase), 'the relay derives copied help phrase ' + phrase);
    }
  } finally { await view.stop(); }
});

test('real Chrome renders brief lists with inline paths [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for brief list checks.');

  const box = machine();
  const demo = project(box, 'briefs');
  const brief = ['The person called the old rendering ugly.', '', 'Files:', '- web/index.html', '- web/app.js', '- web/style.css', '- web/api.md', '',
    'Test:', '- node bin/run-tests.js --test-name-pattern "brief lists" test/cockpit.test.js', '- make test stays prose', '- a parent bullet',
    '  - capture, measurement, `note`', '  - decision, rejection', '', 'Sentences:',
    '- pullboard spec check prints a DOCTRINE.md line with 0 errors, and no PRACTICE.md remains at the root.', '- npm test runs the suite before every push', '- git merge main'].join('\n');
  box.run(demo.repo, 'add', 'web', 'A brief with lists', '--specs', 'G1', '--criterion', 'lists', '--brief', brief);
  box.run(demo.repo, 'shout', 'all', 'A fence still reads as code:\n```\nconst greeting = "hello";\n```');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-brief-lists-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data && !!data.project && !!document.querySelector('#detail .text.muted')");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.querySelector('#detail .text.muted ul') !== null`);
      const seen = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
        const text = document.querySelector('#detail .text.muted');
        const lists = [...text.querySelectorAll(':scope > ul.text-list')];
        const label = (list) => { let n = list.previousSibling; while (n && n.nodeType === 3 && !n.textContent.trim()) n = n.previousSibling; return n ? (n.nodeType === 3 ? n.textContent : n.textContent).trim().split('\\n').pop() : ''; };
        const item = (li) => ({ text: li.firstChild ? [...li.childNodes].filter((n) => n.nodeName !== 'UL').map((n) => n.textContent).join('') : '',
          codes: [...li.querySelectorAll(':scope > code')].map((code) => [code.textContent, getComputedStyle(code).display]), nested: [...li.querySelectorAll(':scope > ul > li')].map((child) => child.textContent) });
        const line = parseFloat(getComputedStyle(text).lineHeight);
        const testLabelTop = (() => { const r = document.createRange(); const node = [...text.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes('Test:')); r.selectNode(node); return r.getBoundingClientRect().top; })();
        return { lists: lists.map((list) => ({ label: label(list), items: [...list.querySelectorAll(':scope > li')].map(item) })),
          blocks: text.querySelectorAll('code.block, .code').length, dashes: text.innerText.split('\\n').filter((l) => l.trim().startsWith('-')).length,
          gap: (testLabelTop - lists[0].getBoundingClientRect().bottom) / line, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
      })())`));
      const place = `${width}: ${JSON.stringify(seen)}`;
      assert.deepEqual(seen.lists.map((list) => list.label), ['Files:', 'Test:', 'Sentences:'], `${width}: each label stays a plain line above its own list`);
      assert.deepEqual(seen.lists[0].items.map((li) => li.codes), [[['web/index.html', 'inline']], [['web/app.js', 'inline']], [['web/style.css', 'inline']], [['web/api.md', 'inline']]],
        `each path is a bullet holding one inline chip at ${place}`);
      const [command, prose, parent] = seen.lists[1].items;
      assert.deepEqual(command.codes, [['node bin/run-tests.js --test-name-pattern "brief lists" test/cockpit.test.js', 'inline']], `${width}: a whole command bullet is one chip`);
      assert.deepEqual([prose.text, prose.codes], ['make test stays prose', []], `${width}: any other command, unmarked, stays prose`);
      assert.deepEqual(parent.nested, ['capture, measurement, note', 'decision, rejection'], `${width}: indented bullets nest under the bullet above them`);
      // A bullet that only starts with a command is a sentence, never one chip; the command alone is.
      const [sentence, runs, merge] = seen.lists[2].items;
      assert.ok(!sentence.codes.some(([code]) => code === sentence.text) && /0 errors, and no/.test(sentence.text), `${width}: a sentence that starts with pullboard stays prose: ${JSON.stringify(sentence)}`);
      assert.ok(!runs.codes.some(([code]) => code === runs.text), `${width}: so does one that starts with npm and goes on in words: ${JSON.stringify(runs)}`);
      assert.deepEqual(merge.codes, [['git merge main', 'inline']], `${width}: a short command alone is one chip`);
      assert.deepEqual([seen.blocks, seen.dashes], [0, 0], `${width}: no code block and no stray dash in the brief`);
      assert.ok(seen.gap > 0.4 && seen.gap < 1.6, `${width}: one blank line between a list and the next label, as written: ${seen.gap.toFixed(2)} lines`);
      assert.ok(!seen.overflow, `${width}: nothing runs off the screen`);
    }
    await chrome.evaluate("document.querySelector('[data-tab=\"shouts\"]').click()");
    await chrome.waitFor("[...document.querySelectorAll('#feed code.block')].some((code) => code.textContent.includes('const greeting'))");
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the view has a light and a dark theme to choose [N26]', async () => {
  const view = await startView(machine());
  try {
    const store = storage();
    const page = await openPage(view, { store });
    const style = await styleOf(view);
    const tokens = /\n:root \{\n([^}]*)\n\}\n/.exec(style)?.[1] ?? '';
    // One list of tokens: every colour in it holds a light and a dark value.
    const colours = [...tokens.matchAll(/(--[a-z0-9-]+): ([^;]*(?:#[0-9a-f]{3,8}|rgba?\()[^;]*);/g)];
    assert.ok(colours.length >= 20, 'the colour tokens');
    assert.deepEqual(colours.filter((colour) => !colour[2].startsWith('light-dark(')).map((colour) => colour[1]), [], 'each holds a light and a dark value');
    assert.match(tokens, /^ {2}color-scheme: light dark;$/m, 'and they follow the system until the person picks');
    assert.match(style, /\n:root\[data-theme="light"\] \{ color-scheme: light; \}\n:root\[data-theme="dark"\] \{ color-scheme: dark; \}\n/, 'a pick sets the scheme the tokens answer to');
    assert.doesNotMatch(style, /prefers-color-scheme/, 'no second list for dark');
    assert.match(page.html, /<div class="side-top">\n(?: {4}<[^\n]*\n)*? {4}<button class="theme-btn" id="theme" type="button" title="Theme: system">[^\n]*<\/button>\n {2}<\/div>/, 'the button sits in the bar atop the sidebar, which is the top bar on a phone');

    const theme = (on) => [on.run('document.documentElement.dataset.scheme'), on.element('theme').title];
    assert.deepEqual([...theme(page), page.run('document.documentElement.dataset.theme') ?? null], ['dark', 'Dark theme: switch to light', null], 'with none picked it follows the system\'s theme');
    const presses = [];
    for (let press = 0; press < 3; press += 1) {
      await page.fire('theme', 'click');
      presses.push(theme(page));
    }
    assert.deepEqual(presses, [['light', 'Light theme: switch to dark'], ['dark', 'Dark theme: switch to light'], ['light', 'Light theme: switch to dark']], 'each press switches between light and dark, and the title says which is on');

    await page.fire('theme', 'click');
    await page.fire('theme', 'click');
    assert.deepEqual(theme(await openPage(view, { store })), ['light', 'Light theme: switch to dark'], 'a reload keeps the pick');
    assert.deepEqual(theme(await openPage(view)), ['dark', 'Dark theme: switch to light'], 'a browser that keeps nothing follows the system');
    assert.ok(['light', 'dark'].includes(store.getItem('pb.theme')), 'and what is kept is only ever light or dark');
  } finally {
    await view.stop();
  }
});
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

test("the sidebar shows each product's progress [N28]", async () => {
  const box = machine();
  const alpha = project(box, 'alpha', `${SPEC}- G3 [draft, must] The page has a footer. | gate: web test\n`, { products: { 'Pages <b>': ['G1', 'G3'], Goodbyes: ['G2'] } });
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Footer', '--specs', 'G3', '--criterion', 'has a footer');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  box.run(alpha.repo, 'add', 'web', 'Header', '--specs', 'G1', '--criterion', 'has a header');
  build(box, alpha, 1, 'greeting.html');
  accept(box, alpha, 1);
  build(box, alpha, 2, 'footer.html');
  box.run(alpha.web, 'claim', '3');
  const beta = project(box, 'beta');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.equal(page.element('products').hidden, false);
    assert.deepEqual(productEntries(page.show('prod-list')), [
      { name: 'Pages &lt;b&gt;', met: '1/2', bar: 50, items: ['1 open (grey)', '1 to verify (verify)', '1 verified (verified)'] },
      { name: 'Goodbyes', met: '0/1', bar: 0, items: ['1 building (building)'] },
    ]);
    // The same numbers pullboard status prints.
    assert.deepEqual(box.run(alpha.repo, 'status').split('\n').filter((line) => line.startsWith('product ')), [
      'product Pages <b>: 2 rows, 1 approved, 1 cited by accepted items; items 1 open, 0 building, 1 awaiting verification, 1 verified',
      'product Goodbyes: 1 rows, 1 approved, 0 cited by accepted items; items 0 open, 1 building, 0 awaiting verification, 0 verified',
    ]);
    assert.match(page.show('prod-list'), /title="2 rows in force, 1 approved, 1 cited by accepted items"/);

    await page.click({ root: beta.repo, classes: 'proj side' });
    assert.equal(page.element('products').hidden, true, 'a project that names no products shows none');
  } finally {
    await view.stop();
  }
});
/**
 * An item's timeline as rows: the state classes on its dot, its time, its event, who made it, and the
 * stay it began, with any running age read as its text.
 */
function timelineRows(html) {
  return [...html.matchAll(/<li class="([^"]*)"[^>]*><time>([^<]*)<\/time><span><b>([^<]*)<\/b> ([^<]*)<\/span>(?:<small>(.*?)<\/small>)?<\/li>/g)].map((match) => ({
    dot: match[1],
    time: match[2],
    event: `${match[3]} ${match[4]}`,
    stay: (match[5] ?? '').replace(/<time data-ago="[^"]+">([^<]*)<\/time>/, '$1'),
  }));
}

test("the history is a timeline of the item's states [N26]", async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  build(box, alpha, 1, 'greeting.html');
  sendBack(box, alpha, 1, 'no greeting');
  build(box, alpha, 1, 'greeting-again.html');
  accept(box, alpha, 1);
  box.git(alpha.repo, 'merge', '--no-ff', '-m', 'chore: merge fixture item', alpha.branch);
  const trunkCommit = box.git(alpha.repo, 'rev-parse', 'HEAD');
  assert.notEqual(trunkCommit, box.git(alpha.repo, 'rev-parse', alpha.branch), 'the receipt names the trunk merge commit');
  box.run(alpha.repo, 'merged', '1', trunkCommit);
  box.run(alpha.web, 'claim', '2');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ go: 'item:1' });
    const done = timelineRows(page.show('detail'));
    assert.deepEqual(done.map((row) => [row.dot, row.event]), [
      ['tl-open', 'add coordinator'],
      ['tl-claimed', 'claim web-1'],
      ['tl-submitted', 'submit web-1'],
      ['tl-open tl-back', 'reject coordinator'],
      ['tl-claimed', 'claim web-1'],
      ['tl-submitted', 'submit web-1'],
      ['tl-verified', 'accept coordinator'],
      ['tl-verified tl-quiet', 'merged coordinator'],
    ], 'a dot per event in the colour of the state it led to; a merge moves nothing');
    assert.deepEqual(done.map((row) => row.stay.replace(/ for .*/, ' for')), ['open for', 'claimed for', 'submitted for', 'sent back for', 'claimed for', 'submitted for', '', ''], 'each stay until the next move; a final state has none');
    assert.ok(done.slice(0, 6).every((row) => / for (under a minute|\d+m)$/.test(row.stay)), done.map((row) => row.stay).join(', '));
    assert.ok(done.every((row) => /^\d\d:\d\d$/.test(row.time)), 'every event keeps its time');

    await page.click({ go: 'item:2' });
    assert.deepEqual(timelineRows(page.show('detail')).map((row) => [row.dot, row.stay]).slice(1), [['tl-claimed', 'claimed for now so far']]);
    const later = await openPage(view, { later: 1 });
    await later.click({ go: 'item:2' });
    assert.deepEqual(timelineRows(later.show('detail')).map((row) => row.stay).slice(1), ['claimed for 24h so far'], 'the stay so far counts on');

    // A claim logged on an item the replay holds claimed: the clock lapsed the first claim between.
    const at = (minute) => new Date(Date.UTC(2026, 9, 6, 12, minute)).toISOString();
    const item = { status: 'claimed', history: [{ kind: 'add', by: 'web-1', at: at(0) }, { kind: 'claim', by: 'web-1', at: at(5) }, { kind: 'claim', by: 'web-2', at: at(200) }] };
    const lapsed = timelineRows(page.run(`timeline(${JSON.stringify(item)})`));
    assert.deepEqual(lapsed.map((row) => [row.dot, row.event, row.time === '']), [
      ['tl-open', 'add web-1', false],
      ['tl-claimed', 'claim web-1', false],
      ['tl-open', 'lapse the clock', true],
      ['tl-claimed', 'claim web-2', false],
    ]);
    assert.deepEqual(lapsed.map((row) => row.stay.replace(/ for .*/, ' for')), [
      'open for',
      'claimed until the lapse, length not logged',
      'open after the lapse, length not logged',
      'claimed for',
    ], 'a stay that ends or begins at an untimed lapse says its length was not logged');
    assert.equal(lapsed[0].stay, 'open for 5m');

    // A lease that ran out with nothing after it: the item reads open, and has been since the lapse.
    const idle = { status: 'open', history: [{ kind: 'add', by: 'web-1', at: at(0) }, { kind: 'claim', by: 'web-1', at: at(5) }] };
    assert.deepEqual(timelineRows(page.run(`timeline(${JSON.stringify(idle)})`)).map((row) => [row.event, row.stay]), [
      ['add web-1', 'open for 5m'],
      ['claim web-1', 'claimed until the lapse, length not logged'],
      ['lapse the clock', 'open so far since the lapse, length not logged'],
    ]);
  } finally {
    await view.stop();
  }
});
/**
 * The agents the panel shows: id, the path on hover, its last move, what it holds and how many more,
 * whether it reads idle, and its entry's text with the tags taken out. An agent holding work is a row
 * showing its first thing, or every thing once picked; an agent holding nothing is a pill.
 */
function agentEntries(html) {
  const rows = html.split(/<div class="agent-card[^"]*">/).slice(1).map((entry) => {
    const opened = [...entry.matchAll(/data-item="(\d+)"[^>]*><span>([^]*?)<\/span><span class="chip[^"]*">([^<]*)</g)].map((match) => `${match[2]}: ${match[3]}`);
    // The state is a word beside the name; what it holds follows at the full width.
    const what = /<span class="agent-what"><i>(#\d+)<\/i> ([^]*?)<\/span>/.exec(entry), word = /<span class="agent-who">[^]*?<span class="chip[^"]*">([^<]*)</.exec(entry);
    const first = what && word ? [null, what[1], what[2], word[1]] : null;
    return {
      id: /data-agent="([^"]*)"/.exec(entry)?.[1],
      path: /title="Shouts with [^"(]* \(([^"]*)\)"/.exec(entry)?.[1],
      age: /<time[^>]*>([^<]*)<\/time>/.exec(entry)?.[1],
      holds: opened.length ? opened : first ? [`${first[1]} ${first[2]}: ${first[3]}`] : [],
      more: Number(/<span class="agent-more">\+(\d+)<\/span>/.exec(entry)?.[1] ?? 0),
      idle: false,
      text: entry.replace(/<[^>]*>/g, ' '),
    };
  });
  const pills = [...html.matchAll(/<button class="agent-pill[^"]*" data-agent="([^"]*)" title="[^"(]* \(([^"]*)\)"[^>]*>([^]*?)<\/button>/g)]
    .map((match) => ({ id: match[1], path: match[2], age: undefined, holds: [], more: 0, idle: true, text: match[3].replace(/<[^>]*>/g, ' ') }));
  return [...rows, ...pills];
}

test('the agents panel says what each agent holds [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  const second = join(box.dir, 'alpha-web-two');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/two');
  box.run(second, 'join', 'web');
  for (const title of ['Header', 'Farewell', 'Greeting <b>bold</b>', 'Footer']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  // The board lists items newest first; each agent's rows must put its higher id second.
  build(box, alpha, 3, 'greeting.html');
  const two = { ...alpha, web: second, branch: 'web/two', baseBranch: 'web/two' };
  build(box, two, 2, 'farewell.html');
  sendBack(box, two, 2, 'no farewell on the page');
  build(box, two, 4, 'footer.html');
  box.run(alpha.web, 'claim', '1');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.deepEqual(agentEntries(page.show('agents')).map((agent) => agent.id), ['web-1', 'web-2'], 'an agent holding nothing waits in the idle fold, closed');
    assert.match(page.show('agents'), /<button class="fold-line" data-fold="idle" type="button" aria-expanded="false" title="coordinator"><span>1 idle<\/span>/);
    page.run('view.open.idle = true; render();');
    const agents = agentEntries(page.show('agents'));
    assert.deepEqual(agents.map((agent) => [agent.id, agent.holds, agent.more, agent.idle]), [
      // An agent holding work is a row with its first thing: the claim, then work sent back, then work waiting for a verdict.
      ['web-1', ['#1 Header: building'], 1, false],
      ['web-2', ['#2 Farewell: sent back'], 1, false],
      // One holding nothing is a pill.
      ['coordinator', [], 0, true],
    ]);
    for (const agent of agents.filter((entry) => !entry.idle)) assert.match(agent.age, /^(now|\d+[mhd])$/, `${agent.id} shows when it last moved`);
    assert.deepEqual(agents.map((agent) => agent.path), [alpha.web, second, alpha.repo], 'each path is on hover');
    // Picked, an agent's row opens to every thing it holds, in that order.
    const opened = (id) => { page.run(`view.agent = ${JSON.stringify(id)}; render();`); return agentEntries(page.show('agents')).find((agent) => agent.id === id).holds; };
    assert.deepEqual(opened('web-1'), ['#1 Header: building', '#3 Greeting &lt;b&gt;bold&lt;/b&gt;: to verify']);
    assert.deepEqual(opened('web-2'), ['#2 Farewell: sent back', '#4 Footer: to verify']);
    page.run('view.agent = null; render();');
    for (const agent of agents) assert.ok(!agent.text.includes(agent.path), `${agent.id}'s path is not in the text`);

    await page.click({ go: 'item:1' });
    assert.match(page.show('detail'), /<h2><span>#1<\/span>Header<\/h2>/, 'a held item opens on the Items tab');
  } finally {
    await view.stop();
  }
});

test('a review in progress names its reviewer [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  const second = join(box.dir, 'alpha-web-two');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/two');
  box.run(second, 'join', 'web');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  box.run(second, 'next', '--verify');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.match(itemRow(page.show('chain'), 1), /<span class="chip warn" title="reviewing until [^"]+">web-2 reviewing<\/span><\/li>$/, 'the row names who holds the review');
    assert.doesNotMatch(page.show('needs'), /Greeting/, "a review is the agents' work, so it stays out of Needs-you");
    page.run('view.open.idle = true; render();');
    const holds = (id) => agentEntries(page.show('agents')).find((agent) => agent.id === id).holds;
    assert.deepEqual(holds('web-2'), ['#1 Greeting: reviewing'], 'the reviewer holds it');
    assert.deepEqual(holds('web-1'), ['#1 Greeting: to verify'], 'the builder waits on it');
    // A name is board text, so it is escaped: give the board on hand a reviewer with markup and redraw.
    page.run('data.project.items.find((i) => i.id === 1).reviewer = "web<b>"; render();');
    assert.match(itemRow(page.show('chain'), 1), />web&lt;b&gt; reviewing<\/span><\/li>$/);
    await page.run('refresh()');

    box.git(second, 'switch', '-q', '--detach', alpha.branch);
    box.run(second, 'verify', '1', 'accept', '--note', 'opened the page and read the greeting');
    await page.run('refresh()');
    await page.click({ state: 'all' });
    assert.match(itemRow(page.show('chain'), 1), /<span class="chip ok">verified<\/span><\/li>$/, 'once the verdict lands, the review is over');
    assert.deepEqual(holds('web-2'), []);
  } finally {
    await view.stop();
  }
});
test('the tab title says what needs you [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  build(box, alpha, 1, 'greeting.html');
  sendBack(box, alpha, 1, 'no greeting');
  build(box, alpha, 2, 'farewell.html');
  const beta = project(box, 'beta');
  box.run(beta.repo, 'hold', 'web', '--reason', 'G2 is changing');
  const calm = project(box, 'calm');
  const view = await startView(box);
  const nobody = await startView(machine());
  try {
    const page = await openPage(view);
    const title = () => page.run('document.title');
    assert.equal(title(), '(1) alpha · Pullboard', "the lane held in beta; alpha's work sent back or waiting for a verdict is the agents'");
    page.run(`switchTo(${JSON.stringify(calm.repo)})`);
    assert.equal(title(), '(1) calm · Pullboard', 'a switch names the project at once; the count still covers them all');
    await page.run('refresh()');
    assert.equal(title(), '(1) calm · Pullboard');

    box.run(alpha.repo, 'withdraw', '1', 'the greeting moved to the next release');
    accept(box, alpha, 2);
    box.run(beta.repo, 'hold', 'web', '--off');
    await page.run('refresh()');
    assert.equal(title(), 'calm · Pullboard', 'nothing needs the person, so no count');

    assert.equal((await openPage(nobody)).run('document.title'), 'Pullboard', 'with no project to show');
  } finally {
    await view.stop();
    await nobody.stop();
  }
});
test('an open decision counts in the sidebar and the tab title [B21, B26, N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  const beta = project(box, 'beta');
  box.run(beta.web, 'shout', 'coordinator', 'Ship beta today?', '--decision');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const rows = () => projectRows(page.show('proj-list')).map((row) => [row.name, row.needs, row.line]);
    assert.deepEqual(rows(), [['alpha', '', 'nothing open'], ['beta', '', 'nothing open']], "an agent's ask is its coordinator's to answer, so it counts for no one here");

    box.run(beta.repo, 'pass', '1', 'it changes the launch');
    await page.run('refresh()');
    assert.deepEqual(rows(), [['alpha', '', 'nothing open'], ['beta', '1', '1 decision']], "passed up, it needs the person, from alpha too");
    assert.equal(page.run('document.title'), '(1) alpha · Pullboard');

    box.run(beta.repo, 'shout', 'person', 'And the docs?', '--decision');
    await page.run('refresh()');
    assert.deepEqual(rows()[1], ['beta', '2', '2 decisions'], 'a coordinator asks the person straight out too');
    box.run(beta.repo, 'answer', '2', 'yes', '--as', 'person');
    box.run(beta.repo, 'answer', '3', 'after', '--as', 'person');
    await page.run('refresh()');
    assert.deepEqual(rows(), [['alpha', '', 'nothing open'], ['beta', '', 'nothing open']], 'answered, they need no one');
    const replies = JSON.parse(box.run(beta.web, 'inbox', '--json')).shouts.filter((shout) => shout.shout_answers === 1);
    assert.deepEqual(replies.map((shout) => [shout.shout_from, shout.shout_to, shout.shout_answers, shout.shout_text]),
      [['person', 'web-1', 1, 'Person answered #2: yes']], "the person's answer reaches the agent that asked");
    assert.equal(page.run('document.title'), 'alpha · Pullboard');
  } finally {
    await view.stop();
  }
});
test('each row says what it waits on [N26]', async () => {
  const box = machine();
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, api: { owns: ['api/'], specs: ['G'] } };
  const alpha = project(box, 'alpha', SPEC, { lanes });
  const add = (lane, title, ...more) => box.run(alpha.repo, 'add', lane, title, '--specs', 'G1', '--criterion', 'renders', ...more);
  add('web', 'Free');
  add('web', 'Base');
  add('web', 'Depends', '--after', '2');
  add('api', 'Api work');
  add('web', 'Shipped');
  add('web', 'Bounced');
  build(box, alpha, 5, 'shipped.html');
  build(box, alpha, 6, 'bounced.html');
  sendBack(box, alpha, 6, 'not yet');
  box.run(alpha.web, 'claim', '2');
  box.run(alpha.repo, 'hold', 'api', '--reason', 'API <freeze> until Friday');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const rows = Object.fromEntries(page.show('chain').split('<li class="row').slice(1).map((row) => [/data-item="(\d+)"/.exec(row)[1], {
      chip: /<span class="chip ([^"]*)"[^>]*>([^<]*)<\/span><\/li>$/.exec(row).slice(1).join(': '),
      edge: /^[^"]*\bgated\b/.test(row),
      waits: [...row.matchAll(/<span class="gate">(.*?)<\/span>/g)].map((match) => match[1]),
    }]));
    assert.deepEqual(rows['1'], { chip: 'free: unclaimed', edge: false, waits: [] }, 'free to claim');
    assert.deepEqual(rows['2'], { chip: 'busy: web-1', edge: false, waits: [] }, 'a claim names its holder');
    assert.deepEqual(rows['3'], { chip: 'gate: gated', edge: true, waits: ['<span class="wait-unit">waits on <button class="ref" data-go="item:2" type="button">#2</button>'] }, 'gated on #2, which is still being built');
    assert.deepEqual(rows['4'], { chip: 'gate: lane held', edge: true, waits: ['lane held: API &lt;freeze&gt; until Friday'] });
    assert.deepEqual(rows['5'], { chip: 'warn: to verify', edge: false, waits: [] });
    assert.deepEqual(rows['6'], { chip: 'no: sent back', edge: false, waits: [] });

    await page.click({ go: 'item:2' });
    assert.match(page.show('detail'), /<h2><span>#2<\/span>Base<\/h2>/, 'the gate links to what it waits on');
  } finally {
    await view.stop();
  }
});
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
      pair: /^\w+, (\w+) to (\w+),/.exec(match[1]).slice(1).join('>'),
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

test('the activity tab draws the lifecycle from the declaration, as the README does, with live counts [N26, M1]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  for (const title of ['Greeting', 'Farewell', 'Header', 'Footer', 'Sidebar', 'Banner', 'Menu', 'Search']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 1, 'greeting.html');
  accept(box, alpha, 1);
  build(box, alpha, 2, 'farewell.html');
  sendBack(box, alpha, 2, 'no farewell');
  // Withdrawn from claimed twice, from submitted once and from open once, so each route has its count.
  for (const id of ['6', '8']) {
    box.run(alpha.web, 'claim', id);
    box.run(alpha.repo, 'withdraw', id, 'not this release');
  }
  build(box, alpha, 7, 'menu.html');
  box.run(alpha.repo, 'withdraw', '7', 'the menu moved to the next release');
  box.run(alpha.web, 'claim', '3');
  box.run(alpha.web, 'claim', '3');
  box.run(alpha.repo, 'withdraw', '4', 'the footer moved to the next release');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.doesNotMatch(page.html, /id="metrics"/, 'the drawing replaces the metric cards');
    assert.ok(!page.html.includes('pullboard claim <id>'), 'the declaration is embedded with < escaped');
    const svg = page.show('flow');
    const { boxes, routes, sentBack } = drawing(svg);

    const esc = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    assert.deepEqual(boxes.map((entry) => entry.state), MACHINE.states.map((state) => state.id), 'a box for every declared state');
    for (const state of MACHINE.states) assert.ok(boxes.find((entry) => entry.state === state.id).title.startsWith(esc(`${state.id}: ${state.means}`)), `${state.id} says what it means`);
    assert.match(boxes.find((entry) => entry.state === 'verified').title, /Every way in checks:\n {2}the caller&#39;s checkout contains the submitted commit\n {2}the caller did not build it/);
    assert.deepEqual(Object.fromEntries(boxes.map((entry) => [entry.state, entry.count])), { open: 2, claimed: 1, submitted: 0, verified: 1, withdrawn: 4 });
    assert.equal(sentBack, '1 sent back');
    assert.deepEqual(boxes.filter((entry) => entry.double).map((entry) => entry.state), MACHINE.states.filter((state) => state.final).map((state) => state.id), 'a final state has a double border');

    // The moves that keep a state are written in its box, not drawn as loops.
    const keeping = MACHINE.states.filter((state) => MACHINE.moves.some((move) => move.to === state.id && move.from.includes(state.id))).map((state) => state.id);
    assert.deepEqual(Object.fromEntries(boxes.filter((entry) => entry.keeps).map((entry) => [entry.state, entry.keeps])), {
      open: '↻ escalate · refreeze (none yet)',
      claimed: '↻ claim 1',
      submitted: '↻ reserve (none yet)',
    });
    assert.deepEqual(boxes.filter((entry) => entry.keeps).map((entry) => entry.state), keeping, 'each state a move keeps');

    const pairs = new Set(MACHINE.moves.flatMap((move) => move.from.filter((from) => from !== move.to).map((from) => `${from}>${move.to}`)));
    assert.deepEqual(routes.map((route) => route.pair).sort(), [...pairs].sort(), 'one route per pair of states a move joins');
    for (const move of MACHINE.moves) {
      for (const from of move.from.filter((from) => from !== move.to)) assert.ok(routes.find((route) => route.pair === `${from}>${move.to}`).title.includes(`${move.verb}, ${from} to ${move.to}, by the ${move.by.join(' or ')}: `), `${move.verb} from ${from} is on its route`);
    }
    assert.ok(routes.some((route) => route.title.includes('claim, open to claimed, by the agent or coordinator: pullboard claim &lt;id&gt;. Made 6 times.\nChecks, in order:\n  the caller is the main checkout, or a worktree that joined a lane (NOT_JOINED)\n  the item exists (NO_ITEM)\n  the item is open or claimed (NOT_CLAIMABLE)')), 'each check in order, escaped');
    // The moves made along a route and how often, or its moves when none was; the routes into the
    // state below the row join into one, labelled once with their total.
    assert.deepEqual(Object.fromEntries(routes.map((route) => [route.pair, route.label])), {
      'open>claimed': 'claim 6',
      'claimed>open': 'release · lapse · escalate · refreeze (none yet)',
      'claimed>submitted': 'submit 3',
      'submitted>verified': 'accept 1',
      'submitted>open': 'reject 1',
      'open>withdrawn': 'withdraw 4',
      'claimed>withdrawn': null,
      'submitted>withdrawn': null,
    });

    // Every route is square, and the ones back to an earlier state are dashed, each at its own height.
    for (const route of routes) {
      route.points.slice(1).forEach(([x, y], n) => assert.ok(x === route.points[n][0] || y === route.points[n][1], `${route.pair} runs square: ${JSON.stringify(route.points)}`));
    }
    const backs = routes.filter((route) => route.back);
    assert.deepEqual(backs.map((route) => route.pair).sort(), ['claimed>open', 'submitted>open'], 'the routes back are the ones to an earlier state');
    assert.equal(new Set(backs.map((route) => route.points[1][1])).size, backs.length, 'each at its own height');
    assert.match(await styleOf(view), /\n\.flow \.edge\.back \{ stroke: var\(--reject\); stroke-dasharray: 5 4; \}/, 'dashed');

    // No word comes within two units of another, a box it is not in, or a route.
    const texts = textBoxes(svg);
    const rects = [...svg.matchAll(/<rect class="box" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map(([, x, y, w, h]) => ({ left: Number(x), top: Number(y), right: Number(x) + Number(w), bottom: Number(y) + Number(h) }));
    const segments = routes.flatMap((route) => route.points.slice(1).map(([x, y], n) => ({ left: Math.min(x, route.points[n][0]), right: Math.max(x, route.points[n][0]) + 0.01, top: Math.min(y, route.points[n][1]), bottom: Math.max(y, route.points[n][1]) + 0.01 })));
    texts.forEach((one, n) => {
      for (const other of texts.slice(n + 1)) assert.ok(!meet(one, other, 2), `"${one.words}" and "${other.words}" overlap`);
      const home = rects.filter((rect) => meet(one, rect, one.inside ? 0 : 2));
      assert.deepEqual(home.length, one.inside ? 1 : 0, `"${one.words}" sits ${one.inside ? 'in its box' : 'clear of every box'}`);
      if (one.inside) assert.ok(one.left >= home[0].left && one.right <= home[0].right && one.top >= home[0].top && one.bottom <= home[0].bottom, `"${one.words}" fits inside its box`);
      for (const segment of segments) assert.ok(!meet(one, segment, 2), `"${one.words}" is clear of every route`);
    });

    // The clock's lapse is never logged: an item that reads open after its claim, and a claim logged
    // on an item the replay holds claimed, each mean the clock moved first.
    const counts = JSON.parse(page.run(`JSON.stringify([...moveCounts([
      { status: 'open', history: [{ kind: 'add' }, { kind: 'claim' }] },
      { status: 'claimed', history: [{ kind: 'add' }, { kind: 'claim' }, { kind: 'renew' }, { kind: 'claim' }] },
    ])])`));
    assert.deepEqual(counts, [['open>claimed:claim', 3], ['claimed>open:lapse', 2], ['claimed>claimed:claim', 1]]);
  } finally {
    await view.stop();
  }
});
test('a closed lifecycle stays closed, across a reload and a restart of the view [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  const first = await startView(box);
  const store = storage();
  let port;
  try {
    port = first.link.port;
    const page = await openPage(first, { store });
    await page.click({ tab: 'activity' });
    assert.match(page.show('flow'), /^<svg /, 'the figure shows at first');
    assert.deepEqual([page.element('flow-panel').hidden, page.element('flow-show').hidden], [false, true]);
    await page.fire('flow-hide', 'click');
    assert.deepEqual([page.element('flow-panel').hidden, page.element('flow-show').hidden], [true, false], 'closed, with a way to show it again');

    const reloaded = await openPage(first, { store });
    assert.deepEqual([reloaded.element('flow-panel').hidden, reloaded.element('flow-show').hidden], [true, false], 'a reload keeps it closed');
    assert.equal(reloaded.element('flow').writes, 0, 'and a closed figure is not drawn');
  } finally {
    await first.stop();
  }
  // The browser keeps the choice per address, so the view comes back on the port it last used.
  const second = await startView(box);
  try {
    assert.equal(second.link.port, port, 'a restarted view serves from the same port, where the browser kept the choice');
    const page = await openPage(second, { store });
    assert.equal(page.element('flow-panel').hidden, true, 'still closed');
    await page.fire('flow-show', 'click');
    assert.deepEqual([page.element('flow-panel').hidden, page.element('flow-show').hidden], [false, true], 'shown again on request');
    assert.match(page.show('flow'), /^<svg /, 'and drawn');
    assert.equal(store.getItem('pb.flow'), 'shown');
  } finally {
    await second.stop();
  }
  // With its last port taken, the view takes any free one rather than failing.
  const taken = await new Promise((done) => { const server = createServer(); server.listen(Number(port), '127.0.0.1', () => done(server)); });
  try {
    const third = await startView(box);
    try {
      assert.notEqual(third.link.port, port, 'a busy port is passed over');
    } finally {
      await third.stop();
    }
  } finally {
    await new Promise((done) => taken.close(done));
  }
});
test('ages stay true while the board is quiet [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  box.run(alpha.repo, 'shout', 'person', 'Ship the greeting today?', '--decision');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const ages = () => ({
      row: /<time data-ago="[^"]+">([^<]*)<\/time>/.exec(itemRow(page.show('chain'), 1))?.[1],
      needs: /data-go="decide:[^"]*"[^]*?<span class="row-age"><time data-ago="[^"]+">([^<]*)<\/time>/.exec(page.show('needs'))?.[1],
      agent: agentEntries(page.show('agents')).find((agent) => agent.id === 'web-1')?.age,
      shout: /<time class="long" data-ago="[^"]+" title="[^"]*">([^<]*)<\/time>/.exec(page.show('feed'))?.[1],
    });
    assert.deepEqual(ages(), { row: 'now', needs: 'now', agent: 'now', shout: 'now' });
    const rebuilds = () => ['chain', 'needs', 'agents', 'feed'].map((id) => page.element(id).writes);
    const before = rebuilds();

    // Three hours pass, nothing on the board changes, and the minute timer fires.
    page.run('const D = Date; globalThis.Date = class extends D { constructor(...a) { super(...(a.length ? a : [D.now() + 3 * 3600e3])); } static now() { return D.now() + 3 * 3600e3; } };');
    page.run('tickAges()');
    assert.deepEqual(ages(), { row: '3h', needs: '3h', agent: '3h', shout: '3h ago' }, 'a shout says how long ago in words');
    assert.deepEqual(rebuilds(), before, 'each age moved where it stands; nothing was rebuilt');
  } finally {
    await view.stop();
  }
});
/**
 * The coordinator accepts an item from a checkout of its submitted commit.
 */
function accept(box, p, id) {
  box.git(p.repo, 'switch', '-q', '--detach', p.itemBranches.get(`${p.baseBranch}:${id}`) ?? p.branch);
  box.run(p.repo, 'verify', String(id), 'accept', '--note', 'the page shows it', '--as', 'coordinator');
  box.git(p.repo, 'switch', '-q', 'main');
}

/**
 * One item's row in the list, or '' when the list does not show it.
 */
function needEntries(html) {
  return [...html.matchAll(/<li class="row ask"(?: data-go="([^"]*)")?><span class="dot ask"><\/span><div><div class="t">(?:<span>([^<]*)<\/span>)?([^]*?)<\/div>(?:<span class="row-age">[^]*?<\/span>)?<div class="meta"><span class="why"><b>NEEDS YOU<\/b> ([^<]*)<\/span><\/div><\/div><span class="chip warn">([^<]*)<\/span><\/li>/g)]
    .map((row) => [row[1] ?? null, row[2] ?? null, row[3], row[4], row[5]]);
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
  const res = await fetchLive(`${view.base}/api/v1/boards/${id}/state`, { headers: { 'x-pullboard-key': view.key } });
  assert.equal(res.status, 200);
  return (await res.json()).state;
}

/** Check each reported queue age before comparing observations, so independent clocks stay exact. */
function assertObservationAges(observation) {
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
      return !flowClock && !queueAge;
    })
    .map(([key, entry]) => [key, withoutObservationAges(entry, [...path, key])]));
}

/** Validate both clocks independently, then compare every field except asOf and ageMinutes. */
function assertObservationsEqual(expected, actual, message) {
  assertObservationAges(expected);
  assertObservationAges(actual);
  assert.deepEqual(withoutObservationAges(actual), withoutObservationAges(expected), message);
}

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

test('no box carries a coloured edge [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  sendBack(box, alpha, 1, 'no greeting yet');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const style = await styleOf(view);
    // Every border drawn on one side of a box is nothing, or a 1px divider in the neutral line colour.
    const sides = [...style.matchAll(/border-(?:top|bottom|left|right|inline|block)[a-z-]*:\s*([^;}]+)/g)].map((match) => match[0].trim());
    assert.ok(sides.length > 0);
    assert.deepEqual(sides.filter((side) => !/^border-(?:top|bottom|left|right): (?:0|1px solid var\(--line\))$/.test(side)), [], 'no coloured or thick bar on one edge');
    assert.doesNotMatch(style, /box-shadow:[^;}]*inset -?\d+(?:\.\d+)?px 0 0/, 'and no stripe drawn by a shadow');

    await page.click({ go: 'item:1' });
    assert.match(page.show('detail'), /<div class="verdict no"><b>REJECT BEHAVIOR_MISMATCH<\/b>/, 'a verdict says what it decided');
    assert.match(style, /\.verdict\.yes b \{ color: var\(--accent-strong\); \} \.verdict\.no b \{ color: var\(--reject\); \}/, 'in the colour of its word, not a bar');
  } finally {
    await view.stop();
  }
});
test("the view's styles live in their own file [N26]", async () => {
  const box = machine();
  const alpha = project(box, 'alpha', SPEC, { products: { Pages: ['G1', 'G2'] } });
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  accept(box, alpha, 1);
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.doesNotMatch(page.html, /<style|style=/, 'the page holds no styles');
    assert.match(page.html, new RegExp(`\n<link rel="stylesheet" href="/view\\.css\\?k=${view.key}">\n`), 'it links its own, with the secret');
    const css = await fetchLive(`${view.base}/view.css?k=${view.key}`);
    assert.equal(css.status, 200);
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal(await css.text(), readFileSync(new URL('../src/view.css', import.meta.url), 'utf8'), 'src/view.css, as it is');
    assert.equal((await fetchLive(`${view.base}/view.css`)).status, 403, 'nothing without the secret');
    const stranger = await new Promise((done, fail) => {
      request({ host: '127.0.0.1', port: view.link.port, path: `/view.css?k=${view.key}`, headers: { host: 'pullboard.example' } }, (res) => done(res.statusCode)).on('error', fail).end();
    });
    assert.equal(stranger, 403, 'nor under another Host');
    const policy = (await fetchLive(view.link)).headers.get('content-security-policy');
    assert.equal(/(?:^|; )style-src ([^;]*)/.exec(policy)?.[1], "'self'", 'styles come from the view alone, never inline');

    // Nothing the script draws carries a style either: products, the list, a picked item, a spec row.
    await page.click({ go: 'item:1' });
    await page.click({ rows: 'spec:all' });
    await page.click({ row: 'spec:G1' });
    assert.match(page.show('prod-list'), /<svg class="bar" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true"><rect width="50" height="1"\/><\/svg>/, 'a product bar is drawn, half full');
    // Each layout keeps its own spacing: an item's meta line sits 6px under its title, a spec row's 2px.
    const style = await styleOf(view);
    assert.match(page.show('detail'), /<\/h2><div class="meta spaced">/);
    assert.match(page.show('spec-detail'), /<\/h2><div class="meta">/);
    assert.match(style, /\n\.meta \{ [^}]*margin-top: 2px; \}\n/);
    assert.match(style, /\n\.meta\.spaced \{ margin-top: 6px; \}\n/);
    assert.doesNotMatch(style, /h2 \+ \.meta/, 'no rule reaches past the item into a spec row');
    for (const id of [...page.html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])) {
      assert.doesNotMatch(page.show(id), /style=/, `#${id} holds no style`);
    }
  } finally {
    await view.stop();
  }
});
test('an item detail shows its pending, red and green check baselines from the API [V2,N26]', async () => {
  const box = machine();
  const alpha = project(box, 'check-baselines');
  const main = box.git(alpha.repo, 'rev-parse', 'main');
  const checks = [
    { title: 'Pending baseline', command: 'node --test pending.test.js', result: 'pending', request: '00000000-0000-4000-8000-000000000001' },
    { title: 'Red baseline', command: 'node --test red.test.js', result: 'red', seconds: 2 },
    { title: 'Green baseline', command: 'node --test green.test.js', result: 'green', seconds: 1 },
  ];
  const board = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  let ids;
  try {
    ids = checks.map((check) => addItem(board, {
      by: 'coordinator', lane: 'web', title: check.title, criterion: 'shows the observed check result', specIds: ['G1'],
      check: check.command,
      checkBaseline: { command: check.command, main, result: check.result, ...(check.request ? { request: check.request } : {}), ...(check.seconds ? { seconds: check.seconds } : {}) },
    }));
  } finally {
    closeBoard(board);
  }
  const view = await startView(box);
  try {
    const state = await boardOf(view, alpha.repo);
    for (let index = 0; index < checks.length; index += 1) {
      assert.equal(state.items.find((item) => item.id === ids[index]).check, checks[index].command);
      assert.equal(state.items.find((item) => item.id === ids[index]).checkBaseline.result, checks[index].result,
        'the local API exposes the recorded baseline state');
    }
    assert.equal(state.items.find((item) => item.id === ids[2]).checkBaseline.warning, 'CRITERION_PROVES_NOTHING');

    const page = await openPage(view);
    for (let index = 0; index < checks.length; index += 1) {
      await page.click({ item: String(ids[index]), classes: 'row' });
      const detail = page.show('detail');
      assert.match(detail, /<h3>Check<\/h3>/);
      assert.ok(detail.indexOf('<h3>Criterion</h3>') < detail.indexOf('<h3>Check</h3>')
        && detail.indexOf('<h3>Check</h3>') < detail.indexOf('<h3>Spec rows it serves</h3>'), 'the check sits beside the criterion');
      assert.ok(detail.includes(`<code>${checks[index].command}</code>`), 'the displayed check is the API command');
      assert.ok(detail.includes(`<span class="chip ${checks[index].result === 'green' ? 'ok' : checks[index].result === 'red' ? 'no' : 'warn'}">${checks[index].result}</span>`),
        `the ${checks[index].result} baseline is visible`);
      if (checks[index].result === 'green') {
        assert.ok(detail.includes('This check already passed before the work, so it proves nothing.'), 'green baseline warning is plain language');
      } else {
        assert.doesNotMatch(detail, /proves nothing/, 'pending and red baselines do not claim the check proves nothing');
      }
      if (checks[index].result === 'pending') {
        const completionBoard = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
        try {
          assert.equal(completeCheckBaseline(completionBoard, ids[index], {
            agentId: 'coordinator',
            expected: { command: checks[index].command, main, result: 'pending', request: checks[index].request },
            baseline: { command: checks[index].command, main, result: 'green', seconds: 1 },
          }), true, 'the authorized pending baseline completes once');
        } finally {
          closeBoard(completionBoard);
        }
        await page.run('refresh()');
        const completed = page.show('detail');
        assert.match(completed, /<h2><span>#\d+<\/span>Pending baseline<\/h2>/, 'the open detail stays on the pending item');
        assert.ok(completed.includes('<span class="chip ok">green</span>'), 'the open detail updates to the completed result');
        assert.ok(completed.includes('This check already passed before the work, so it proves nothing.'), 'the completed warning appears without reopening the detail');
      }
    }
  } finally {
    await view.stop();
  }
});

test('a sent-back item shows why first [N26]', async () => {
  const box = machine();
  const p = project(box, 'shop');
  box.run(p.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets by name', '--brief', 'Files: web/greeting.html');
  box.run(p.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye', '--brief', 'Files: web/farewell.html');
  box.run(p.repo, 'add', 'web', 'Heading', '--specs', 'G1', '--criterion', 'has a heading', '--brief', 'Files: web/heading.html');
  build(box, p, 1, 'greeting.html');
  sendBack(box, p, 1, 'no <b>greeting</b> on the page\nsecond line of the note');
  build(box, p, 2, 'farewell.html');
  sendBack(box, p, 2, 'the farewell is missing');
  build(box, p, 2, 'farewell-again.html');
  build(box, p, 3, 'heading.html');
  sendBack(box, p, 3, 'no heading yet');
  build(box, p, 3, 'heading-again.html');
  accept(box, p, 3);
  // Two more ways to be sent back and not verified: withdrawn after the reject, and being reworked.
  box.run(p.repo, 'add', 'web', 'Banner', '--specs', 'G1', '--criterion', 'shows a banner', '--brief', 'Files: web/banner.html');
  box.run(p.repo, 'add', 'web', 'Footer', '--specs', 'G1', '--criterion', 'shows a footer', '--brief', 'Files: web/footer.html');
  build(box, p, 4, 'banner.html');
  sendBack(box, p, 4, 'the banner covers the heading');
  box.run(p.repo, 'withdraw', '4', 'the banner is dropped');
  build(box, p, 5, 'footer.html');
  sendBack(box, p, 5, 'the footer is empty');
  box.run(p.web, 'claim', '5');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const beforeCriterion = () => page.show('detail').slice(0, Math.max(0, page.show('detail').indexOf('<h3>Criterion</h3>')));
    const needs = page.show('needs');
    assert.doesNotMatch(needs, /Greeting|Farewell/, "work sent back is the agents' to move, so it stays out of Needs-you; its row says why");
    const row = itemRow(page.show('chain'), 1);
    assert.ok(row.includes('<b>BEHAVIOR_MISMATCH</b> no &lt;b&gt;greeting&lt;/b&gt; on the page'), row);
    assert.ok(!row.includes('second line'), 'the row shows the first line of the note only');
    assert.ok(itemRow(page.show('chain'), 2).includes('<b>BEHAVIOR_MISMATCH</b> the farewell is missing'));

    await page.click({ item: '1', classes: 'row' });
    const detail = page.show('detail');
    const verdict = (await boardOf(view, p.repo)).items.find((item) => item.id === 1).verdict;
    const time = new Date(verdict.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const top = detail.slice(0, detail.indexOf('<h3>Criterion</h3>'));
    assert.ok(detail.indexOf('<h3>Criterion</h3>') > 0, 'the criterion is shown');
    assert.match(top, /<h3>Sent back<\/h3>/);
    assert.match(top, /<b>REJECT BEHAVIOR_MISMATCH<\/b>/);
    assert.match(top, new RegExp(`coordinator · (\\w+ \\d+ )?${time} · at ${verdict.commit.slice(0, 12)}`), 'who sent it back, when, and at which commit');
    assert.ok(top.includes('no &lt;b&gt;greeting&lt;/b&gt; on the page\nsecond line of the note'), 'the full note, escaped, before the criterion');
    assert.ok(!detail.includes('<b>greeting</b>'), 'the note cannot inject markup');
    assert.ok(detail.indexOf('<h3>Criterion</h3>') < detail.indexOf('<h3>Spec rows it serves</h3>'));
    assert.ok(detail.indexOf('<h3>Spec rows it serves</h3>') < detail.indexOf('<h3>Brief</h3>'));
    assert.equal(detail.split('second line of the note').length, 2, 'the note is shown once');

    await page.click({ item: '2', classes: 'row' });
    assert.match(beforeCriterion(), /<h3>Sent back, resubmitted<\/h3>[^]*the farewell is missing/);

    assert.ok(itemRow(page.show('chain'), 5).includes('<b>BEHAVIOR_MISMATCH</b> the footer is empty'), 'a row being reworked still says why');
    await page.click({ item: '5', classes: 'row' });
    assert.match(beforeCriterion(), /<h3>Sent back, being reworked<\/h3>[^]*<b>REJECT BEHAVIOR_MISMATCH<\/b>[^]*the footer is empty/);

    // A withdrawn item has no row; the person reaches it from a spec row or the activity feed.
    assert.equal(itemRow(page.show('chain'), 4), '');
    await page.click({ go: 'item:4' });
    assert.match(page.show('detail'), /<h2><span>#4<\/span>Banner<\/h2>/);
    assert.match(beforeCriterion(), /<h3>Sent back, then withdrawn<\/h3>[^]*<b>REJECT BEHAVIOR_MISMATCH<\/b>[^]*the banner covers the heading/, 'withdrawn after a reject, it still opens with why');
    assert.ok(page.show('detail').indexOf('<h3>Criterion</h3>') < page.show('detail').indexOf('<h3>Brief</h3>'));

    await page.click({ item: '3', classes: 'row' });
    const verified = page.show('detail');
    assert.doesNotMatch(verified, /Sent back/);
    assert.ok(verified.indexOf('<h3>Criterion</h3>') < verified.indexOf('<h3>Brief</h3>'));
    assert.ok(verified.indexOf('<h3>Brief</h3>') < verified.indexOf('<h3>Verdicts</h3>'), 'a verified item keeps its verdicts after the brief');
    assert.ok(verified.indexOf('<h3>Verdicts</h3>') < verified.indexOf('no heading yet'));
    assert.ok(verified.indexOf('no heading yet') < verified.indexOf('the page shows it'), 'every verdict, oldest first');
  } finally {
    await view.stop();
  }
});

test('the list shows active, verified or all [N26]', async () => {
  const box = machine();
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, api: { owns: ['api/'], specs: ['G'] } };
  const alpha = project(box, 'alpha', SPEC, { lanes });
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'api', 'Endpoint', '--specs', 'G1', '--criterion', 'answers');
  build(box, alpha, 1, 'greeting.html');
  accept(box, alpha, 1);
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const control = () => [...page.show('state-chips').matchAll(/<button data-state="([a-z]+)" class="(on)?" type="button">([A-Za-z]+)<b>(\d+)<\/b><\/button>/g)].map((match) => `${match[3]} ${match[4]}${match[2] ? ' (shown)' : ''}`);
    const rows = () => [...page.show('chain').matchAll(/data-item="(\d+)"/g)].map((match) => Number(match[1])).sort();
    assert.deepEqual(control(), ['Active 1 (shown)', 'Verified 1', 'All 2'], 'three choices, each with its count');
    assert.deepEqual(rows(), [2]);
    await page.click({ state: 'verified' });
    assert.deepEqual(rows(), [1]);
    await page.click({ state: 'all' });
    assert.deepEqual(rows(), [1, 2]);
    assert.match(page.html, /<div class="card-panel toolbar"><div class="seg" id="state-chips" role="group" aria-label="Show"><\/div><select class="lane-pick" id="lane-pick" aria-label="Lane"><\/select><button class="go" id="new-item"/, 'the control sits in the toolbar beside the lane picker and New item');
    assert.match(page.html, /<header class="top">[^]*<div class="top-find"><input id="q" type="search"[^]*<\/header>/, 'and the search is in the top bar');
    assert.doesNotMatch(page.html, /id="lane-filter"|class="chips" id="state-chips"/, 'no lane menu and no row of chips');

    await page.click({ state: 'active' });
    await page.type('q', 'api');
    assert.deepEqual(rows(), [2], 'typing a lane finds its items');
  } finally {
    await view.stop();
  }
});
test('shout ids, search and narrow windows reach the item [N26]', async () => {
  const box = machine();
  const p = project(box, 'desk');
  box.run(p.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(p.repo, 'add', 'web', 'Farewell banner', '--specs', 'G2', '--criterion', 'says goodbye');
  build(box, p, 2, 'farewell.html');
  accept(box, p, 2);
  // Item 39 exists, so an escaped apostrophe (&#39;) read as an id would turn into a link.
  for (let id = 3; id <= 39; id += 1) box.run(p.repo, 'add', 'web', `Filler ${id}`, '--specs', 'G1', '--criterion', 'fills');
  box.run(p.repo, 'add', 'web', 'Retired widget', '--specs', 'G1', '--criterion', 'retires');
  box.run(p.repo, 'withdraw', '40', 'nobody needs the widget');
  box.run(p.web, 'shout', 'coordinator', "#1 is next; #2 shipped (#99 is not an item) and it's done");
  box.run(p.web, 'shout', 'coordinator', "#7, see#7 and #7#8: it's 5 o'clock");
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.equal(page.run('view.state'), 'active');
    assert.doesNotMatch(page.show('chain'), /Farewell banner/, 'Active hides the verified item');
    await page.type('q', 'farewell');
    assert.match(page.show('chain'), /Farewell banner/, 'a search finds the verified item');
    assert.match(page.show('state-chips'), /data-state="all" class="on"/, 'and says it looks in every state');
    assert.match(page.show('state-chips'), /Verified<b>1<\/b>/);
    assert.match(page.show('state-chips'), /Active<b>0<\/b>/, 'the chips count the matches');
    await page.type('q', '');
    assert.equal(page.run('view.state'), 'active', 'clearing the search brings the chip back');
    assert.doesNotMatch(page.show('chain'), /Farewell banner/);

    // Type, click Active with the query still there, then edit the query to the verified title.
    await page.type('q', 'filler');
    assert.equal(page.run('view.state'), 'all');
    await page.click({ state: 'active' });
    assert.equal(page.run('view.state'), 'active', 'a chip clicked mid-search narrows the list');
    await page.type('q', 'farewell banner');
    assert.equal(page.run('view.state'), 'all', 'typing again searches every state');
    assert.match(page.show('chain'), /Farewell banner/, 'and finds the verified item');
    await page.type('q', '');
    assert.equal(page.run('view.state'), 'active', 'emptying the box brings back the chip from before the search');
    assert.doesNotMatch(page.show('chain'), /Retired widget/, 'browsing leaves withdrawn items out');
    await page.type('q', 'retired widget');
    const found = itemRow(page.show('chain'), 40);
    assert.match(found, /Retired widget/, 'a search finds the withdrawn item too');
    assert.match(found, /<span class="chip ">withdrawn<\/span>/);
    assert.match(page.show('state-chips'), /All<b>1<\/b>/);
    assert.match(page.show('state-chips'), /Active<b>0<\/b>/, 'a withdrawn item is not active');
    await page.type('q', '');

    const feed = page.show('feed');
    assert.ok(feed.includes('<button class="ref" data-go="item:1" title="Greeting" type="button">#1</button> is next;'), feed);
    assert.ok(feed.includes('<button class="ref" data-go="item:2" title="Farewell banner" type="button">#2</button> shipped'));
    assert.ok(feed.includes('(#99 is not an item) and it&#39;s done'), 'no link for a missing item, and the apostrophe stays intact');
    const ref = (id, title) => `<button class="ref" data-go="item:${id}" title="${title}" type="button">#${id}</button>`;
    assert.ok(feed.includes(`${ref(7, 'Filler 7')}, see${ref(7, 'Filler 7')} and ${ref(7, 'Filler 7')}${ref(8, 'Filler 8')}: it&#39;s 5 o&#39;clock`), 'every #id links, whatever stands next to it');
    assert.equal(feed.match(/class="ref"/g).length, 6);
    await page.click({ go: 'item:2', classes: 'ref' });
    assert.equal(page.run('view.tab'), 'items', 'the link opens the Items tab');
    assert.match(page.show('detail'), /<h2><span>#2<\/span>Farewell banner<\/h2>/, 'on that item');
    assert.equal(page.element('detail').scrolled, 0, 'side by side, the detail is already in view');

    const narrow = await openPage(view, { width: 600 });
    await narrow.click({ item: '1', classes: 'row' });
    assert.match(narrow.show('detail'), /Greeting/);
    assert.equal(narrow.element('detail').scrolled, 1, 'under 900px, picking an item brings its detail into view');
    await narrow.click({ go: 'item:2', classes: 'ref' });
    assert.equal(narrow.element('detail').scrolled, 2, 'and so does a link to one');
  } finally {
    await view.stop();
  }
});

test('a decision waits in needs-you until the view answers it [B21, B26, N27]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.web, 'shout', 'coordinator', 'Greet in <b>French</b> first?', '--decision');
  // Forty shouts after it: the ask is older than every shout the feed loads, and still waits.
  for (let n = 0; n < 40; n += 1) box.run(alpha.web, 'shout', 'all', `note ${n}`);
  // Another project's board numbers its shouts from 1 too.
  const beta = project(box, 'beta');
  box.run(beta.web, 'shout', 'coordinator', 'Beta asks too?', '--decision');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    // The question as the page escapes it, written as a pattern.
    const question = 'Greet in &lt;b&gt;French&lt;/b&gt; first\\?';
    // An agent asks its coordinator (B25): the ask waits on the board with who holds it, never in Needs-you.
    assert.doesNotMatch(page.show('needs'), /decide:/, "an agent's ask is its coordinator's to answer");
    assert.equal(page.element('decisions').hidden, true, 'an ask waiting on others stays folded');
    assert.match(page.show('asks-slot'), /^<button class="asks-toggle" data-fold="waiting" type="button" aria-expanded="false" title="Asks between agents, waiting on others: web-1 asks coordinator">1 ask waiting <span aria-hidden="true">▾<\/span><\/button>$/, 'its toggle sits at the end of the composer line');
    page.run('view.open.waiting = true; render();');
    assert.match(page.show('decisions'), new RegExp(`^<article class="shout h\\d" data-shout-id="1"><span class="avatar" aria-hidden="true">W1</span><div class="shout-main"><header><b class="who">web-1</b><span class="to">→ coordinator</span><span class="mark ask">decision</span> <time class="long" data-ago="[^"]+" title="[^"]+">now</time></header><div class="text">${question}</div><button class="more" data-more type="button">more</button></div></article>$`), 'above the shouts as a card, saying who asked whom, with no Answer button');
    assert.doesNotMatch(page.show('feed'), /Greet in/, 'though the feed no longer reaches it');

    // The coordinator passes it up with its note (B27): now it is the person's call.
    box.run(alpha.repo, 'pass', '1', 'over to you');
    await page.run('refresh()');
    const passed = `Passed up from web-1: ${question}\nCoordinator note: over to you`;
    assert.match(page.show('needs'), new RegExp(`^<li class="row ask" data-go="decide:42"><span class="dot ask"></span><div><div class="t">${passed.replace('\n', '<br>')}</div><span class="row-age"><time data-ago="[^"]+">now</time></span><div class="meta"><span class="why"><b>NEEDS YOU</b> a decision, asked by coordinator</span></div></div><span class="chip warn">decide</span></li>`), "first in Needs-you: who passed it, what, and since when");
    assert.match(page.show('decisions'), new RegExp(`^<div class="head"><i></i>Decision needed</div><article class="shout h\\d lead" data-shout-id="42"><span class="avatar"><svg [\\s\\S]*?</svg></span><div class="shout-main"><header><b class="who">coordinator</b><span class="to">→ person</span><span class="mark ask">decision</span> <time class="long" data-ago="[^"]+" title="[^"]+">now</time></header><div class="text">${passed.replace('\n', '<br>')}</div><button class="more" data-more type="button">more</button><button class="ghost answer" data-go="decide:42" type="button">Answer</button></div></article>$`), 'and above the shouts as the coordinator\'s card, with an Answer button');

    const form = () => ({
      answering: !page.element('answering').hidden,
      who: page.element('answering-who').textContent,
      question: page.element('answering-q').textContent,
      to: page.element('shout-to').value,
      locked: Boolean(page.element('shout-to').disabled),
      button: page.element('shout-send').getAttribute('aria-label'),
    });
    page.element('shout-to').value = 'web';
    await page.click({ go: 'decide:42' });
    assert.equal(page.run('view.tab'), 'shouts');
    assert.deepEqual(form(), { answering: true, who: 'coordinator', question: 'Passed up from web-1: Greet in <b>French</b> first?\nCoordinator note: over to you', to: 'coordinator', locked: true, button: 'Answer' }, 'Answer turns the form to answering the one who asked');
    await page.fire('answer-cancel', 'click');
    assert.deepEqual(form(), { answering: false, who: '', question: '', to: 'web', locked: false, button: 'Shout' }, 'Cancel gives back the plain shout');

    await page.click({ go: 'decide:42' });
    page.element('shout-text').value = 'French, then English';
    await page.fire('shout-form', 'submit');
    assert.equal(page.element('console').textContent.split('\n')[0], '$ pullboard answer 42 French, then English --as person', 'the view answers as the person');
    assert.equal(page.element('console').className, 'console ok');
    const replies = JSON.parse(box.run(alpha.web, 'inbox', '--json')).shouts.filter((shout) => shout.shout_answers === 1);
    assert.deepEqual(replies.map((shout) => [shout.shout_from, shout.shout_to, shout.shout_answers, shout.shout_text]),
      [['person', 'web-1', 1, 'Person answered #42: French, then English']], 'the answer reaches the agent that asked');
    assert.deepEqual(form(), { answering: false, who: '', question: '', to: 'web', locked: false, button: 'Shout' }, 'the form is a plain shout again');
    assert.equal(page.element('shout-text').value, '');
    assert.doesNotMatch(page.show('needs'), /decide:/, 'an answered decision leaves Needs-you');
    assert.equal(page.element('decisions').hidden, true, 'and the banner');

    box.run(alpha.web, 'shout', 'coordinator', 'Ship today?', '--decision');
    box.run(alpha.repo, 'pass', '45', 'yours');
    await page.run('refresh()');
    const feed = page.show('feed');
    assert.match(feed, /<b class="who">web-1<\/b><span class="to">→ coordinator<\/span><span class="mark ask">decision<\/span> <time [^>]*>[^<]*<\/time><\/header><div class="text">Ship today\?<\/div>/, 'the feed marks an ask');
    assert.match(feed, /<b class="who">person<\/b><span class="to">→ coordinator<\/span><span class="mark">answer<\/span> <time [^>]*>[^<]*<\/time><\/header><div class="text">French, then English<\/div>/, 'and an answer');
    assert.match(page.show('needs'), /data-go="decide:46"/);

    // An answer belongs to the project whose question it shows.
    box.run(beta.repo, 'pass', '1', 'yours too');
    const plain = { answering: false, who: '', question: '', to: 'web', locked: false, button: 'Shout' };
    await page.click({ go: 'decide:46' });
    // The new project's board is held back, so this is the form the moment the switch is made.
    page.run('globalThis.plain = fetch; globalThis.fetch = (path, init) => new Promise((done) => { globalThis.resume = done; }).then(() => plain(path, init));');
    await page.click({ root: beta.repo });
    assert.deepEqual(form(), plain, 'leaving the project leaves answer mode at once');
    page.run('globalThis.fetch = plain; resume();');
    await page.run('refresh()');
    await page.click({ go: 'decide:2' });
    assert.equal(form().question, 'Passed up from web-1: Beta asks too?\nCoordinator note: yours too');
    await page.run(`view.root = ${JSON.stringify(alpha.repo)}; seen = ''; refresh()`);
    assert.deepEqual(form(), plain, 'and so does a board drawn for another project');
    await page.run(`view.root = ${JSON.stringify(beta.repo)}; seen = ''; refresh()`);
    await page.click({ go: 'decide:2' });
    page.run(`view.root = ${JSON.stringify(alpha.repo)}`);
    page.element('shout-text').value = 'yes';
    await page.fire('shout-form', 'submit');
    assert.deepEqual(form(), plain, 'an answer is never sent to another project');
    assert.equal(page.element('console').textContent.split('\n')[0], '$ pullboard answer 42 French, then English --as person', 'nothing ran');
    /** Read the still-open decision by stable identity, independently of display-name formatting. */
    const waiting = (repo, id) => JSON.parse(box.run(repo, 'decisions', '--as', 'person', '--json')).decisions
      .filter((shout) => shout.shout_id === id).map((shout) => [shout.shout_from, shout.shout_to, shout.shout_text]);
    assert.deepEqual(waiting(beta.repo, 2), [['coordinator', 'person', 'Passed up from web-1: Beta asks too?\nCoordinator note: yours too']], "beta's ask still waits");
    assert.deepEqual(waiting(alpha.repo, 46), [['coordinator', 'person', 'Passed up from web-1: Ship today?\nCoordinator note: yours']], "and so does alpha's");
  } finally {
    await view.stop();
  }
});
test("needs-you holds only the person's calls; the rest show on the board with who holds them [B26, N26]", async () => {
  const box = machine();
  const alpha = project(box, 'alpha', `${SPEC}- G3 [pending] Greet in French? | gate: review\n- G4 [draft, aim] A footer on every page. | gate: review\n`);
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  build(box, alpha, 1, 'greeting.html');
  build(box, alpha, 2, 'farewell.html');
  sendBack(box, alpha, 2, 'no farewell yet');
  box.run(alpha.web, 'shout', 'coordinator', 'Which colour for the button?', '--decision');
  box.run(alpha.repo, 'shout', 'person', 'Launch on Friday?', '--decision');
  box.run(alpha.repo, 'hold', 'web', '--reason', 'G3 is open');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const needs = page.show('needs');
    assert.deepEqual(needEntries(needs).map(([go, ref, words]) => [go.split(':')[0], ref, words]), [
      ['decide', null, 'Launch on Friday?'],
      ['spec', 'G3', 'Greet in French?'],
      ['tab', 'web', 'G3 is open'],
      ['tab', '1', 'draft spec rows to approve or drop'],
    ], "the person's calls, and only those: the decision asked of them, the spec's question, the held lane, the draft row");
    assert.equal(needEntries(needs)[0][3], 'a decision, asked by coordinator', 'a decision says below who asked it');
    assert.doesNotMatch(needs, /Which colour|Greeting|Farewell/, "an agent's ask, work waiting for a verdict and work sent back are not the person's");
    assert.match(needs, /<li class="row ask" data-go="tab:shouts"><span class="dot ask"><\/span><div><div class="t"><span>web<\/span>G3 is open<\/div><span class="row-age"><time data-ago="[^"]+">(?:now|\d+[mhd])<\/time><\/span><div class="meta"><span class="why"><b>NEEDS YOU<\/b> lane held by coordinator<\/span><\/div><\/div><span class="chip warn">release<\/span><\/li>/, 'a held lane says who set it and shows the API-provided hold age');

    // Each of the rest is on the board, with who holds it.
    page.run('view.open.waiting = true; render();');
    assert.match(page.show('decisions'), /<article class="shout h\d" data-shout-id="\d+"><span class="avatar" aria-hidden="true">W1<\/span><div class="shout-main"><header><b class="who">web-1<\/b><span class="to">→ coordinator<\/span>/, "the agent's ask waits on its coordinator");
    assert.match(itemRow(page.show('chain'), 1), /<span class="chip [^"]*">to verify<\/span><\/li>$/, 'work waiting for a verdict');
    assert.ok(itemRow(page.show('chain'), 2).includes('<b>BEHAVIOR_MISMATCH</b> no farewell yet'), 'and work sent back, with why');
    page.run("view.agent = 'web-1'; render();");
    assert.deepEqual(agentEntries(page.show('agents')).find((agent) => agent.id === 'web-1').holds, ['#2 Farewell: sent back', '#1 Greeting: to verify'], 'the agent that built them holds both');
    page.run('view.agent = null; render();');
    assert.match(page.show('lanes'), /<b>web<\/b> <span class="chip no">held by coordinator<\/span> <span class="muted">G3 is open<\/span>/, 'a held lane names who holds it');

    // The sidebar counts exactly the person's calls; its line still says what the agents are doing.
    assert.deepEqual(projectRows(page.show('proj-list')).map((row) => [row.needs, row.line]), [['4', '1 decision · 1 question · 1 draft row · 1 lane held · 1 sent back · 1 to verify']]);
    assert.equal(page.run('document.title'), '(4) alpha · Pullboard');
  } finally {
    await view.stop();
  }
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

test('the shouts tab counts shouts you have not seen [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'shout', 'web', 'first');
  box.run(alpha.repo, 'shout', 'web', 'second');
  const beta = project(box, 'beta');
  box.run(beta.repo, 'shout', 'web', 'beta has its own');
  const view = await startView(box);
  try {
    const store = storage();
    const count = (page) => { const unread = page.element('status-unread'); return unread.hidden ? '' : /<b>(\d+)<\/b> unread/.exec(unread.innerHTML)?.[1] ?? unread.innerHTML; };
    const page = await openPage(view, { store });
    assert.equal(count(page), '', 'the shouts there before the first look count as seen, not as 2');

    box.run(alpha.web, 'shout', 'coordinator', 'web-1 is on it');
    await page.run('refresh()');
    assert.equal(count(page), '1', 'a shout since then counts');
    await page.click({ tab: 'shouts' });
    assert.equal(count(page), '', 'opening Shouts sees it');
    box.run(alpha.web, 'shout', 'coordinator', 'and done');
    await page.run('refresh()');
    assert.equal(count(page), '', 'a shout that arrives while Shouts is open is seen');
    await page.click({ tab: 'items' });

    // A shout lands while the page is closed: the reload counts it, and only it.
    box.run(alpha.web, 'shout', 'coordinator', 'while you were away');
    const reloaded = await openPage(view, { store });
    assert.equal(count(reloaded), '1', 'what was seen is remembered across a reload');
    await reloaded.click({ tab: 'shouts' });
    assert.equal(count(reloaded), '');

    // A burst larger than the forty shouts the page loads still counts in full, after a reload too.
    await reloaded.click({ tab: 'items' });
    for (let n = 1; n <= 41; n += 1) box.run(alpha.web, 'shout', 'coordinator', `burst ${n}`);
    await reloaded.run('refresh()');
    assert.equal(count(reloaded), '41', 'every arrival counts, not just the forty loaded');
    const again = await openPage(view, { store });
    assert.equal(count(again), '41');

    // Each project keeps its own mark: a first look at beta sees its shouts, and alpha still counts.
    await again.click({ root: beta.repo, classes: 'proj side' });
    assert.equal(count(again), '');
    await again.click({ root: alpha.repo, classes: 'proj side' });
    assert.equal(count(again), '41');

    // A switch to beta that is slow to arrive: tabs clicked meanwhile must not mark alpha's shouts as
    // beta's, or beta's next shout would never count.
    const racing = await openPage(view, { store });
    const betaId = await boardId(view, beta.repo);
    racing.run(`const plain = fetch; globalThis.fetch = (path, init) => path.includes(${JSON.stringify('/api/v1/boards/' + betaId + '/state')}) ? new Promise((done) => setTimeout(done, 300)).then(() => plain(path, init)) : plain(path, init);`);
    racing.run(`switchTo(${JSON.stringify(beta.repo)})`);
    await racing.click({ tab: 'shouts' });
    await racing.click({ tab: 'items' });
    await new Promise((done) => setTimeout(done, 600));
    await racing.run('refresh()');
    assert.equal(racing.element('proj-name').textContent, 'beta');
    box.run(beta.repo, 'shout', 'web', 'beta moves on');
    await racing.run('refresh()');
    assert.equal(count(racing), '1', 'the shout that came after counts');
  } finally {
    await view.stop();
  }
});
test('the detail opens on the top item, not a blank form [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  // Beta's first row is #3, while its #1 and #2 share ids with alpha's first row and pick.
  const beta = project(box, 'beta');
  for (const title of ['Beta one', 'Beta two', 'Beta three']) box.run(beta.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  const empty = project(box, 'empty');
  const done = project(box, 'done');
  box.run(done.repo, 'add', 'web', 'Shipped page', '--specs', 'G1', '--criterion', 'renders');
  build(box, done, 1, 'shipped.html');
  accept(box, done, 1);
  const gone = project(box, 'gone');
  box.run(gone.repo, 'add', 'web', 'Dropped page', '--specs', 'G1', '--criterion', 'renders');
  box.run(gone.repo, 'withdraw', '1', 'nobody needs it');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const shown = () => /<h2><span>#(\d+)<\/span>([^<]*)</.exec(page.show('detail'))?.slice(1).join(' ');
    const rows = () => [...page.show('chain').matchAll(/<li class="row s-[a-z]+( on)?[^"]*" data-item="(\d+)"/g)].map((match) => match[2] + (match[1] ? '*' : ''));
    const form = () => [page.element('add-form').hidden, page.element('detail').hidden];

    assert.equal(shown(), '2 Farewell', 'the first row, the item updated last');
    assert.deepEqual(rows(), ['2*', '1'], 'its row is marked');
    assert.deepEqual(form(), [true, false], 'no blank form');

    box.run(alpha.web, 'claim', '1');
    page.element('shout-to').value = 'web';
    page.element('shout-text').value = 'Greeting is claimed';
    await page.fire('shout-form', 'submit');
    assert.deepEqual(rows(), ['1', '2*'], 'the refresh put the claimed item first');
    assert.equal(shown(), '2 Farewell', 'and the pick held');

    await page.fire('new-item', 'click');
    assert.deepEqual(form(), [false, true], 'New item opens the form');
    assert.equal(page.element('add-cancel').hidden, false);
    await page.fire('add-cancel', 'click');
    assert.deepEqual(form(), [true, false], 'Cancel closes it');
    assert.equal(shown(), '2 Farewell', 'and brings back the item it covered');

    await page.click({ root: beta.repo, classes: 'proj side' });
    assert.equal(shown(), '3 Beta three', "the new project's first row, not an id from alpha");
    assert.deepEqual(rows(), ['3*', '2', '1']);

    await page.click({ root: empty.repo, classes: 'proj side' });
    assert.deepEqual(form(), [false, true], 'a project with no items opens on the form');
    assert.equal(page.element('add-cancel').hidden, true, 'with nothing to go back to');

    await page.click({ root: done.repo, classes: 'proj side' });
    assert.deepEqual(rows(), [], 'Active shows nothing: the only item is verified');
    assert.deepEqual(form(), [true, false]);
    assert.match(page.show('detail'), /Pick an item to see its criterion, verdicts and history\./);

    await page.click({ root: gone.repo, classes: 'proj side' });
    assert.deepEqual(rows(), [], 'no chip lists the only item: it is withdrawn');
    assert.deepEqual(form(), [true, false], 'but an item exists, so no form');
    assert.match(page.show('detail'), /Pick an item to see its criterion, verdicts and history\./);
  } finally {
    await view.stop();
  }
});

test('a new item from the view can carry a brief [N27]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const add = async (fields) => {
      await page.fire('new-item', 'click');
      for (const [id, value] of Object.entries(fields)) page.element(id).value = value;
      await page.fire('add-form', 'submit');
      return page.element('console').textContent;
    };
    const stored = (id) => JSON.parse(box.run(alpha.repo, 'show', String(id), '--json')).item_brief;

    const brief = 'Files: web/greeting.html\nTest: the page says hello';
    const ran = await add({ 'add-lane': 'web', 'add-title': 'Greeting', 'add-specs': 'G1', 'add-brief': brief });
    assert.ok(ran.startsWith(`$ pullboard add web Greeting --specs G1 --brief ${brief}\n`), ran);
    assert.equal(stored(1), brief, 'the brief reaches the board as written, its line break kept');
    assert.equal(page.element('add-brief').value, '', 'a successful add clears it');

    const plain = await add({ 'add-lane': 'web', 'add-title': 'Farewell', 'add-specs': 'G2', 'add-brief': '  ' });
    assert.ok(plain.startsWith('$ pullboard add web Farewell --specs G2\n'), plain);
    assert.ok(!stored(2), 'left empty, the item gets no brief');
    assert.match(page.html, /<label>Brief<textarea id="add-brief"/, 'the field is in the form, not built by the script');
  } finally {
    await view.stop();
  }
});
test('a machine with no board says how to start one [N26]', async () => {
  const box = machine();
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const style = await styleOf(view);
    // Agents start boards, so the view offers no form for it.
    assert.doesNotMatch(page.html, /init-form|init-path|Start a board|<details/, 'no form to start a board');
    assert.doesNotMatch(style, /\.start\b/);

    const classes = (on) => ['loading', 'boardless'].filter((name) => on.run(`document.body.classList.contains('${name}')`));
    assert.deepEqual(classes(page), ['boardless'], 'with no board, the board steps aside');
    assert.match(style, /\n\.first \{ display: none;[^}]*\}\n(?:\.first [^\n]*\n)*\.boardless \.first \{ display: block; \}\n\.loading \.top, \.loading \[data-pane\], \.boardless \.top, \.boardless \[data-pane\] \{ display: none; \}\n/, 'its bar of tabs and its panes hide, and the message shows');

    // Until the first board arrives the page shows none of a board, so a slow start flashes nothing.
    assert.match(page.html, /\n<body class="loading">\n/, 'the page starts loading');
    const early = await openPage(view, { hold: true });
    assert.deepEqual(classes(early), ['loading'], 'and stays so while the first answer is on its way');
    await early.release();
    assert.deepEqual(classes(early), ['boardless'], 'then the message takes the place of the board');
    assert.match(page.html, /<main>\n {2}<section class="card-panel first">\n {4}<h2>No boards yet<\/h2>\n {4}<p>Run <code>pullboard init<\/code> in a git repo, or ask an agent to\. Its board shows up here by itself\.<\/p>\n {2}<\/section>\n/, 'the message says how a board starts');
    assert.equal(page.show('proj-list'), '<div class="empty">None yet.</div>');
    assert.equal(page.element('products').hidden, true);

    // A board started meanwhile shows up on the next refresh, with no reload.
    project(box, 'alpha');
    await page.run('refresh()');
    assert.equal(page.run("document.body.classList.contains('boardless')"), false, 'a board shows its tabs and panes');
    assert.equal(page.element('proj-name').textContent, 'alpha');
    assert.deepEqual(projectRows(page.show('proj-list')).map((row) => [row.name, row.current]), [['alpha', true]]);

    // A view that cannot be reached says so in the bar it shows, rather than show nothing at all.
    const lost = await openPage(view, { hold: true });
    await view.stop();
    await lost.release();
    assert.deepEqual(classes(lost), []);
    assert.match(lost.element('live').textContent, /^cannot reach the view: /);
  } finally {
    await view.stop();
  }
});
test('a fresh board files new work where it can be built [N26, N27]', async () => {
  const box = machine();
  // A repo set up by init alone: its only lane is review, which owns no folders, and it has no rows.
  const fresh = join(box.dir, 'fresh');
  mkdirSync(fresh);
  box.git(fresh, 'init', '-q', '-b', 'main');
  box.run(fresh, 'init');
  const beta = project(box, 'beta', SPEC, { lanes: { web: { owns: ['web/'], specs: ['G'] }, review: { owns: [] } } });
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.equal(page.element('proj-name').textContent, 'fresh');
    assert.equal(page.show('add-lane'), '<option>coordinator</option><option>review</option>', 'with no lane that owns folders, new work goes to the coordinator, not to the verifiers');
    assert.equal(page.element('add-specs').placeholder, 'none yet', 'and its hint names no rows the board lacks');
    assert.equal(page.show('spec-list'), '<div class="empty">No spec rows yet. Each requirement is one row in SPEC.md, such as G1 [draft, must] and a line; write them, or ask an agent to, and they show up here.</div>', 'the Spec tab says where rows come from');

    await page.click({ root: beta.repo });
    assert.equal(page.show('add-lane'), '<option>web</option><option>coordinator</option><option>review</option>', 'a lane that owns folders comes first, review last');
    assert.equal(page.element('add-specs').placeholder, 'G1,G2');
    assert.equal(page.show('spec-list'), '<div class="empty">No rows match.</div>', 'rows a filter hides are not missing');
  } finally {
    await view.stop();
  }
});
test('the view runs no init [N27]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  const other = join(box.dir, 'other');
  mkdirSync(other);
  box.git(other, 'init', '-q', '-b', 'main');
  const view = await startView(box);
  try {
    const act = async ({ root = alpha.repo, command, args }) => {
      const id = await boardId(view, root);
      const body = command === 'release' ? { verb: 'hold', args: { lane: args.lane, off: true } } : { verb: command, args };
      const res = await fetchLive(`${view.base}/api/v1/boards/${id}/moves`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pullboard-key': view.key }, body: JSON.stringify(body) });
      return { status: res.status, ...(await res.json()) };
    };
    for (const root of [undefined, alpha.repo]) {
      const refused = await act({ root, command: 'init', args: { path: other } });
      assert.equal(refused.status, 400, 'agents start boards, not the view');
      assert.equal(refused.version, 1);
      assert.equal(refused.error.code, 'BAD_REQUEST');
    }
    assert.deepEqual(readdirSync(other), ['.git'], 'and nothing is set up at the path');
    for (const command of ['add', 'shout', 'hold', 'release']) {
      const args = { lane: 'web', title: 'x', to: 'all', text: 'x', reason: 'x' };
      const refused = await act({ root: other, command, args });
      assert.equal(refused.status, 404, `${command} runs only inside a registered board`);
      assert.equal(refused.error.code, 'NO_BOARD');
    }
    const state = await (await fetchLive(`${view.base}/api/v1/boards`, { headers: { 'x-pullboard-key': view.key } })).json();
    assert.deepEqual(state.boards.map((entry) => entry.name), ['alpha'], 'the machine has no new board');
    const shout = await act({ root: alpha.repo, command: 'shout', args: { to: 'all', text: 'still here' } });
    assert.equal(shout.status, 200);
    assert.equal(shout.version, 1);
    assert.equal(shout.event.event_kind, 'shout');
    assert.equal(shout.result.id, (await boardOf(view, alpha.repo)).shouts.find((entry) => entry.shout_text === 'still here').shout_id, 'the action it keeps reaches the real board');
  } finally {
    await view.stop();
  }
});
test('times say which day they were [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  box.run(alpha.repo, 'shout', 'web', '#1 is in');
  const view = await startView(box);
  try {
    const days = (html) => [...html.matchAll(/<h4 class="day">([^<]*)<\/h4>|<div class="day-rule" role="separator"><span>([^<]*)<\/span><\/div>/g)].map((match) => match[1] ?? match[2]);
    // A shout says how long ago it was, with its clock time on hover.
    const ages = (html) => [...html.matchAll(/<time class="long" data-ago="[^"]+" title="([^"]*)">([^<]*)<\/time>/g)].map((match) => [match[2], match[1]]);
    const times = (html) => [...html.matchAll(/<time>([^<]*)<\/time>/g)].map((match) => match[1]);
    const bare = (list) => list.length > 0 && list.every((time) => /^\d\d:\d\d$/.test(time));

    const now = await openPage(view);
    assert.deepEqual([days(now.show('feed')), days(now.show('activity'))], [[], ['Today']], 'shouts from today need no rule above them');
    assert.deepEqual(ages(now.show('feed')).map(([age, clock]) => [age, /^\d\d:\d\d$/.test(clock)]), [['now', true]], 'a shout from today says now, its clock time on hover');
    assert.ok(bare(times(now.show('detail'))), 'a history from today shows bare times');

    const tomorrow = await openPage(view, { later: 1 });
    assert.deepEqual([days(tomorrow.show('feed')), days(tomorrow.show('activity'))], [['Yesterday'], ['Yesterday']]);

    const weekday = new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const date = new Date().toLocaleDateString([], { month: 'short', day: 'numeric' });
    const later = await openPage(view, { later: 2 });
    assert.deepEqual([days(later.show('feed')), days(later.show('activity'))], [[weekday], [weekday]], 'two days on, the feeds name the day');
    assert.ok(bare(times(later.show('activity'))), 'activity rows keep the clock time');
    assert.deepEqual(ages(later.show('feed')).map(([age, clock]) => [age, new RegExp(`^${date} \\d\\d:\\d\\d$`).test(clock)]), [['2d ago', true]], 'a shout says how long ago, with its date and time on hover');
    const history = times(later.show('detail'));
    assert.ok(history.length === 3 && history.every((time) => new RegExp(`^${date} \\d\\d:\\d\\d$`).test(time)), `the history dates each move: ${history}`);

    // A heading wherever the day changes, and only there.
    const at = (day, hour) => new Date(2026, 9, day, hour).toISOString();
    const rows = JSON.stringify([at(6, 15), at(6, 9), at(5, 20), at(3, 12)].map((iso) => ({ iso })));
    const html = now.run(`byDay(${rows}, (x) => x.iso, () => '<div></div>')`);
    assert.equal(html.replace(/<h4 class="day">[^<]*<\/h4>/g, 'H').replaceAll('<div></div>', 'r'), 'HrrHrHr');
    // Shouts get a rule only where the day changes, and none above today's.
    const rule = (list) => now.run(`dayRules(${JSON.stringify(list.map((iso) => ({ iso })))}, (x) => x.iso, () => '<div></div>')`).replace(/<div class="day-rule" role="separator"><span>[^<]*<\/span><\/div>/g, 'H').replaceAll('<div></div>', 'r');
    assert.equal(rule([at(6, 15), at(6, 9), at(5, 20), at(3, 12)]), 'HrrHrHr', 'an older first day still gets its rule');
    assert.equal(rule([new Date().toISOString(), at(6, 9)]), 'rHr', 'today has no rule; the first earlier day does');
  } finally {
    await view.stop();
  }
});

test('the doctrine view carries and labels inherited, local, overridden and declined rules [D3,N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha', SPEC, { practice: 'ways.md' });
  writeFileSync(join(alpha.repo, 'ways.md'), '# Local rules\n\n## Team\n- R1 [approved, must] Keep <b>local</b> evidence. | gate: review\n- PB2 [approved, must] Deletion needs <i>two</i> approvals. | gate: review\n- PB8 [wont] No <script>persistent</script> data is stored.\n');
  const view = await startView(box);
  try {
    const page = await openPage(view, { width: 375 });
    const state = JSON.parse(page.run('JSON.stringify(data.project)'));
    const merged = loadDoctrine(alpha.repo, { practice: 'ways.md' });
    /** Compare the merged reader's row fields without the view's extra display text. */
    const fields = ({ id, status, tier, text, gate, serves, section, origin, version, reason }) => ({ id, status, tier, text, gate, serves, section, origin, version, reason });
    assert.deepEqual(state.practice.map(fields), merged.rows.map(fields), 'state carries the exported merged doctrine, including every source and reason');
    assert.equal(state.practice.length, 13, 'twelve standard ids with two replaced, plus one local id');
    assert.equal(state.practice.filter((row) => row.id === 'PB2').length, 1);
    assert.equal(state.practice.filter((row) => row.id === 'PB8').length, 1);
    assert.equal(state.practice.find((row) => row.id === 'PB8').standardText, 'No secrets or sensitive info in the repo; test data is synthetic.');
    await page.click({ tab: 'doctrine' });
    const list = page.show('doctrine-list');
    // A section says once where its rules come from; a row says so only where it differs from its section.
    const sections = list.split('<div class="spec-section-head">').slice(1).map((chunk) => ({
      source: /<small class="section-source" title="[^"]+">([^<]*)<\/small>/.exec(chunk)?.[1] ?? null,
      rows: chunk.split('<div class="srow').slice(1).map((row) => [/data-row="doctrine:([^"]+)"/.exec(row)[1], /<small class="rule-source" title="[^"]+">([^<]*)<\/small>/.exec(row)?.[1] ?? null]),
    }));
    const where = (id) => { const section = sections.find((s) => s.rows.some(([row]) => row === id)); return [section?.source ?? null, section?.rows.find(([row]) => row === id)[1] ?? null]; };
    assert.deepEqual(where('PB1'), ['From Pullboard', null], `a section of Pullboard's rules says so once, in its header: ${JSON.stringify(sections)}`);
    assert.deepEqual(where('R1'), ['This repo', null], `a rule this repo wrote sits under a header that says so: ${JSON.stringify(sections)}`);
    assert.match(list, /data-row="doctrine:R1"[^]*?Keep &lt;b&gt;local&lt;\/b&gt; evidence\./);
    assert.ok(['This repo,', ',This repo'].includes(where('PB2').join()), `the rule this repo changed says This repo, by its section or by itself: ${JSON.stringify(where('PB2'))}`);
    assert.match(list, /data-row="doctrine:PB2"[^]*?Deletion needs &lt;i&gt;two&lt;\/i&gt; approvals\./);
    assert.doesNotMatch(list, /Destructive or irreversible actions wait/);
    assert.match(list, /data-row="doctrine:PB8"[^]*?<s>No secrets or sensitive info in the repo; test data is synthetic\.<\/s><small class="rule-reason">Reason: No &lt;script&gt;persistent&lt;\/script&gt; data is stored\.<\/small>/);
    assert.doesNotMatch(list, /<script>|<i>two<\/i>|<b>local<\/b>/, 'all repo text stays text');
    const style = await styleOf(view);
    assert.match(style, /\.rule-source, \.rule-reason \{ display: block; color: var\(--ink-muted\);/, 'labels and reasons remain separate readable lines');

    await page.click({ row: 'doctrine:PB1' });
    assert.match(page.show('doctrine-detail'), /<span class="chip" title="Pullboard standard rules, version \d+">From Pullboard<\/span>/);
    await page.click({ row: 'doctrine:PB2' });
    assert.match(page.show('doctrine-detail'), /<span class="chip" title="Written in this repo">This repo<\/span>/);
    assert.match(page.show('doctrine-detail'), /Deletion needs &lt;i&gt;two&lt;\/i&gt; approvals\./);
    await page.click({ row: 'doctrine:PB8' });
    assert.match(page.show('doctrine-detail'), /<s>No secrets or sensitive info in the repo; test data is synthetic\.<\/s>/);
    assert.match(page.show('doctrine-detail'), /<dt>reason<\/dt><dd>No &lt;script&gt;persistent&lt;\/script&gt; data is stored\.<\/dd>/);

    writeFileSync(join(alpha.repo, 'ways.md'), '# Local rules\n\n## Team\n- R1 [approved, must] Keep newer evidence. | gate: review\n');
    await page.run('seen = ""; refresh()');
    assert.match(page.show('doctrine-list'), /Destructive or irreversible actions wait/);
    assert.doesNotMatch(page.show('doctrine-list'), /Deletion needs|rule-reason|<s>/, 'removing repo overrides restores the inherited rules');
  } finally {
    await view.stop();
  }
});

test('the doctrine pane names DOCTRINE.md and its rules doctrine [D1,N26]', async () => {
  const box = machine();
  const alpha = project(box, 'doctrine-name', SPEC, { practice: 'DOCTRINE.md' });
  writeFileSync(join(alpha.repo, 'DOCTRINE.md'), '# Team\n\n## Team\n- R1 [approved, must] Keep evidence. | gate: review\n');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'doctrine' });
    const rows = JSON.parse(page.run('JSON.stringify(data.project.practice)'));
    page.run("data.project.practice = []; view.rows.doctrine = 'all'; render()");
    const empty = page.show('doctrine-list');
    assert.match(empty, /No doctrine rows yet: they live in DOCTRINE\.md\./);
    assert.doesNotMatch(empty, /PRACTICE\.md/);

    page.run('data.project.practice = ' + JSON.stringify(rows) + '; render()');
    await page.click({ row: 'doctrine:PB1' });
    const detail = page.show('doctrine-detail');
    assert.match(detail, /override or decline one in DOCTRINE\.md\./);
    assert.doesNotMatch(detail, /PRACTICE\.md/);
    await page.click({ row: 'doctrine:R1' });
    const localDetail = page.show('doctrine-detail');
    assert.match(localDetail, /Rows change in DOCTRINE\.md/);
    assert.doesNotMatch(localDetail, /PRACTICE\.md/);
  } finally {
    await view.stop();
  }
});

test('spec rows read across a phone [N26,D1]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha', SPEC, { practice: 'DOCTRINE.md' });
  // Its own house rules follow the doctrine file named by this repo's config.
  writeFileSync(join(alpha.repo, loadConfig(alpha.repo).practice), '# Practice\n\n## W · Writing\n- W1 [approved, must] Numbers over adjectives. No hedges, no filler. | gate: review\n- W2 [draft, aim] One record per decision. | gate: review\n');
  const view = await startView(box);
  try {
    const page = await openPage(view, { width: 375 });
    const doctrineRows = page.show('doctrine-list');
    assert.match(doctrineRows, /data-row="doctrine:W1"[^]*?Numbers over adjectives\./, 'W1 from the configured doctrine is shown');
    assert.match(doctrineRows, /data-row="doctrine:W2"[^]*?One record per decision\./, 'W2 from the configured doctrine is shown');
    const style = await styleOf(view);
    assert.match(style, /\n\.srow \{ display: grid; grid-template-columns: 3\.4em minmax\(0, 1fr\);/, 'a row is its id in a slim gutter and its text at full width, with no decision in it');
    const phone = /\n@media ([^{]+) \{ \.srow \{ grid-template-columns: 3em minmax\(0, 1fr\); gap: 8px; \} \}/.exec(style);
    assert.ok(phone, 'on a phone the gutter narrows and the text keeps the rest');
    assert.equal(phone[1], '(width < 480px)', 'under 480px only');

    // The rule holds because every row is the id, then its words, a chip first only where its status is not the filter's.
    await page.click({ rows: 'spec:all' });
    const rows = (html) => html.split('<div class="srow').slice(1);
    const shape = /^[^>]*><code>[^<]+<\/code><span class="srow-text">(?:<span class="chip[^"]*">[^<]+<\/span>)?[^<]+<\/span><\/div>/;
    assert.deepEqual(rows(page.show('spec-list')).map((row) => /data-row="spec:([^"]+)"/.exec(row)[1]), ['G1', 'G2']);
    for (const row of rows(page.show('spec-list'))) assert.match(row, shape);
    const doctrineShape = /^[^>]*><code>[^<]+<\/code><span class="srow-text">(?:<span class="chip[^"]*">[^<]+<\/span>)?(?:<small class="rule-source" title="[^"]+">(?:From Pullboard|This repo)<\/small>)?[^<]+<\/span><\/div>/;
    for (const row of rows(page.show('doctrine-list'))) assert.match(row, doctrineShape, "a rule is its id and its words, its source only where it differs from its section's, in the same two columns");
    assert.ok(rows(page.show('doctrine-list')).length > 0, 'doctrine rows are drawn the same way');
  } finally {
    await view.stop();
  }
});

test("a shout's code reference opens that code as it was at that commit [B23]", async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  const beta = project(box, 'beta');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  const first = box.git(alpha.web, 'rev-parse', 'HEAD');
  writeFileSync(join(alpha.web, 'web', 'greeting.html'), '  hello <b>there</b>\n    second line\n');
  writeFileSync(join(alpha.web, 'web', 'long.txt'), Array.from({ length: 100 }, (_, n) => `line ${n + 1}`).join('\n') + '\n');
  // A path with a space ends in another file's path: text that may name it must not open the other.
  writeFileSync(join(alpha.web, 'web', 'note.txt'), 'plain note\n');
  mkdirSync(join(alpha.web, 'web', 'my web'));
  writeFileSync(join(alpha.web, 'web', 'my web', 'note.txt'), 'spaced note\n');
  mkdirSync(join(alpha.web, 'web', 'one two three four five web'));
  writeFileSync(join(alpha.web, 'web', 'one two three four five web', 'note.txt'), 'longer spaced note\n');
  box.git(alpha.web, 'add', '-A');
  box.git(alpha.web, 'commit', '-q', '-m', 'feat(web): a warmer greeting [G1]');
  const second = box.git(alpha.web, 'rev-parse', 'HEAD');
  const was = `web/greeting.html:1@${first.slice(0, 7)}`;
  const now = `web/greeting.html:1-2@${second.slice(0, 12)}`;
  const long = `web/long.txt:1-100@${second}`;
  const first_ = `#1 was ${was}, is ${now}; see ${long}.`;
  box.run(alpha.web, 'shout', 'all', first_);
  box.run(alpha.web, 'fact', '1', 'note', 'review the committed greeting', '--ref', `web/greeting.html:1-2@${second}`);
  box.run(alpha.web, 'shout', 'all', 'missing commit: web/greeting.html:1@');
  box.run(alpha.web, 'shout', 'all', `missing path: :1@${second.slice(0, 7)}`);
  const spaced = `web/note.txt:1@${second.slice(0, 7)}`;
  const odd = `absolute /${was} and spaced web/my ${spaced}`;
  box.run(alpha.web, 'shout', 'all', odd);
  box.run(alpha.web, 'shout', 'all', `plus x+${spaced}`);
  box.run(alpha.web, 'shout', 'all', spaced);
  box.run(alpha.web, 'shout', 'all', `web/one two three four five ${spaced}`);
  // A file only the working tree has, which no commit holds.
  writeFileSync(join(alpha.repo, 'draft.txt'), 'not committed\n');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    // A button carries the text written before it on its line.
    // Its label: the path, then the lines and the commit's first ten characters; the whole reference on hover.
    const label = (ref) => `<span class="ref-path">${ref.slice(0, ref.indexOf(':'))}</span><span class="ref-at">${ref.slice(ref.indexOf(':'), ref.lastIndexOf('@'))}<span class="ref-sha">${ref.slice(ref.lastIndexOf('@'), ref.lastIndexOf('@') + 11)}</span></span>`;
    const button = (ref, open, before = '', block = false) => `<button class="ref${block ? ' block' : ''}" data-code="${ref}"${before ? ` data-before="${before}"` : ''} title="${ref}" aria-label="Open code reference ${ref}" type="button" aria-expanded="${open}">${label(ref)}</button>`;
    const prior = (text, ref) => text.slice(0, text.indexOf(ref));
    const [b1, b2, b3] = [was, now, long].map((ref) => prior(first_, ref));
    assert.ok(page.show('feed').includes(`#1</button> was ${button(was, false, b1)}, is ${button(now, false, b2)}; see ${button(long, false, b3)}.`), 'each reference is a button in the text');

    await page.click({ code: was, before: b1 });
    await page.click({ code: now, before: b2 });
    let feed = page.show('feed');
    assert.ok(feed.includes(button(was, true, b1) + '<div class="code-ref open">' + button(was, true, b1, true) + '<div class="code-wrap"><pre class="code"><span><i>1</i>greeting.html</span></pre></div>'), 'the code as it was at that commit');
    assert.ok(feed.includes(button(now, true, b2) + '<div class="code-ref open">' + button(now, true, b2, true) + '<div class="code-wrap"><pre class="code"><span><i>1</i>  hello &lt;b&gt;there&lt;/b&gt;</span><span><i>2</i>    second line</span></pre></div>'), 'escaped, every indent kept');

    await page.click({ code: long, before: b3 });
    feed = page.show('feed');
    const shown = feed.slice(feed.indexOf(button(long, true, b3)));
    assert.equal([...shown.matchAll(/<span><i>\d+<\/i>/g)].length, 60, 'at most sixty lines');
    assert.match(shown, /<i>60<\/i>line <span class="tok-number">60<\/span><\/span><\/pre><button class="code-control" data-code-all="/);
    await page.click({ codeAll: long, before: b3 });
    feed = page.show('feed');
    const expandedAll = feed.slice(feed.indexOf(button(long, true, b3)));
    assert.equal([...expandedAll.matchAll(/<span><i>\d+<\/i>/g)].length, 100, 'show all lines fetches every line in the cited range');
    assert.match(expandedAll, /<i>100<\/i>line <span class="tok-number">100<\/span><\/span><\/pre><button class="code-control" data-code-less="/);
    await page.click({ codeLess: long, before: b3 });
    assert.equal([...page.show('feed').slice(page.show('feed').indexOf(button(long, true, b3))).matchAll(/<span><i>\d+<\/i>/g)].length, 60, 'show less returns to the bounded first window');

    await page.run('seen = ""; refresh()');
    assert.ok(page.show('feed').includes(button(was, true, b1) + '<div class="code-ref open">' + button(was, true, b1, true) + '<div class="code-wrap">'), 'a refresh keeps it open');
    await page.click({ code: was, before: b1 });
    assert.ok(page.show('feed').includes(button(was, false, b1) + ', is'), 'a second click closes it');

    // A reference is a whole word, never the tail of one: what is no path in the repo says so, and so
    // does one the text before it may make part of a longer path, however long, rather than open
    // another file.
    const b4 = prior(odd, spaced);
    const b5 = 'web/one two three four five ';
    feed = page.show('feed');
    assert.ok(feed.includes(`absolute ${button('/' + was, false, 'absolute ')} and spaced web/my ${button(spaced, false, b4)}`));
    assert.ok(feed.includes(`plus ${button('x+' + spaced, false, 'plus ')}`));
    await page.click({ code: '/' + was, before: 'absolute ' });
    await page.click({ code: spaced, before: b4 });
    await page.click({ code: 'x+' + spaced, before: 'plus ' });
    await page.click({ code: spaced });
    await page.click({ code: spaced, before: b5 });
    feed = page.show('feed');
    assert.ok(feed.includes(button('/' + was, true, 'absolute ') + '<div class="code-ref open">' + button('/' + was, true, 'absolute ', true) + '<span class="code no" role="status">[BAD_REF] name a file inside the repo by its path from the top, such as src/serve.js (saw &quot;/web/greeting.html&quot;)</span>'), 'escaped, as every refusal');
    assert.ok(feed.includes(button('x+' + spaced, true, 'plus ') + '<div class="code-ref open">' + button('x+' + spaced, true, 'plus ', true) + '<span class="code no" role="status">[BAD_REF] name a file inside the repo by its path from the top, such as src/serve.js (saw &quot;x+web/note.txt&quot;)</span>'));
    assert.ok(feed.includes(button(spaced, true, b4) + '<div class="code-ref open">' + button(spaced, true, b4, true) + '<span class="code no" role="status">[AMBIGUOUS] the text before it may make it &quot;web/my web/note.txt&quot;, which a reference cannot name</span>'));
    assert.ok(feed.includes(button(spaced, true, b5) + '<div class="code-ref open">' + button(spaced, true, b5, true) + '<span class="code no" role="status">[AMBIGUOUS] the text before it may make it &quot;web/one two three four five web/note.txt&quot;, which a reference cannot name</span>'), 'however many words the path has');
    // Inside a block comment a line is all comment: its apostrophe is a word, not the start of a string.
    assert.deepEqual([" * the verifier's checkout", '/** Version */', ' */', '# a note'].map((line) => page.run(`highlightCodeLine(${JSON.stringify(line)}, 'src/a.js')`)),
      ["<span class=\"tok-comment\"> * the verifier&#39;s checkout</span>", '<span class="tok-comment">/** Version */</span>', '<span class="tok-comment"> */</span>', '# a note'],
      'block comment lines are comments; a hash is not one in JavaScript');
    assert.equal(page.run("highlightCodeLine('# a note', 'tools/run.py')"), '<span class="tok-comment"># a note</span>', 'but is in Python');
    // A comment or a template string that spans lines is colored on every line of it, and the code after it is code again.
    const carried = (lines) => JSON.parse(page.run(`JSON.stringify((() => { const state = {}; return ${JSON.stringify(lines)}.map((line) => highlightCodeLine(line, 'src/a.js', state)); })())`));
    assert.deepEqual(carried(['const s = \`a', "it's b", 'c\`; x', 'y']),
      ['<span class="tok-keyword">const</span> s = <span class="tok-string">\`a</span>', '<span class="tok-string">it&#39;s b</span>', '<span class="tok-string">c\`</span>; x', 'y'], 'a template string carries across lines');
    assert.deepEqual(carried(['/* open', "still it's", 'done */ const']),
      ['<span class="tok-comment">/* open</span>', '<span class="tok-comment">still it&#39;s</span>', '<span class="tok-comment">done */</span> <span class="tok-keyword">const</span>'], 'and so does a block comment');
    assert.ok(feed.includes('<div class="code-ref open">' + button(spaced, true, '', true) + '<div class="code-wrap"><pre class="code"><span><i>1</i>plain note</span></pre></div></div>'), 'a reference standing alone is a block that opens, whatever other files there are');

    const ask = async (ref, { root = alpha.repo, key = view.key, before = '' } = {}) => {
      const id = await boardId(view, root);
      const res = await fetchLive(`${view.base}/api/v1/boards/${id}/code?ref=${encodeURIComponent(ref)}&before=${encodeURIComponent(before)}`, { headers: { 'x-pullboard-key': key } });
      const result = await res.json();
      return [res.status, result.error ? `[${result.error.code}] ${result.error.message}` : ''];
    };
    assert.deepEqual(await ask(spaced, { before: 'see web/my ' }), [400, '[AMBIGUOUS] the text before it may make it "web/my web/note.txt", which a reference cannot name']);
    assert.deepEqual(await ask(spaced, { before: 'see the ' }), [200, ''], 'text that makes no file leaves it be');
    const sha = first.slice(0, 7);
    for (const ref of [`../outside.txt:1@${sha}`, `/etc/passwd:1@${sha}`, `web/../../outside.txt:1@${sha}`, `./web/greeting.html:1@${sha}`]) {
      assert.deepEqual(await ask(ref), [400, `[BAD_REF] name a file inside the repo by its path from the top, such as src/serve.js (saw "${ref.split(':')[0]}")`], `${ref} is refused`);
    }
    for (const commit of ['HEAD', 'main', '--output=x', 'abc']) assert.match((await ask(`web/greeting.html:1@${commit}`)).join(' '), /^400 \[BAD_REF\] use ref=path:lines@commit/, `${commit} is no SHA`);
    assert.deepEqual(await ask('web/greeting.html:1@deadbee'), [400, '[NO_COMMIT] no commit deadbee in this repo']);
    assert.deepEqual(await ask(`draft.txt:1@${second}`), [400, `[NO_FILE] no file draft.txt at ${second}`], 'the working tree is never read');
    assert.deepEqual(await ask(`web:1@${sha}`), [400, `[NO_FILE] no file web at ${sha}`], 'nor a folder');
    assert.deepEqual(await ask(`web/greeting.html:0@${sha}`), [400, '[BAD_REF] name the lines as 12, or 12-30']);
    assert.deepEqual(await ask(`web/greeting.html:3-2@${sha}`), [400, '[BAD_REF] name the lines as 12, or 12-30']);
    assert.deepEqual(await ask(`web/greeting.html:9@${sha}`), [400, `[NO_LINES] web/greeting.html has 1 lines at ${sha}`]);
    assert.deepEqual(await ask(`web/greeting.html:1-2@${sha}`), [400, `[NO_LINES] web/greeting.html has 1 lines at ${sha}`], 'nor lines that run past the end');
    assert.deepEqual(await ask(`web/greeting.html@${sha}`), [400, '[BAD_REF] use ref=path:lines@commit, such as src/serve.js:12-30@be4356b']);
    const unknown = await ask(was, { root: box.dir });
    assert.equal(unknown[0], 404);
    assert.match(unknown[1], /^\[NO_BOARD\]/, 'a code read can name only a registered board');
    assert.equal((await ask(was, { key: 'wrong' }))[0], 401, 'and nothing without the secret');

    // A refused reference says why where its code would be.
    box.run(alpha.web, 'shout', 'all', `gone: web/greeting.html:7@${sha}`);
    await page.run('refresh()');
    await page.click({ code: `web/greeting.html:7@${sha}`, before: 'gone: ' });
    assert.ok(page.show('feed').includes(`<span class="code no" role="status">[NO_LINES] web/greeting.html has 1 lines at ${sha}</span>`));
    assert.match(page.show('feed'), /Code reference unavailable: missing a usable commit SHA\./);
    assert.match(page.show('feed'), /Code reference unavailable: missing the repository path\./);
    assert.match(page.show('detail'), /Referenced code/);
    assert.ok(page.show('detail').includes(button(`web/greeting.html:1-2@${second}`, false)), 'typed thread refs reuse the collapsed reference block');
    const relay = JSON.stringify(relayPresentation(alpha.repo));
    assert.ok(relay.includes('"path":"web/greeting.html"') && relay.includes('"commit":"' + second + '"'), 'the relay presentation retains only the typed reference fields');
    assert.ok(!relay.includes('  hello <b>there</b>'), 'the relay presentation never contains committed source text');

    // Expansion stays attached to the repo that owned the reference if the selected project changes mid-flight.
    const alphaId = await page.run(`data.projects.find((entry) => entry.root === ${JSON.stringify(alpha.repo)}).id`);
    const betaId = await page.run(`data.projects.find((entry) => entry.root === ${JSON.stringify(beta.repo)}).id`);
    await page.run(`let expansionPaths = []; let finishFirstExpansionPage; api = (path) => { expansionPaths.push(path); if (expansionPaths.length === 1) return new Promise((resolve) => { finishFirstExpansionPage = resolve; }); return Promise.resolve({ code: { lines: Array(40).fill('line') } }); };`);
    await page.click({ codeAll: long, before: b3 });
    assert.equal(await page.run('expansionPaths.length'), 1, 'the first expansion page is held until the project changes');
    await page.run(`view.root = ${JSON.stringify(beta.repo)}; finishFirstExpansionPage({ code: { lines: Array(60).fill('line') } });`);
    for (let turn = 0; turn < 6; turn++) await new Promise((resolve) => setImmediate(resolve));
    const expansionPaths = JSON.parse(await page.run('JSON.stringify(expansionPaths)'));
    assert.equal(expansionPaths.length, 2, 'the two-page range completes');
    assert.ok(expansionPaths.every((path) => path.startsWith('/api/v1/boards/' + encodeURIComponent(alphaId) + '/code?')), 'later pages remain bound to the reference project');
    assert.ok(!expansionPaths.some((path) => path.startsWith('/api/v1/boards/' + encodeURIComponent(betaId) + '/code?')), 'project switching does not redirect a pending code read');
    const wideRange = `web/long.txt:1-10001@${second}`;
    await page.run(`view.root = ${JSON.stringify(alpha.repo)}; view.code[${JSON.stringify(alpha.repo + '\n\n' + wideRange)}] = { open: true, path: 'web/long.txt', from: 1, lines: Array(60).fill('line'), more: true }; let wideCalls = 0; api = () => { wideCalls++; return Promise.resolve({ code: { lines: Array(wideCalls < 167 ? 60 : 41).fill('line') } }); };`);
    await page.click({ codeAll: wideRange });
    for (let turn = 0; turn < 6; turn++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await page.run('wideCalls'), 167, 'show all keeps working beyond the former arbitrary 10,000-line cap');
    assert.equal(await page.run(`view.code[${JSON.stringify(alpha.repo + '\n\n' + wideRange)}].allLines.length`), 10001);
  } finally {
    await view.stop();
  }
});

test('committed shout and fact references stay local, expand safely at phone and desktop widths, and explain relay snapshots [N26,B33]', { timeout: 180_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run code-reference viewport checks.');
  const box = machine();
  const alpha = project(box, 'local-code');
  box.run(alpha.repo, 'add', 'web', 'Referenced source', '--specs', 'G1');
  mkdirSync(join(alpha.web, 'web'), { recursive: true });
  const sourceText = ['const localOnlyFixture = 42;', ...Array.from({ length: 99 }, (_, index) => `export const row${index + 1} = ${index + 1};`)].join('\n') + '\n';
  writeFileSync(join(alpha.web, 'web', 'reference.js'), sourceText);
  build(box, alpha, 1, 'submitted.txt');
  const sha = box.git(alpha.web, 'rev-parse', 'HEAD');
  const ref = `web/reference.js:1-100@${sha}`;
  box.run(alpha.web, 'fact', '1', 'note', 'review the source block', '--ref', ref);
  box.run(alpha.web, 'shout', 'all', `source: ${ref}`);
  box.run(alpha.web, 'shout', 'all', 'missing commit: web/reference.js:1@deadbee');
  box.run(alpha.web, 'shout', 'all', `missing path: :1@${sha.slice(0, 7)}`);

  const presentation = JSON.stringify(relayPresentation(alpha.repo));
  assert.ok(presentation.includes('"path":"web/reference.js"') && presentation.includes('"commit":"' + sha + '"'), 'relay projection carries the typed reference');
  assert.ok(!presentation.includes('localOnlyFixture') && !presentation.includes('row99'), 'relay projection contains no source code');

  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'local-code-chrome'));
    await chrome.waitFor('typeof data === "object" && data?.project?.shouts?.length >= 3 && data?.project?.items?.[0]?.thread?.some((entry) => entry.type === "fact" && entry.ref)');
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      await chrome.evaluate(`document.querySelector('[data-tab="shouts"]').click()`);
      await chrome.evaluate(`document.querySelector('#feed button[data-code^="web/reference.js:1-100@"]').click()`);
      await chrome.waitFor(`document.querySelector('#feed .code-wrap pre.code .tok-keyword')?.textContent === 'const'`);
      assert.equal(await chrome.evaluate(`document.querySelector('#feed pre.code').textContent.includes('localOnlyFixture = 42')`), true, 'the open local preview reads the exact committed text');
      assert.equal(await chrome.evaluate(`document.querySelector('#feed pre.code .tok-number')?.textContent`), '42', 'source tokens receive syntax highlighting');
      assert.equal(await chrome.evaluate(`document.querySelectorAll('#feed pre.code > span').length`), 60, 'the initial preview stays bounded');
      await chrome.evaluate(`document.querySelector('#feed button[data-code-all]').click()`);
      await chrome.waitFor(`document.querySelectorAll('#feed pre.code > span').length === 100`);
      assert.equal(await chrome.evaluate(`document.querySelector('#feed pre.code > span:last-child').textContent.includes('row99 = 99')`), true, 'show all lines fetches the end of the cited range');
      await chrome.evaluate(`document.querySelector('#feed button[data-code-less]').click()`);
      await chrome.waitFor(`document.querySelectorAll('#feed pre.code > span').length === 60`);
      assert.equal(await chrome.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, `${width}px page has no sideways overflow`);

      assert.equal(await chrome.evaluate(`!!document.querySelector('#detail .fact-code .code-ref:not(.open) > button.ref.block[aria-expanded="false"]')`), true, 'a fact\'s reference is a collapsed block too');
      await chrome.evaluate(`document.querySelector('#detail .fact-code button[data-code]').click()`);
      await chrome.waitFor(`document.querySelector('#detail .fact-code pre.code .tok-keyword')?.textContent === 'const'`);
      assert.equal(await chrome.evaluate(`document.querySelector('#detail .fact-code pre.code').textContent.includes('localOnlyFixture = 42')`), true, 'typed fact refs use the same local renderer');
      assert.equal(await chrome.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, `${width}px thread ref has no sideways overflow`);
      await chrome.evaluate(`document.querySelector('#detail .fact-code button[data-code]').click()`);
      await chrome.evaluate(`document.querySelector('#feed button[data-code^=\"web/reference.js:1-100@\"]').click()`);
      await chrome.waitFor(`document.querySelector('#feed button[data-code^=\"web/reference.js:1-100@\"]').getAttribute('aria-expanded') === 'false'`);
    }
    await chrome.evaluate(`document.querySelector('#feed button[data-code^="web/reference.js:1@deadbee"]').click()`);
    await chrome.waitFor(`document.querySelector('#feed button[data-code^=\"web/reference.js:1@deadbee\"] + .code-ref .code, #feed button[data-code^=\"web/reference.js:1@deadbee\"] + .code')?.textContent.includes('[NO_COMMIT]')`);
    assert.equal(await chrome.evaluate(`document.querySelector('#feed button[data-code^=\"web/reference.js:1@deadbee\"] + .code-ref .code, #feed button[data-code^=\"web/reference.js:1@deadbee\"] + .code').textContent.includes('deadbee')`), true, 'a missing commit produces its readable refusal');
    assert.equal(await chrome.evaluate(`document.querySelector('#feed .ref-missing')?.textContent.includes('missing the repository path')`), true, 'a reference with no path gives a clear note');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }

  const snapshotDir = mkdtempSync(join(box.dir, 'relay-snapshot-'));
  const exported = await exportView(alpha.repo, snapshotDir);
  const exportedFiles = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path); else exportedFiles.push(readFileSync(path, 'utf8'));
    }
  };
  walk(exported.path);
  assert.ok(exportedFiles.join('\n').includes('web/reference.js:1-100@' + sha), 'static relay view retains the reference');
  assert.ok(!exportedFiles.join('\n').includes('localOnlyFixture'), 'the static relay artifact never contains the source text');
  const snapshotServer = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
    const target = resolve(exported.path, relativePath);
    if (!target.startsWith(resolve(exported.path) + '/') || !existsSync(target)) { response.writeHead(404).end(); return; }
    const type = target.endsWith('.css') ? 'text/css; charset=utf-8' : target.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(readFileSync(target));
  });
  await new Promise((resolve) => snapshotServer.listen(0, '127.0.0.1', resolve));
  let snapshotChrome;
  try {
    const address = snapshotServer.address();
    snapshotChrome = await openSnapshotChrome(executable, `http://127.0.0.1:${address.port}/`, join(box.dir, 'relay-snapshot-chrome'));
    await snapshotChrome.waitFor(`document.querySelector('#feed button[data-code^=\"web/reference.js:1-100@\"]')`);
    await snapshotChrome.evaluate(`document.querySelector('[data-tab="shouts"]').click()`);
    await snapshotChrome.evaluate(`document.querySelector('#feed button[data-code^="web/reference.js:1-100@"]').click()`);
    await snapshotChrome.waitFor(`document.querySelector('#feed button[data-code^=\"web/reference.js:1-100@\"]')?.getAttribute('aria-expanded') === 'true'`);
    assert.match(await snapshotChrome.evaluate(`document.querySelector('#feed button[data-code^=\"web/reference.js:1-100@\"] + .code-ref .code, #feed button[data-code^=\"web/reference.js:1-100@\"] + .code')?.textContent || ''`), /Source code is not included in this relay snapshot/);
    assert.ok(snapshotChrome.requests.every((request) => !request.url.includes('/code?')), 'relay snapshot serves only the reference and sends no code read');
  } finally {
    if (snapshotChrome) await closeSnapshotChrome(snapshotChrome);
    await new Promise((resolve) => snapshotServer.close(resolve));
  }
});
test('a paired relay reference explains that committed source is available only in the local project view [B33]', {
  // Its relay work is the fixture's setup moves, the browser's pairing and the reference's request: three budgets,
  // derived from the work as main's relay tests are, so it holds under load.
  timeout: relayWorkBudgetMs() * 3,
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const sentinel = 'RELAY_SOURCE_MUST_STAY_LOCAL_251';
  const oldItem = String(box.before.tables.item[0].item_id);
  assert.equal((await box.cli('withdraw', oldItem, 'replace the fixture item with a source lane')).code, 0,
    'the private setup item is withdrawn before coordinator setup is committed');
  const configPath = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.lanes.app = { owns: ['src/'], specs: ['G'] };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  const fixtureBin = box.env.PATH.split(delimiter)[0];
  const wrapper = join(fixtureBin, 'pullboard');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o700 });
  chmodSync(wrapper, 0o700);
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: box.root, env: box.env }).status, 0,
    'the coordinator stages the private repository setup');
  const setupCommit = spawnSync('git', ['commit', '-q', '-m', 'chore: set up paired relay source fixture'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(setupCommit.status, 0, `the fixture config is committed through normal hooks: ${setupCommit.stderr.trim()}`);
  const sourceWorktree = join(box.root, '..', 'source-worktree');
  const worktree = spawnSync('git', ['worktree', 'add', '-b', 'app/relay-source', sourceWorktree], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(worktree.status, 0, `the fixture creates a lane-owned source checkout: ${worktree.stderr.trim()}`);
  const sourceCli = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: sourceWorktree, env: box.env, encoding: 'utf8' });
  const joined = sourceCli('join', 'app');
  assert.equal(joined.status, 0, `the source checkout joins its lane: ${joined.stderr.trim()}`);
  const itemTitle = 'private cleanup fixture item 251';
  const addedItem = await box.cli('add', 'app', itemTitle);
  assert.equal(addedItem.code, 0, `the coordinator adds a fixture item after the setup commit: ${JSON.stringify(addedItem.document.error ?? addedItem.document)}`);
  const latest = await box.cli('export');
  assert.equal(latest.code, 0);
  const fixtureItem = String(latest.document.tables.item.find(row => row.item_title === itemTitle).item_id);
  const claimed = sourceCli('claim', fixtureItem);
  assert.equal(claimed.status, 0, `the source checkout claims the fixture item: ${claimed.stderr.trim()}`);
  const sourceFile = join(sourceWorktree, 'src', 'local-only.js');
  mkdirSync(resolve(sourceFile, '..'), { recursive: true });
  writeFileSync(sourceFile, `export const localOnly = '${sentinel}';\n`);
  assert.equal(spawnSync('git', ['add', '--', relative(sourceWorktree, sourceFile)], { cwd: sourceWorktree, env: box.env }).status, 0);
  const subject = 'chore(app): add local-only source';
  const committed = spawnSync('git', ['commit', '-q', '-m', subject], { cwd: sourceWorktree, env: box.env, encoding: 'utf8' });
  assert.equal(committed.status, 0, `the reference names a real committed source file: ${committed.stderr.trim()}`);
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceWorktree, env: box.env, encoding: 'utf8' }).trim();
  const sourceRef = relative(sourceWorktree, sourceFile).split(sep).join('/');
  const ref = `${sourceRef}:1@${sha}`;
  assert.equal((await box.cli('shout', 'all', `source: ${ref}`)).code, 0);
  await box.link();
  assert.equal((await box.cli('status')).code, 0, 'the linked board publishes its reference');

  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const encoded = readFileSync(box.keyFile, 'utf8').trim();
  const chrome = await startChrome();
  t.after(() => chrome.close());
  // Since person power stays on the paired phone, the browser reads the board with the phone's session, not the link's.
  assert.equal((await chrome.send('Network.setCookie', {
    name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  })).success, true, 'the private browser receives the paired phone’s authenticated session');
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + encoded);
  await chrome.waitFor(`document.querySelector('#chain')?.textContent.includes(${JSON.stringify(itemTitle)})`);
  await chrome.evaluate(`document.querySelector('[data-tab="shouts"]').click()`);
  await chrome.waitFor(`document.querySelector('#feed button[data-code^="${sourceRef}:1@"]')`);
  const beforeOpen = box.calls.length;
  for (const width of [375, 1280]) {
    await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor(`innerWidth === ${width}`);
    const button = `document.querySelector('#feed button[data-code^="${sourceRef}:1@"]')`;
    if (!await chrome.evaluate(`${button}.getAttribute('aria-expanded') === 'true'`)) await chrome.evaluate(`${button}.click()`);
    await chrome.waitFor(`${button}.nextElementSibling?.querySelector('.code')?.textContent.includes('local project view')`);
    assert.equal(await chrome.evaluate(`document.body.textContent.includes(${JSON.stringify(sentinel)})`), false,
      'the paired relay browser never receives committed source text');
    assert.equal(await chrome.evaluate(`JSON.stringify(data).includes(${JSON.stringify(sentinel)})`), false,
      'the decoded relay presentation contains only the reference, not source bytes');
    assert.equal(await chrome.evaluate(`${button}.nextElementSibling.querySelector('.code').textContent`),
      'Source code is unavailable in a relay view; open this reference in the local project view.');
    assert.equal(await chrome.evaluate(`document.querySelector('#feed button[data-code-all]') === null`), true,
      'a relay reference exposes no control that could request more source');
    assert.equal(await chrome.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true,
      `${width}px relay reference stays within the viewport`);
  }
  assert.equal(box.calls.slice(beforeOpen).some(call => /\/code(?:\?|$)/.test(call.path)), false,
    'opening the reference never asks the relay for source');
});

test('an empty feed says so on one line [N26]', async () => {
  const box = machine();
  project(box, 'alpha');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.equal(page.show('feed'), '<div class="empty">No shouts yet.</div>', 'one line, with no bar while the feed shows everything');
    assert.match(page.html, /<div class="card-panel shouts-card">[^]*<div class="feed" id="feed"><\/div><\/div>/, 'the shouts feed, in the Shouts card');
    assert.match(page.html, /<div class="card-panel feed" id="activity"><\/div>/, 'and the activity feed are both feeds');
    const style = await styleOf(view);
    assert.match(style, /\n\.feed > div \{ display: grid; grid-template-columns: 4\.6em minmax\(0, 1fr\);[^\n]*\n\.feed > \.empty \{ display: block; \}\n/, 'a feed row has a time column; its empty note takes the whole width');
  } finally {
    await view.stop();
  }
});
test('a shout shows the evidence it carries [B22]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  const head = box.git(alpha.web, 'rev-parse', 'HEAD');
  box.run(alpha.web, 'shout', 'all', 'the page loads in 80ms', '--evidence', 'receipt', '--outcome', 'measured <fast>', '--item', '1', '--commit', head.slice(0, 7));
  box.run(alpha.web, 'shout', 'all', 'tried a cache', '--evidence', 'attempt', '--outcome', 'failed', '--item', '1', '--commit', 'HEAD');
  box.run(alpha.web, 'shout', 'all', 'nothing to show');
  const view = await startView(box);
  try {
    const feed = (await openPage(view)).show('feed');
    const card = (kind, outcome) => `<div class="receipt"><div><span class="badge">${kind}</span> <span class="outcome">${outcome}</span></div><div class="receipt-foot"><button class="ref" data-go="item:1" title="Greeting" type="button">#1</button> · web-1 · <code class="inline sha" title="${head}">${head.slice(0, 10)}</code></div></div>`;
    const after = (text) => feed.slice(feed.indexOf(text + '</div>') + text.length + 6).replace(/^<button class="more" data-more type="button">more<\/button>/, '');
    assert.ok(after('the page loads in 80ms').startsWith(card('receipt', 'measured &lt;fast&gt;')), `what was measured, for which item, by whom, at which commit: ${after('the page loads in 80ms').slice(0, 400)}`);
    assert.ok(after('tried a cache').startsWith(card('attempt', 'failed')), 'and what was tried');
    assert.match(feed, /<span class="item">#1<\/span>/, 'the card names its item on top');
    assert.ok(feed.includes('nothing to show</div>'), 'a shout with no evidence has no card');
  } finally {
    await view.stop();
  }
});
test('activity rows say what each shout and answer said [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for activity checks.');

  const box = machine();
  const demo = project(box, 'said');
  box.run(demo.repo, 'add', 'web', 'Greet the visitor', '--specs', 'G1', '--criterion', 'greets');
  box.run(demo.repo, 'shout', 'web', 'The oldest note, from before the forty shouts the view loads');
  for (let n = 1; n <= 40; n++) box.run(demo.repo, 'shout', 'web', `Filler ${n}`);
  const long = 'Please take #1 next, run `pullboard next` in your worktree, and keep going until the greeting reads right on every width the view supports';
  box.run(demo.repo, 'shout', 'web', `${long}\nA second line the row leaves out.`);
  box.run(demo.web, 'shout', 'coordinator', 'Ship the greeting today?', '--decision');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-said-chrome-'));
  let chrome;
  try {
    const headers = { 'x-pullboard-key': view.key };
    const [board] = (await (await fetchLive(`${view.base}/api/v1/boards`, { headers })).json()).boards;
    const state = (await (await fetchLive(`${view.base}/api/v1/boards/${encodeURIComponent(board.id)}/state`, { headers })).json()).state;
    const ask = state.asked.find((row) => row.shout_text === 'Ship the greeting today?');
    box.run(demo.repo, 'answer', String(ask.shout_id), 'Yes, ship it once the phone width reads right too');
    const asker = ask.shout_from;

    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!document.querySelector(\'[data-tab="activity"]\')');
    await chrome.waitFor("typeof data === 'object' && !!data && !!data.project");
    await chrome.evaluate('document.querySelector(\'[data-tab="activity"]\').click()');
    await chrome.waitFor(`[...document.querySelectorAll('#activity .act')].some((row) => row.textContent.startsWith('coordinator answered'))`);
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      // Measure only laid-out previews: on Activity, at this width, each preview with a box of its own.
      const laidOut = `innerWidth === ${width} && !document.querySelector('[data-pane="activity"]').hidden && [...document.querySelectorAll('#activity .said')].every((said) => said.getBoundingClientRect().height > 0)`;
      await chrome.waitFor(laidOut).catch(async (error) => { throw new Error(`${error.message}; showing ${await chrome.evaluate("[...document.querySelectorAll('[data-pane]')].filter((pane) => !pane.hidden).map((pane) => pane.dataset.pane).join()")}`); });
      const rows = JSON.parse(await chrome.evaluate(`JSON.stringify([...document.querySelectorAll('#activity .act')].map((row) => {
        const said = row.querySelector('.said');
        const lines = said ? Math.round(said.getBoundingClientRect().height / parseFloat(getComputedStyle(said).lineHeight)) : 0;
        return { text: row.textContent, said: said?.textContent ?? null, tip: said?.title ?? null, lines, refs: said ? said.querySelectorAll('button.ref').length : 0,
          code: said ? [...said.querySelectorAll('code')].map((code) => code.textContent) : [], ellipsis: said ? getComputedStyle(said).textOverflow === 'ellipsis' : null,
          cut: said ? said.scrollWidth > said.clientWidth : null };
      }))`));
      const find = (start) => rows.find((row) => row.text.startsWith(start) && (row.said ?? '').length > 0);
      const told = find('coordinator shouted to web' + 'Please take');
      assert.ok(told, `${width}: a shout reads sender, shouted to, recipient, then what it said: ${JSON.stringify(rows.slice(0, 4))}`);
      assert.deepEqual([told.said, told.tip], [long.replaceAll("`", ""), long], `${width}: its first line, as written in the tooltip and rendered in the row, never its second`);
      assert.ok(told.lines === 1 && told.ellipsis, `${width}: on one line, set to end in an ellipsis: ${JSON.stringify(told)}`);
      if (width === 375) assert.ok(told.cut, `${width}: cut on a phone, so the ellipsis shows`);
      assert.deepEqual([told.refs, told.code], [1, ['pullboard next']], `${width}: keeping the item link and the inline code`);
      assert.ok(find(`${asker} asked coordinator` + 'Ship the greeting today?'), `${width}: a decision reads asked`);
      assert.ok(find(`coordinator answered ${asker}` + 'Yes, ship it once'), `${width}: an answer reads who answered whom, then the answer`);
      const oldest = rows.filter((row) => row.text.startsWith('coordinator shouted to web')).at(-1);
      assert.deepEqual([oldest.text, oldest.said], ['coordinator shouted to web', null], `${width}: a shout older than the forty on hand still names who it went to`);
      assert.ok(rows.some((row) => row.text === 'coordinator add #1 Greet the visitor'), `${width}: other rows read as before`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('activity names the item each event moved [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting <b>bold</b>', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.web, 'claim', '1');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const rows = page.show('activity').split('<div><time>').slice(1);
    const about = rows.filter((row) => row.includes('data-go="item:1"'));
    assert.equal(about.length, 2, 'the add and the claim');
    for (const row of about) assert.match(row, /type="button">#1<\/button> <span class="what">Greeting &lt;b&gt;bold&lt;\/b&gt;<\/span><\/div>/, 'the escaped title follows the link');
    const joins = rows.filter((row) => /<\/b> join<\/div>/.test(row));
    assert.ok(joins.length > 0 && joins.every((row) => !row.includes('class="what"')), 'an event about no item names none');
    assert.match(await styleOf(view), /\.feed \.act \.what \{ flex: 1 1 auto; min-width: 0; overflow-wrap: break-word;/, 'activity titles wrap at words and permit an overflowing token to break');
  } finally {
    await view.stop();
  }
});

test('needs-you lines keep their titles on a phone [N26]', async () => {
  const box = machine();
  project(box, 'alpha', `${SPEC}- G3 [pending] Should a greeting with a title long enough to need the room wrap? | gate: review\n`);
  const view = await startView(box);
  try {
    const page = await openPage(view, { width: 375 });
    const style = await styleOf(view);
    // A need is an item's row: its reference and words on the title line, NEEDS YOU and its kind below, its action at the right.
    assert.match(style, /\n\.row \.t \{ grid-area: t; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/, 'the title line ends in an ellipsis rather than wrap');
    assert.deepEqual(needEntries(page.show('needs')), [['spec:G3', 'G3', 'Should a greeting with a title long enough to need the room wrap?', 'an open question in SPEC.md', 'answer']]);
  } finally {
    await view.stop();
  }
});

test("a finished action's output steps aside [N27]", async () => {
  const box = machine();
  project(box, 'alpha');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    // The page's timers, held by the test: each pending close is recorded and fired at will.
    page.run('globalThis.pause = setTimeout; globalThis.closes = []; globalThis.setTimeout = (run, ms) => closes.push({ run, ms, live: true }); globalThis.clearTimeout = (id) => { if (closes[id - 1]) closes[id - 1].live = false; };');
    const pending = () => JSON.parse(page.run('JSON.stringify(closes.map((close) => [close.ms, close.live]))'));
    const out = page.element('console');
    const shout = async (to, text) => {
      page.element('shout-to').value = to;
      page.element('shout-text').value = text;
      await page.fire('shout-form', 'submit');
    };

    await shout('web', 'hello');
    assert.match(out.textContent, /^\$ pullboard shout web hello\n/);
    assert.deepEqual([out.className, out.hidden], ['console ok', false]);
    assert.deepEqual(pending(), [[6000, true]], 'a close six seconds on');
    page.run('closes[0].run()');
    assert.equal(out.hidden, true, 'and then the output steps aside');

    await shout('web', 'again');
    await shout('nobody-here', 'is anyone there');
    assert.match(out.textContent, /NO_READER/);
    assert.deepEqual([out.className, out.hidden], ['console no', false]);
    assert.deepEqual(pending().slice(1), [[6000, false]], 'the refusal cancelled the close the shout before it left, and set none');

    // Two shouts in flight: the first goes through but answers only after the second, a refusal, has
    // started. The first must not set a close that would hide the refusal.
    page.run('const plain = fetch; let sent = 0; globalThis.fetch = (path, init) => path.endsWith("/moves") ? new Promise((done) => pause(done, ++sent === 1 ? 300 : 900)).then(() => plain(path, init)) : plain(path, init);');
    await shout('web', 'first, and slow to answer');
    await shout('nobody-here', 'second, and refused');
    await new Promise((done) => setTimeout(done, 2000));
    await page.run('refresh()');
    assert.match(out.textContent, /NO_READER/, 'the later action owns the console');
    page.run('closes.filter((close) => close.live).forEach((close) => close.run())');
    assert.deepEqual([out.className, out.hidden], ['console no', false], 'and no close from the earlier success hides it');
  } finally {
    await view.stop();
  }
});

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
async function startSnapshotChrome(executable, profile, { timeoutMs = 30_000 } = {}) {
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-extensions', '--no-proxy-server',
    '--use-mock-keychain', '--password-store=basic', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'];
  let lastFailure = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt > 1) rmSync(join(profile, 'DevToolsActivePort'), { force: true });
    const child = spawn(executable, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const stopped = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_192); });
    let exit;
    const deadline = Date.now() + timeoutMs;
    let port;
    while (Date.now() < deadline) {
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
    if (port) return { child, stopped, port, stderr: () => stderr };
    const details = [stderr.trim(), exit?.status?.signal && `signal ${exit.status.signal}`,
      exit?.status && exit.status.code !== null && `exit ${exit.status.code}`].filter(Boolean).join('; ') || 'no stderr';
    lastFailure = exit
      ? `Chrome exited before publishing DevToolsActivePort (${details})`
      : `Chrome did not publish DevToolsActivePort within ${timeoutMs}ms (${details})`;
    await stopOwnedChrome(child, stopped);
  }
  throw new Error(`Chrome failed to start after 2 launches; final stderr: ${lastFailure}`);
}

/** Start one isolated headless Chrome and expose its page through a small CDP client. */
async function openSnapshotChrome(executable, url, profile) {
  const launched = await startSnapshotChrome(executable, profile);
  const { child, stopped, port } = launched;
  let socket;
  let id = 0;
  const pending = new Map();
  const requests = [];
  const exceptions = [];
  try {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(10_000) })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DevTools socket did not open')), 10_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('DevTools socket failed')); }, { once: true });
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
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    });
    /** Send one CDP command and clear its timeout on either response or failure. */
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(`DevTools timed out: ${method}`)); }, 45_000);
      pending.set(key, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: key, method, params }));
    });
    /** Evaluate an expression in the page and return its by-value result. */
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    /**
     * Poll a page expression with a fixed deadline, without leaving a live interval behind. A condition that
     * throws, as one does while the next document is still parsing, is not ready yet, so polling goes on; one
     * that never holds fails at the deadline, naming the last error it threw. Exceptions the page throws by
     * itself still reach exceptions: an evaluation's own exception is never reported there.
     */
    const waitFor = async (expression, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      let lastError = '';
      while (Date.now() < deadline) {
        try {
          const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
          if (!result.exceptionDetails && result.result.value) return;
          if (result.exceptionDetails) {
            const details = result.exceptionDetails;
            lastError = String(details.exception?.description ?? details.text).split('\n')[0];
          }
        } catch (error) {
          lastError = error.message;
        }
        await browserPause(50);
      }
      throw new Error(`Browser condition did not arrive: ${expression}${lastError ? `; it last threw: ${lastError}` : ''}`);
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Page.navigate', { url });
    return { child, stopped, socket, send, evaluate, waitFor, requests, exceptions };
  } catch (error) {
    socket?.close();
    await stopOwnedChrome(child, stopped);
    const chromeStderr = launched.stderr().trim();
    throw new Error(chromeStderr ? `${error.message}; Chrome stderr: ${chromeStderr}` : error.message, { cause: error });
  }
}

/** Stop only an owned Chrome process group, with bounded TERM and KILL waits. */
async function stopOwnedChrome(child, stopped) {
  /** Wait for the owned process to exit, bounding and clearing the timeout either way. */
  const waitBounded = async (ms) => {
    let timer;
    const exited = await Promise.race([stopped.then(() => true), new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    })]);
    clearTimeout(timer);
    return exited;
  };
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* The owned Chrome group already exited. */ }
  if (await waitBounded(5_000)) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The owned Chrome group already exited. */ }
  assert.ok(await waitBounded(5_000), 'owned Chrome exits after SIGKILL within the bounded cleanup window');
}

/** Close the CDP socket and stop only this test's isolated Chrome process group. */
async function closeSnapshotChrome(chrome) {
  chrome.socket.close();
  await stopOwnedChrome(chrome.child, chrome.stopped);
}

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

test('static export stays in its prefix and replays read-only in Chrome [A10,A3]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run the static replay proof.');

  const box = machine();
  const alpha = project(box, 'snapshot replay');
  box.run(alpha.repo, 'add', 'web', 'Replay greeting', '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 1, 'greeting.html');
  sendBack(box, alpha, 1, 'the first greeting needs a correction');
  build(box, alpha, 1, 'greeting-fix.html');
  // Accept the submitted commit from a throwaway coordinator checkout, then always restore main.
  box.git(alpha.repo, 'switch', '-q', '--detach', alpha.branch);
  try { box.run(alpha.repo, 'verify', '1', 'accept', '--note', 'the corrected greeting renders', '--as', 'coordinator'); }
  finally { box.git(alpha.repo, 'switch', '-q', 'main'); }
  // Exercise the person's decision button so snapshot mode must hide this real mutation control.
  box.run(alpha.repo, 'shout', 'person', 'Should the replay stay read-only?', '--decision');
  box.run(alpha.repo, 'hold', 'web', '--reason', 'Snapshot stays read-only');
  const scriptShout = '<script>window.__snapshotShoutRan = true</script>';
  box.run(alpha.repo, 'shout', 'all', scriptShout);

  // Capture the live API state before export; the exported replay must finish at exactly this state.
  const live = await startView(box);
  let expected;
  try { expected = portableSnapshot(await boardOf(live, alpha.repo), alpha.repo); }
  finally { await live.stop(); }

  const exportDir = join(box.dir, 'snapshot-export');
  box.run(alpha.repo, 'view', '--export', exportDir);
  assert.ok(existsSync(join(exportDir, 'index.html')));
  assert.ok(existsSync(join(exportDir, 'view.css')));
  const exportedBoards = JSON.parse(readFileSync(join(exportDir, 'api', 'v1', 'boards.json'), 'utf8'));
  const boardId = exportedBoards.boards[0].id;
  const exportedEvents = JSON.parse(readFileSync(join(exportDir, 'api', 'v1', 'boards', boardId, 'events.json'), 'utf8')).events;
  const fullBoardLog = JSON.parse(box.run(alpha.repo, 'log', '--json')).events;
  assert.equal(exportedEvents.length, fullBoardLog.length, 'the snapshot exports every board event');
  assert.deepEqual(exportedEvents.map((event) => event.event_id), fullBoardLog.map((event) => event.event_id),
    'the snapshot event file contains the complete ordered board log');

  const prefix = '/demo/';
  const staticRequests = [];
  const outsideRequests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const entry = { method: request.method, path: url.pathname, headers: request.headers };
    staticRequests.push(entry);
    if (!url.pathname.startsWith(prefix)) {
      outsideRequests.push(entry);
      response.writeHead(404).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    let relativePath;
    try { relativePath = decodeURIComponent(url.pathname.slice(prefix.length)); }
    catch { response.writeHead(400).end(); return; }
    if (!relativePath) relativePath = 'index.html';
    const file = resolve(exportDir, relativePath);
    if (!file.startsWith(`${resolve(exportDir)}/`)) { response.writeHead(404).end(); return; }
    let body;
    try { body = readFileSync(file); }
    catch { response.writeHead(404).end(); return; }
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
      : file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.json') ? 'application/json; charset=utf-8'
      : 'application/octet-stream';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-snapshot-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `${base}${prefix}`, profile);
    const evaluate = chrome.evaluate;
    await chrome.waitFor("document.body?.classList.contains('snapshot') && typeof snapshotReplay === 'object' && !!data?.project && snapshotReplay.events.length > 0 && snapshotReplay.index === snapshotReplay.events.length");
    await chrome.waitFor("!!document.querySelector('#replay-play') && !!document.querySelector('#replay-pause') && !!document.querySelector('#replay-speed') && !!document.querySelector('#replay-progress')");

    const initial = JSON.parse(await evaluate(`JSON.stringify({ project: data.project, index: snapshotReplay.index, total: snapshotReplay.events.length, playing: snapshotReplay.playing, speedOptions: [...document.querySelector('#replay-speed').options].map((option) => option.value), bodyClass: document.body.classList.contains('snapshot') })`));
    assert.equal(initial.bodyClass, true);
    assertObservationsEqual(expected, initial.project, 'the initial snapshot is the final live API state');
    assert.deepEqual(initial.speedOptions, ['1', '4', '16']);
    assert.ok(initial.total >= 6, 'the exported board contains the complete claim/submit/reject/claim/submit/accept history');
    assert.ok(initial.index >= initial.total - 1, 'the initial replay position is the exported final state');

    const shout = JSON.parse(await evaluate(`JSON.stringify((() => {
      const feed = document.querySelector('#feed');
      return { text: feed.textContent, html: feed.innerHTML, scripts: feed.querySelectorAll('script').length };
    })())`));
    assert.ok(shout.text.includes(scriptShout), 'the shout is visible as literal text');
    assert.ok(shout.html.includes('&lt;script&gt;'), 'the snapshot escapes HTML in shout text');
    assert.equal(shout.scripts, 0, 'shout text never becomes an executable script element');

    const firstPosition = JSON.parse(await evaluate(`(() => {
      window.__snapshotRealAdvance = advanceReplay;
      window.__snapshotFirstPosition = null;
      window.advanceReplay = () => {
        window.__snapshotFirstPosition = { index: snapshotReplay.index, items: data.project.items.map((item) => item.id) };
        snapshotReplay.playing = false;
        replayControls();
      };
      document.querySelector('#replay-play').click();
      return JSON.stringify(window.__snapshotFirstPosition);
    })()`));
    assert.deepEqual(firstPosition, { index: 0, items: [] }, 'play starts from an empty board before its first event');
    await evaluate('window.advanceReplay = window.__snapshotRealAdvance');

    const replayKinds = await evaluate(`JSON.stringify(snapshotReplay.events.map((event) => event.event_kind))`);
    const kinds = JSON.parse(replayKinds);
    const transitions = ['claim', 'submit', 'reject', 'claim', 'submit', 'accept'];
    let cursor = -1;
    for (const kind of transitions) {
      cursor = kinds.indexOf(kind, cursor + 1);
      assert.notEqual(cursor, -1, `replay includes ordered ${kind} event`);
    }

    const hiddenMutationControls = await evaluate(`JSON.stringify(['#new-item', '#add-form', '#shout-form', '#hold-form', '[data-release]', '[data-shout]', '[data-new]', '[data-go^="decide:"]'].filter((selector) => { const node = document.querySelector(selector); return node && !node.hidden && getComputedStyle(node).display !== 'none'; }))`);
    assert.deepEqual(JSON.parse(hiddenMutationControls), [], 'snapshot hides controls that could change the board');
    const writesBeforeAct = staticRequests.length;
    const directAction = await evaluate(`(async () => JSON.stringify({ result: await act('shout', { to: 'web', text: 'must remain local' }), message: document.body.innerText }))()`);
    assert.equal(JSON.parse(directAction).result, false, 'snapshot action refuses direct mutation calls');
    assert.match(JSON.parse(directAction).message, /snapshot/i, 'refusal explains that this is a snapshot');
    await browserPause(100);
    assert.equal(staticRequests.length, writesBeforeAct, 'a refused action makes no browser request');

    await evaluate(`(() => {
      window.__replayObserved = [];
      let previousIndex = null;
      const progress = document.querySelector('#replay-progress');
      new MutationObserver(() => {
        const index = snapshotReplay.index;
        if (index === previousIndex) return;
        previousIndex = index;
        const dot = document.querySelector('[data-item="1"] .dot');
        const status = dot && [...dot.classList].find((name) => ['open', 'building', 'verify', 'back', 'verified'].includes(name));
        if (status) window.__replayObserved.push({ index, status });
      }).observe(progress, { childList: true, characterData: true, subtree: true });
    })()`);
    await evaluate("document.querySelector('#replay-play').click()");
    await chrome.waitFor('snapshotReplay.playing && snapshotReplay.index > 0 && snapshotReplay.index < snapshotReplay.events.length');
    const beforePause = await evaluate('snapshotReplay.index');
    await evaluate("document.querySelector('#replay-pause').click()");
    await chrome.waitFor('!snapshotReplay.playing');
    const pausedIndex = await evaluate('snapshotReplay.index');
    assert.equal(pausedIndex, beforePause, 'pause keeps the current replay event');
    await browserPause(180);
    assert.equal(await evaluate('snapshotReplay.index'), pausedIndex, 'a paused replay does not advance');

    await evaluate("const speed = document.querySelector('#replay-speed'); speed.value = '16'; speed.dispatchEvent(new Event('change', { bubbles: true }))");
    assert.equal(await evaluate("document.querySelector('#replay-speed').value"), '16');
    const speedStart = await evaluate('snapshotReplay.index');
    assert.ok(speedStart + 4 < initial.total, 'at least four events remain to measure 16x playback');
    const speedStartedAt = Date.now();
    await evaluate("document.querySelector('#replay-play').click()");
    await chrome.waitFor(`snapshotReplay.index >= ${speedStart + 4}`, 2_000);
    assert.ok(Date.now() - speedStartedAt < 2_000, '16x advances four replay events within two seconds');
    await chrome.waitFor('!snapshotReplay.playing', 20_000);
    assert.equal(await evaluate('snapshotReplay.playing'), false, 'the replay reaches its end');
    const renderedStates = JSON.parse(await evaluate('JSON.stringify(window.__replayObserved.map((entry) => entry.status))'));
    const distinctStates = renderedStates.filter((state, index) => index === 0 || state !== renderedStates[index - 1]);
    const firstClaim = distinctStates.indexOf('building');
    assert.notEqual(firstClaim, -1, 'the rendered replay shows a claimed item');
    assert.deepEqual(distinctStates.slice(firstClaim, firstClaim + 6),
      ['building', 'verify', 'back', 'building', 'verify', 'verified'],
      'the actual item row renders claim, submit, reject, claim, submit, accept in order');
    const finalProject = await evaluate('JSON.stringify(data.project)');
    assertObservationsEqual(expected, JSON.parse(finalProject), 'replay ends at the same state served live before export');

    for (const [width, theme] of [[1280, 'light'], [375, 'dark']]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await evaluate(`document.documentElement.dataset.theme = '${theme}'`);
      assert.ok(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'),
        'snapshot controls fit the viewport content area');
      if (process.env.PULLBOARD_SNAPSHOT_PROOF) {
        mkdirSync(process.env.PULLBOARD_SNAPSHOT_PROOF, { recursive: true });
        const shot = await chrome.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writeFileSync(join(process.env.PULLBOARD_SNAPSHOT_PROOF, `snapshot-${width}-${theme}.png`), Buffer.from(shot.data, 'base64'));
      }
    }

    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught page exceptions');
    const nonHttpRequests = chrome.requests.filter(({ url }) => !/^https?:/i.test(url));
    assert.ok(nonHttpRequests.every(({ url }) => url.startsWith('data:')), 'the only non-network browser URL may be a local data favicon');
    const browserRequests = chrome.requests.filter(({ url }) => /^https?:/i.test(url)).map(({ method, url, headers }) => ({
      method,
      origin: new URL(url).origin,
      path: new URL(url).pathname,
      hasBoardKey: Object.keys(headers).some((name) => name.toLowerCase() === 'x-pullboard-key'),
    }));
    assert.ok(browserRequests.length > 0);
    assert.ok(browserRequests.every((request) => request.origin === base), 'Chrome makes HTTP requests only to the static host');
    assert.deepEqual(browserRequests.filter((request) => !request.path.startsWith(prefix)), [], 'Chrome never requests outside /demo/');
    assert.ok(browserRequests.every((request) => request.method === 'GET' && !request.hasBoardKey), 'static assets and API JSON are GET-only and carry no board key');
    assert.deepEqual(outsideRequests, [], 'the static host receives no request outside /demo/');
    assert.ok(staticRequests.every((request) => request.method === 'GET' || request.method === 'HEAD'), 'the static host serves reads only');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await new Promise((resolve) => server.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
});


test('served connection reaches an authenticated API on another origin and path in Chrome [H5,N26]', { timeout: 60_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the connection proof.');
  const box = machine();
  const alpha = project(box, 'remote phone demo');
  box.run(alpha.repo, 'add', 'web', 'Remote original');
  const view = await startView(box);
  const credential = 'test-only-bearer';
  const seen = [];
  const apiServer = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization,content-type');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    seen.push({ path: req.url, method: req.method, authorization: req.headers.authorization, localKey: req.headers['x-pullboard-key'] });
    if (req.headers.authorization !== `Bearer ${credential}` || !req.url.startsWith('/mirror/api/v1/')) return res.writeHead(401).end(JSON.stringify({ error: 'bad supplied connection' }));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const upstream = await fetchLive(view.base + req.url.slice('/mirror'.length), {
        method: req.method, headers: { 'x-pullboard-key': view.key, ...(req.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}), signal: AbortSignal.timeout(10_000),
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' }).end(await upstream.text());
    } catch (error) { res.writeHead(500).end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const apiBase = `http://127.0.0.1:${apiServer.address().port}/mirror`;
  const pageServer = createServer((req, res) => {
    if (req.url === '/phone/index.html') return res.writeHead(200, { 'content-type': 'text/html' }).end(cockpitPage('', { apiBase, apiHeaders: { authorization: `Bearer ${credential}` }, stylesheet: 'view.css' }));
    if (req.url === '/phone/view.css') return res.writeHead(200, { 'content-type': 'text/css' }).end(readFileSync(resolve(import.meta.dirname, '../src/view.css')));
    res.writeHead(404).end();
  });
  await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `http://127.0.0.1:${pageServer.address().port}/phone/index.html`, join(box.dir, 'remote-phone-chrome'));
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('typeof data === "object" && !!data?.project');
    assert.equal(await chrome.evaluate('data.project.items[0].title'), 'Remote original');
    await chrome.evaluate(`document.querySelector('#new-item').click(); document.querySelector('#add-title').value = 'Remote added'; document.querySelector('#add-form').requestSubmit()`);
    await chrome.waitFor('data.project.items.some(item => item.title === "Remote added")');
    assert.ok(seen.some((entry) => entry.method === 'POST' && entry.path.endsWith('/moves')), 'a real browser action reaches the configured API');
    assert.ok(seen.every((entry) => entry.authorization === `Bearer ${credential}` && entry.localKey === undefined && entry.path.startsWith('/mirror/api/v1/')), 'only the supplied credential and API base reach the stand-in');
    assert.ok(await chrome.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'),
      'the remote phone page fits the viewport content area');
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await new Promise((resolve) => pageServer.close(resolve));
    await new Promise((resolve) => apiServer.close(resolve));
    await view.stop();
  }
});

test('relay person requests stay explicit, read-only and visible [H12,H5]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run the person-request transport proof.');

  const box = machine();
  const requestRows = Array.from({ length: 12 }, (_, index) => `- P${index + 1} [draft, must] Keep the reading position measurable. | gate: test`).join('\n');
  const requestSpec = `# Person request fixture\n\n## G · Goals\n- G1 [approved, must] Existing item remains readable. | gate: test\n${requestRows}\n- G2 [draft, must] The person can approve this row. | gate: test\n`;
  const app = project(box, 'person requests', requestSpec);
  box.run(app.repo, 'add', 'web', 'Existing private item', '--specs', 'G1', '--criterion', 'remains readable');
  box.run(app.repo, 'shout', 'person', 'Should this item ship?', '--decision');
  const live = await startView(box);
  const intents = [];
  const records = [];
  let chrome;
  /** Build the opted-in page or a refusal control with the same read-only transport. */
  const page = (options = {}) => cockpitPage('', {
    readOnly: true, requests: true, transportModule: '/transport.js', stylesheet: '/view.css', ...options,
  });
  const transportModule = `/** Provide the permitted stand-in transport while leaving real board reads untouched. */
  export async function createTransport({ onUpdate }) {
    window.__transportCalls = [];
    window.__setPersonRequest = async (id, status, error) => {
      await fetch('/request-status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, status, error }) });
      await onUpdate();
    };
    window.__holdNextIntent = false;
    window.__releaseHeldIntent = null;
    return { async request(path, body) {
      window.__transportCalls.push({ path, body: body ?? null });
      if (body) {
        if (window.__holdNextIntent) {
          window.__holdNextIntent = false;
          await new Promise(resolve => { window.__releaseHeldIntent = resolve; });
        }
        const response = await fetch('/intent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const document = await response.json();
        if (!response.ok) throw new Error(document.error?.message || String(response.status));
        return document;
      }
      const response = await fetch('/fixture' + path);
      const document = await response.json();
      if (!response.ok) throw new Error(document.error?.message || String(response.status));
      if (new URL(path, location.origin).pathname.endsWith('/state')) document.state.personRequests = await (await fetch('/request-state')).json();
      return document;
    } };
  }`;
  /** Serve controlled request receipts and proxy reads to the actual private Git/SQLite board. */
  async function fixtureRequest(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/request-state' && request.method === 'GET') {
      return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(records));
    }
    if (url.pathname === '/request-status' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const update = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const row = records.find(entry => entry.id === update.id);
      row.status = update.status;
      if (update.error) row.error = update.error;
      return response.writeHead(200).end();
    }
    if (url.pathname === '/intent' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const move = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const allowed = ['add', 'shout', 'answer', 'hold', 'spec-approve', 'spec-decline'].includes(move.verb)
        && Object.keys(move).every(key => ['verb', 'item', 'args'].includes(key));
      if (!allowed) return response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Only literal person requests are allowed.' } }));
      intents.push(structuredClone(move));
      const row = { id: 'request-' + intents.length, sequence: intents.length, at: '2026-10-08T00:00:00.000Z', by: 'person', move, status: 'waiting' };
      records.push(row);
      return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: 1, event: { event_id: row.sequence, kind: 'request' }, result: { request: row } }));
    }
    if (url.pathname.startsWith('/fixture/')) {
      if (request.method !== 'GET') return response.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'The read-only fixture accepts GET only.' } }));
      const upstream = await fetchLive(live.base + url.pathname.slice('/fixture'.length) + url.search, { headers: { 'x-pullboard-key': live.key } });
      return response.writeHead(upstream.status, { 'content-type': 'application/json' }).end(await upstream.text());
    }
    response.writeHead(404).end();
  }
  /** Serve each capability control and the same-origin stand-in request protocol. */
  const pageServer = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/without-capability' || url.pathname === '/snapshot') {
      const body = url.pathname === '/'
        ? page({})
        : url.pathname === '/snapshot'
          ? cockpitPage('', { snapshot: true, requests: true, stylesheet: '/view.css' })
          : cockpitPage('', { readOnly: true, transportModule: '/transport.js', stylesheet: '/view.css' });
      return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
    }
    if (url.pathname.startsWith('/api/v1/') && url.pathname.endsWith('.json')) {
      const target = url.pathname.slice(0, -'.json'.length) + url.search;
      const upstream = await fetchLive(live.base + target, { headers: { 'x-pullboard-key': live.key } });
      return response.writeHead(upstream.status, { 'content-type': 'application/json' }).end(await upstream.text());
    }
    if (url.pathname === '/transport.js') return response.writeHead(200, { 'content-type': 'text/javascript' }).end(transportModule);
    if (url.pathname === '/view.css') return response.writeHead(200, { 'content-type': 'text/css' }).end(readFileSync(resolve(import.meta.dirname, '../src/view.css')));
    return fixtureRequest(request, response);
  });
  await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-person-request-chrome-'));
  scratch.push(profile);
  try {
    chrome = await openSnapshotChrome(executable, `http://127.0.0.1:${pageServer.address().port}/`, profile);
    await chrome.waitFor("typeof data === 'object' && !!data?.project && typeof window.__setPersonRequest === 'function'");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.equal(await chrome.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, 'the request view fits a phone viewport');
    assert.equal(await chrome.evaluate("document.body.classList.contains('requests') && getComputedStyle(document.querySelector('#new-item')).display !== 'none' && document.querySelector('#new-item').getBoundingClientRect().height >= 44"), true, 'the explicit capability exposes usable person controls');
    await chrome.evaluate("document.querySelector('[data-tab=\"shouts\"]').click(); document.querySelector('#shout-to').value = 'coordinator'; document.querySelector('#shout-text').value = 'Please review this item.'; document.querySelector('#shout-form').requestSubmit()");
    await chrome.waitFor("data?.project?.personRequests?.length === 1");
    assert.deepEqual(intents.at(-1), { verb: 'shout', args: { to: 'coordinator', text: 'Please review this item.' } });
    await chrome.evaluate("document.querySelector('[data-tab=\"spec\"]').click()");
    await chrome.waitFor("document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    await chrome.evaluate("document.querySelector('#spec-list [data-row=\"spec:G2\"]').scrollIntoView({ block: 'center' })");
    await chrome.waitFor('window.scrollY > 0');
    await chrome.evaluate("document.querySelector('#spec-list [data-row=\"spec:G2\"]').click()");
    await chrome.waitFor("view.row.spec === 'G2'");
    const reading = JSON.parse(await chrome.evaluate(`JSON.stringify({ root: view.root, boardRoot: data.project.root, row: view.row.spec, scroll: window.scrollY })`));
    assert.equal(reading.root, reading.boardRoot, 'the selected spec row belongs to the displayed board');
    assert.equal(reading.row, 'G2', 'G2 is the selected reading row before approval');
    await chrome.waitFor("document.querySelector('#spec-detail button[data-row-decision=\"approve\"]')");
    assert.equal(await chrome.evaluate("document.querySelector('#spec-detail button[data-row-decision=\"approve\"]').getBoundingClientRect().height >= 44"), true, 'the real G2 approval control is usable at 375px');
    await chrome.evaluate('window.__holdNextIntent = true');
    await chrome.evaluate("document.querySelector('#spec-detail button[data-row-decision=\"approve\"]').click()");
    await chrome.waitFor("typeof window.__releaseHeldIntent === 'function' || document.querySelector('#spec-detail .spec-feedback.no')");
    assert.equal(await chrome.evaluate("typeof window.__releaseHeldIntent"), 'function', 'the row decision reaches the sealed request transport instead of the refused generic API');
    await chrome.waitFor("document.querySelector('#spec-detail .spec-feedback')?.textContent.trim() === 'Recording decision…'");
    await chrome.evaluate('window.__releaseHeldIntent()');
    await chrome.waitFor("document.querySelector('#spec-detail .spec-feedback') && document.querySelector('#spec-detail .spec-feedback').textContent.trim() !== 'Recording decision…'");
    assert.deepEqual(intents.at(-1), { verb: 'spec-approve', args: { ids: 'G2' } }, 'the detail click creates the exact second literal intent');
    await chrome.waitFor("data?.project?.personRequests?.length === 2 && document.querySelector('[data-person-request=\"request-2\"] .request-status')?.textContent === 'Waiting'");
    assert.match(await chrome.evaluate("document.querySelector('#spec-detail .spec-feedback')?.textContent.trim() || ''"), /G2/);
    const afterApproval = JSON.parse(await chrome.evaluate(`JSON.stringify({ root: view.root, row: view.row.spec, scroll: window.scrollY, selected: document.querySelector('#spec-list [data-row=\"spec:G2\"]')?.classList.contains('on'), visible: (() => { const row = document.querySelector('#spec-list [data-row=\"spec:G2\"]')?.getBoundingClientRect(); return !!row && row.top >= 0 && row.bottom <= innerHeight; })() })`));
    assert.deepEqual([afterApproval.root, afterApproval.row, afterApproval.selected], [reading.root, 'G2', true], 'the request keeps the selected board and G2 row');
    assert.ok(Math.abs(afterApproval.scroll - reading.scroll) <= 1, 'the request keeps the page at the same reading position');
    assert.equal(afterApproval.visible, true, 'G2 remains visible beside its inline feedback');
    assert.deepEqual(intents.at(-1), { verb: 'spec-approve', args: { ids: 'G2' } });
    assert.equal(await chrome.evaluate("data.project.spec.find(row => row.id === 'G2').decision === undefined"), true, 'waiting for a request never approves the row optimistically');
    await chrome.evaluate("window.__setPersonRequest('request-2', 'done')");
    assert.match(await chrome.evaluate("document.querySelector('#spec-detail .spec-feedback')?.textContent || ''"), /^Done/, 'the same row feedback follows a matched done receipt');
    await chrome.evaluate("window.__setPersonRequest('request-2', 'refused', { code: 'REQUEST_DECLINED', message: 'Keep the row draft.', next: 'Ask the coordinator for the next step.' })");
    assert.match(await chrome.evaluate("document.querySelector('#spec-detail .spec-feedback.no')?.textContent || ''"), /Refused[\s\S]*REQUEST_DECLINED[\s\S]*Keep the row draft\.[\s\S]*Ask the coordinator/, 'the same row retains the original refusal and next step');
    await chrome.evaluate("window.__setPersonRequest('request-2', 'waiting')");

    const ids = JSON.parse(await chrome.evaluate('JSON.stringify(data.project.personRequests.map(row => row.id))'));
    assert.deepEqual(ids, ['request-1', 'request-2']);
    assert.ok(await chrome.evaluate("[...document.querySelectorAll('[data-person-request]')].length === 2 && [...document.querySelectorAll('[data-person-request]')].every(node => node.querySelector('.request-status').textContent === 'Waiting')"), 'waiting receipts render from API state');

    // A generic write and an unknown action are refused before they reach the stand-in transport.
    const beforeRefused = intents.length;
    const beforeTransport = await chrome.evaluate('window.__transportCalls.length');
    assert.match(await chrome.evaluate(`(async () => { try { await api(boardPath(view.root) + '/moves', { verb: 'shout', args: { to: 'coordinator', text: 'direct writes stay refused' } }); return 'unexpected'; } catch (error) { return error.message; } })()`), /read-only view/i);
    assert.equal(await chrome.evaluate(`(async () => act('exec', { command: 'true' }))()`), false);
    assert.equal(intents.length, beforeRefused, 'refused shapes never reach the request server');
    assert.equal(await chrome.evaluate('window.__transportCalls.length'), beforeTransport, 'refused writes never reach the browser transport');

    const longTitle = 'Requested item ' + 'abcdefghij'.repeat(24);
    const otherActions = [
      ['add', { lane: 'web', title: longTitle, criterion: 'visible', specs: 'G1', brief: 'requested work' }, { verb: 'add', args: { lane: 'web', title: longTitle, criterion: 'visible', specs: 'G1', brief: 'requested work' } }],
      ['answer', { id: 1, text: 'Ship it' }, { verb: 'answer', item: 1, args: { text: 'Ship it', as: 'person' } }],
      ['hold', { lane: 'web', reason: 'Wait for the decision' }, { verb: 'hold', args: { lane: 'web', reason: 'Wait for the decision' } }],
      ['release', { lane: 'web' }, { verb: 'hold', args: { lane: 'web', off: true } }],
      ['spec-decline', { ids: 'G2', reason: 'Keep the present behavior' }, { verb: 'spec-decline', args: { ids: 'G2', reason: 'Keep the present behavior' } }],
    ];
    for (const [action, args, expected] of otherActions) {
      assert.equal(await chrome.evaluate(`act(${JSON.stringify(action)}, ${JSON.stringify(args)})`), true, `${action} is a permitted person request`);
      assert.deepEqual(intents.at(-1), expected, `${action} retains literal public CLI intent`);
    }
    const allActions = [['shout', { to: 'coordinator', text: 'must not send' }], ['spec-approve', { ids: 'G2' }], ...otherActions.map(([action, args]) => [action, args])];

    // The no-capability read-only page and static snapshot cannot send person requests either.
    await chrome.send('Page.navigate', { url: `http://127.0.0.1:${pageServer.address().port}/without-capability` });
    await chrome.waitFor("typeof data === 'object' && !!data?.project && document.body?.classList.contains('read-only')");
    const beforeDisabled = intents.length;
    await chrome.evaluate("document.querySelector('[data-tab=\"spec\"]').click(); document.querySelector('#spec-list [data-row=\"spec:G2\"]').click()");
    await chrome.waitFor("view.row.spec === 'G2'");
    assert.equal(await chrome.evaluate(`(async () => decideRow('spec', 'spec-approve', { ids: 'G2' }, document.querySelector('#spec-list [data-row=\"spec:G2\"]')))()`), false, 'the decision handler itself refuses without request capability');
    assert.equal(await chrome.evaluate('!view.specFeedback'), true, 'a disabled decision refuses before creating decision feedback');
    assert.equal(intents.length, beforeDisabled, 'a direct no-capability decision never reaches the request transport');
    for (const [action, args] of allActions) assert.equal(await chrome.evaluate(`act(${JSON.stringify(action)}, ${JSON.stringify(args)})`), false, `${action} stays refused without the capability`);
    assert.equal(intents.length, beforeDisabled, 'read-only without the explicit request capability refuses every action');
    await chrome.send('Page.navigate', { url: `http://127.0.0.1:${pageServer.address().port}/snapshot` });
    await chrome.waitFor("typeof data === 'object' && !!data?.project && document.body?.classList.contains('snapshot')");
    assert.equal(await chrome.evaluate(`(async () => decideRow('spec', 'spec-approve', { ids: 'G2' }, null))()`), false, 'the decision handler itself refuses in a snapshot');
    for (const [action, args] of allActions) assert.equal(await chrome.evaluate(`act(${JSON.stringify(action)}, ${JSON.stringify(args)})`), false, `${action} stays refused in a snapshot`);
    assert.match(await chrome.evaluate(`(async () => { try { await api('/api/v1/boards/demo/moves', { verb: 'shout' }); return 'unexpected'; } catch (error) { return error.message; } })()`), /read-only snapshot/i);
    assert.equal(intents.length, beforeDisabled, 'snapshot mode cannot use the explicit request capability');

    // A later actual API read may update status; refusal text is safe text and preserves CLI guidance.
    await chrome.send('Page.navigate', { url: `http://127.0.0.1:${pageServer.address().port}/` });
    await chrome.waitFor("typeof window.__setPersonRequest === 'function' && !!data?.project");
    await chrome.evaluate(`window.__setPersonRequest('request-1', 'done')`);
    await chrome.waitFor("document.querySelector('[data-person-request=\"request-1\"]')?.querySelector('.request-status')?.textContent === 'Done'");
    const refusal = '<img src=x onerror=globalThis.requestInjection=true> UNKNOWN_SPEC; run pullboard spec check';
    await chrome.evaluate(`window.__setPersonRequest('request-2', 'refused', { code: 'UNKNOWN_SPEC', message: ${JSON.stringify(refusal)}, next: 'run pullboard spec check' })`);
    await chrome.waitFor("document.querySelector('[data-person-request=\"request-2\"]')?.textContent.includes('UNKNOWN_SPEC')");
    assert.equal(await chrome.evaluate("document.querySelector('[data-person-request=\"request-2\"] img') === null"), true, 'refusal guidance is escaped, not interpreted as markup');
    assert.equal(await chrome.evaluate("document.querySelector('[data-person-request=\"request-2\"] .request-error')?.textContent"), 'UNKNOWN_SPEC ' + refusal, 'the original CLI refusal message stays intact');
    assert.equal(await chrome.evaluate('globalThis.requestInjection === undefined'), true, 'refusal content cannot execute in the page');
    assert.equal(await chrome.evaluate("document.querySelector('[data-person-request=\"request-2\"]')?.textContent.includes('run pullboard spec check')"), true);
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      assert.equal(await chrome.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, `${width}px refusal view has no horizontal overflow`);
      const layout = JSON.parse(await chrome.evaluate(`JSON.stringify({
        statuses: [...document.querySelectorAll('.request-status')].map(node => node.textContent),
        listFits: document.querySelector('.request-list').scrollWidth <= document.querySelector('.request-list').clientWidth,
        readable: [...document.querySelectorAll('.request-label, .request-status, .request-error, .request-next')].every(node => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth && parseFloat(getComputedStyle(node).fontSize) >= 12;
        })
      })`));
      for (const status of ['Waiting', 'Done', 'Refused']) assert.ok(layout.statuses.includes(status), `${width}px renders ${status} from documented request status`);
      assert.equal(layout.listFits, true, `${width}px keeps the request list inside its panel`);
      assert.equal(layout.readable, true, `${width}px keeps request labels and refusal guidance readable`);
    }
    assert.deepEqual(intents, [
      { verb: 'shout', args: { to: 'coordinator', text: 'Please review this item.' } },
      { verb: 'spec-approve', args: { ids: 'G2' } },
      ...otherActions.map(([, , expected]) => expected),
    ]);
    const privatePath = await chrome.evaluate('boardPath(view.root)');
    const privateState = await (await fetchLive(live.base + privatePath + '/state', { headers: { 'x-pullboard-key': live.key } })).json();
    assert.equal(privateState.state.items.length, 1, 'the stand-in request transport never executes an item move on the real board');
    assert.equal(privateState.state.holds.length, 0, 'the request transport never changes a real lane hold');
    assert.equal(privateState.state.shouts.length, 1, 'the request transport never posts a direct shout');
  } finally {
    if (chrome) { chrome.socket.close(); await stopOwnedChrome(chrome.child, chrome.stopped); }
    await new Promise((resolve) => pageServer.close(resolve));
    await live.stop();
  }
});

test('read-only Needs-you preserves each entry as text while its transport stays read-only [N26,N27,B26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run the browser transport proof.');

  const box = machine();
  const app = project(box, 'read only transport', `${SPEC}- G3 [pending, must] Confirm the read-only question. | gate: review\n- G4 [draft, must] Confirm the draft row. | gate: review\n`);
  box.run(app.repo, 'add', 'web', 'Read-only fixture item', '--specs', 'G1', '--criterion', 'keeps action controls in the DOM');
  box.run(app.repo, 'shout', 'person', 'Should the read-only fixture ship?', '--decision');
  box.run(app.repo, 'hold', 'web', '--reason', 'read-only fixture hold');
  const live = await startView(box);
  const pageKey = 'page-relay-secret';
  const headerKey = 'header-relay-secret';
  const page = cockpitPage(pageKey, {
    readOnly: true,
    transportModule: '/transport.js',
    apiBase: 'https://private.invalid/board?secret=api-base-secret',
    apiHeaders: { 'x-pullboard-key': headerKey },
    stylesheet: '/view.css',
  });
  for (const secret of [pageKey, headerKey, 'api-base-secret']) assert.equal(page.includes(secret), false, 'custom transport page options do not expose API credentials');
  assert.throws(() => cockpitPage('', { transportModule: '' }), /transportModule/);

  const forwarded = [];
  const moduleSource = `export async function createTransport({ onUpdate }) {
    window.__transportCalls = [];
    window.__transportUpdate = onUpdate;
    return { async request(path, body) {
      window.__transportCalls.push({ path, body: body ?? null });
      const response = await fetch('/fixture' + path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      const document = await response.json();
      if (!response.ok) throw new Error(document.error?.message || String(response.status));
      return document;
    } };
  }`;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/missing') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page);
      return;
    }
    if (url.pathname === '/transport.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(moduleSource);
      return;
    }
    if (url.pathname === '/view.css') {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      response.end(readFileSync(new URL('../src/view.css', import.meta.url), 'utf8'));
      return;
    }
    if (!url.pathname.startsWith('/fixture/')) {
      response.writeHead(404).end();
      return;
    }
    const target = url.pathname.slice('/fixture'.length) + url.search;
    const headers = { 'x-pullboard-key': live.key };
    if (request.method !== 'GET') {
      forwarded.push(request.method);
      response.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'fixture transport accepts reads only' }));
      return;
    }
    forwarded.push(request.method);
    fetchLive(live.base + target, { headers }).then(async (reply) => {
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(await reply.text());
    }).catch((error) => {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error.message || error) }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-transport-chrome-'));
  scratch.push(profile);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, live.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data?.project && document.querySelector('#needs .row')?.textContent.includes('Should the read-only fixture ship?')");
    /** Read Needs-you labels with absolute API age timestamps so the comparison survives minute ticks. */
    const readNeedEntries = () => chrome.evaluate(`JSON.stringify([...document.querySelectorAll('#needs .row')].map((row) => {
      const time = row.querySelector('.row-age time'), ref = row.querySelector('.t > span');
      return [ref?.textContent, row.querySelector('.t').textContent.slice((ref?.textContent ?? '').length),
        row.querySelector('.meta .why').textContent + (time ? ' @' + time.dataset.ago : '')];
    }))`);
    const normalEntries = JSON.parse(await readNeedEntries());
    assert.deepEqual(normalEntries.map((row) => row[0]), [null, 'G3', 'web', '1'], 'the normal Needs-you list contains the decision, pending row, held lane, and draft summary');
    assert.match(normalEntries[0][2], /^NEEDS YOU a decision, asked by [^ ]+ @[^ ]+$/, 'the API-provided decision timestamp is shown as an age');
    assert.match(normalEntries[2][2], /^NEEDS YOU lane held by coordinator @[^ ]+$/, 'the holder and API-provided hold timestamp are shown as an age');
    await chrome.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/` });
    await chrome.waitFor("typeof data === 'object' && document.body?.classList.contains('read-only') && !!data?.project && typeof window.__transportUpdate === 'function'");
    await chrome.waitFor("document.querySelector('#needs .row')?.textContent.includes('Should the read-only fixture ship?')");
    const readOnlyEntries = JSON.parse(await readNeedEntries());
    assert.deepEqual(readOnlyEntries, normalEntries, 'read-only Needs-you preserves the normal entries and their API-provided asker and ages');
    assert.equal(await chrome.evaluate("document.querySelectorAll('#needs button, #needs [data-go], #needs [data-new], #needs [data-shout], #needs [data-release]').length"), 0,
      'read-only Needs-you entries contain no answer, approve, navigation, or other action controls');
    const calls = JSON.parse(await chrome.evaluate('JSON.stringify(window.__transportCalls)'));
    assert.ok(calls.some((call) => call.path === '/api/v1/boards'));
    assert.ok(calls.some((call) => call.path.startsWith('/api/v1/boards/') && call.path.endsWith('/state')));
    assert.equal(await chrome.evaluate("document.querySelector('#live').textContent"), '', 'read-only transport keeps the page live, which says nothing');
    const actionSelectors = ['#new-item', '#add-form', '#shout-form', '#hold-form', '[data-release]', '[data-shout]', '[data-new]', '[data-go^="decide:"]'];
    const actionMatches = JSON.parse(await chrome.evaluate(`JSON.stringify(${JSON.stringify(actionSelectors)}.map((selector) => ({ selector, count: document.querySelectorAll(selector).length, visible: [...document.querySelectorAll(selector)].some((node) => !node.hidden && getComputedStyle(node).display !== 'none') })))`));
    assert.ok(actionMatches.every((entry) => entry.count > 0), 'the seeded item, decision and hold exercise every action selector');
    assert.deepEqual(actionMatches.filter((entry) => entry.visible).map((entry) => entry.selector), [], 'read-only mode hides every match for every action control');

    const refusedAction = JSON.parse(await chrome.evaluate(`(async () => JSON.stringify({ result: await act('shout', { to: 'all', text: 'blocked' }), message: document.querySelector('#console').textContent }))()`));
    assert.equal(refusedAction.result, false);
    assert.match(refusedAction.message, /read-only/i);
    const refusedApi = await chrome.evaluate(`(async () => { try { await api('/api/v1/boards/demo/moves', { verb: 'shout' }); return 'unexpected success'; } catch (error) { return error.message; } })()`);
    assert.match(refusedApi, /read-only/i, 'direct API mutation calls are refused before transport');
    assert.ok(forwarded.every((method) => method === 'GET'), 'read-only action attempts send no write through the transport');

    await chrome.evaluate(`window.__samePage = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })`);
    box.run(app.repo, 'add', 'web', 'Transport refresh item', '--specs', 'G1', '--criterion', 'appears after a transport update');
    await chrome.evaluate('window.__transportUpdate()');
    assert.equal(await chrome.evaluate("data?.project?.items.some((item) => item.title === 'Transport refresh item') && window.__samePage === true"), true, 'onUpdate refreshes state in the same page without relying on the poll');
    assert.ok(forwarded.every((method) => method === 'GET'), 'transport update refreshed through reads only');

  } finally {
    if (chrome) {
      chrome.socket.close();
      await stopOwnedChrome(chrome.child, chrome.stopped);
    }
    await live.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a configured transport never falls back while loading or after import failure [N26,N27]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the transport startup proof.');

  const box = machine();
  const demo = project(box, 'transport-startup');
  box.run(demo.repo, 'add', 'web', 'Transport startup item', '--specs', 'G1', '--criterion', 'loads through the configured transport');
  const live = await startView(box);
  const slowPage = cockpitPage('', { transportModule: '/slow-transport.js' });
  const failedPage = cockpitPage('', { transportModule: '/failed-transport.js' });
  const localRequests = [];
  const relayRequests = [];
  let slowModuleRequested;
  const requested = new Promise((resolve) => { slowModuleRequested = resolve; });
  let releaseSlowModule;
  const slowModuleBarrier = new Promise((resolve) => { releaseSlowModule = resolve; });
  const transportSource = `export async function createTransport() {
    window.__transportReady = true;
    window.__transportCalls = [];
    return { async request(path, body) {
      window.__transportCalls.push(path);
      const response = await fetch('/relay' + path, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined });
      return response.json();
    } };
  }`;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/slow' || url.pathname === '/failed') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(url.pathname === '/slow' ? slowPage : failedPage);
      return;
    }
    if (url.pathname === '/slow-transport.js') {
      slowModuleRequested();
      await slowModuleBarrier;
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(transportSource);
      return;
    }
    if (url.pathname === '/failed-transport.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end("throw new Error('fixture transport import failed');");
      return;
    }
    if (url.pathname === '/view.css') {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      response.end(readFileSync(new URL('../src/view.css', import.meta.url), 'utf8'));
      return;
    }
    if (url.pathname.startsWith('/relay/')) {
      const path = url.pathname.slice('/relay'.length) + url.search;
      relayRequests.push(path);
      try {
        const reply = await fetchLive(live.base + path, { headers: { 'x-pullboard-key': live.key } });
        response.writeHead(reply.status, { 'content-type': 'application/json' });
        response.end(await reply.text());
      } catch (error) {
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: String(error.message || error) }));
      }
      return;
    }
    if (url.pathname.startsWith('/api/v1/')) {
      localRequests.push(url.pathname);
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'LOCAL_FALLBACK', message: 'the page-local API must not be used' } }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-transport-startup-chrome-'));
  let chrome;
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    chrome = await openSnapshotChrome(executable, `${origin}/slow`, profile);
    await requested;
    const loadingCall = await chrome.evaluate("api('/api/v1/boards').then(() => 'unexpected success', error => error.message)");
    assert.match(loadingCall, /transport.*loading/i, 'direct API calls refuse while the configured module is loading');
    await browserPause(3200);
    assert.equal(await chrome.evaluate('window.__transportReady === true'), false, 'the delayed module is still loading during the proof');
    assert.deepEqual(localRequests, [], 'neither direct reads nor the poll fall back while loading');

    releaseSlowModule();
    await chrome.waitFor('window.__transportReady === true && !!data?.project');
    assert.ok(relayRequests.includes('/api/v1/boards'), 'the initial board read uses the configured transport');
    assert.deepEqual(localRequests, [], 'loading the configured module never touched the page-local API');

    await chrome.send('Page.navigate', { url: `${origin}/failed` });
    await chrome.waitFor("document.querySelector('#live').textContent.includes('fixture transport import failed')");
    await browserPause(3200);
    assert.match(await chrome.evaluate("document.querySelector('#live').textContent"), /cannot reach the view: fixture transport import failed/,
      'the original module error remains visible after later poll intervals');
    assert.deepEqual(localRequests, [], 'a failed import also disables page-local polling');
  } finally {
    releaseSlowModule();
    if (chrome) await closeSnapshotChrome(chrome);
    await live.stop();
    await new Promise((resolve) => server.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
});

test('real Chrome keeps the demo board usable at phone and desktop widths [H5,N26,N27]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for viewport checks.');

  const box = machine();
  const demo = project(box, 'phone-demo');
  const other = project(box, 'other-demo');
  box.run(demo.repo, 'add', 'web', 'Starter item', '--specs', 'G1', '--criterion', 'visible in the detail pane');
  const wrapTitle = 'word boundary test ' + 'abcdef0123456789'.repeat(12);
  box.run(demo.repo, 'add', 'web', wrapTitle, '--specs', 'G1', '--criterion', 'the activity title wraps without splitting words');
  box.run(demo.repo, 'shout', 'person', 'Should the phone demo ship?', '--decision');
  box.run(demo.web, 'shout', 'coordinator', 'Should this waiting ask span the full row?', '--decision');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-phone-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    const consoleErrors = [];
    chrome.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
      }
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') consoleErrors.push(message.params.entry.text);
    });
    await chrome.send('Log.enable');

    /** Wait for every matching element to render before using its geometry [N26]. */
    const waitRendered = (selectors) => chrome.waitFor(`(() => {
      const groups = ${JSON.stringify(selectors)}.map(selector => [...document.querySelectorAll(selector)]);
      return groups.every(elements => elements.length > 0 && elements.every(element => {
        const style = getComputedStyle(element), rect = element.getBoundingClientRect();
        return !element.closest('[hidden]') && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }));
    })()`);
    /** Click the actual control through Chrome input coordinates. */
    const click = async (selector) => {
      await waitRendered([selector]);
      const point = JSON.parse(await chrome.evaluate(`(async () => {
        const find=()=>document.querySelector(${JSON.stringify(selector)});
        if(!find()) throw Error('missing '+${JSON.stringify(selector)});
        find().scrollIntoView({block:'center'});
        // Centering the sticky tab bar scrolls the page on for a few frames, so measure only once the
        // target has held still for two frames; a point read mid-scroll lands on whatever slid under it.
        // Find it afresh each frame: a refresh can redraw it, and a detached element measures as 0,0.
        const frame=()=>new Promise((done)=>requestAnimationFrame(()=>done()));
        let last='', still=0;
        for (let n=0; n<120 && still<2; n++) { await frame(); const e=find(); const b=e?e.getBoundingClientRect():null, now=b?[b.x,b.y,b.width,b.height,scrollX,scrollY].join():''; still=now&&now===last?still+1:0; last=now; }
        const e=find(); if(!e) throw Error('gone before the click: '+${JSON.stringify(selector)});
        const r=e.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});
      })()`));
      await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    };
    /** Fill a form field and deliver its input and change events. */
    const fill = (selector, value) => chrome.evaluate(`(() => {
      const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw Error('missing '+${JSON.stringify(selector)});
      e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    /** Submit a rendered form through native validation. */
    const submit = (selector) => chrome.evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);
    /** Resize Chrome and wait for the board layout. */
    const setViewport = async (width) => {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.readyState === 'complete'`);
      await waitRendered(['[data-pane]:not([hidden])']);
    };
    /** Read actual visible target sizes and document geometry. */
    const snapshot = async () => {
      await waitRendered(['[data-pane]:not([hidden])']);
      return JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const visible=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return !e.disabled&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0&&!e.closest('[hidden]')};
      const selector='button,a[href],input:not([type=hidden]),select,textarea,[role=button],[data-root],[data-tab],[data-go],[data-item],[data-state],[data-rows],[data-row],[data-release],[data-shout],[data-new],[data-code]';
      const controls=[...new Set(document.querySelectorAll(selector))].filter(visible).map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,id:e.id||'',text:(e.innerText||e.getAttribute('aria-label')||'').trim().slice(0,60),x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,inlineReference:e.matches('.feed button.ref, .shout button.ref, .shout .band a, .detail button.ref')||!!e.closest('#chain .meta .gate, #detail .kv dd.waits-on'),statusBar:(!!e.closest('.status')||(!!e.closest('.composer')&&innerWidth>=900))&&!matchMedia('(pointer: coarse)').matches,oneLine:!e.closest('.status')||getComputedStyle(e).whiteSpace==='nowrap'}});
      const notice=document.querySelector('#console');
      const noticeBox=visible(notice)?notice.getBoundingClientRect():null;
      const toast=noticeBox?{x:noticeBox.x,y:noticeBox.y,right:noticeBox.right,bottom:noticeBox.bottom,visible:noticeBox.y>=0&&noticeBox.bottom<=innerHeight,
        overlaps:controls.filter(c=>c.x<noticeBox.right&&c.right>noticeBox.x&&c.y<noticeBox.bottom&&c.bottom>noticeBox.y).map(c=>c.id||c.text)}:null;
      return {width:innerWidth,clientWidth:document.documentElement.clientWidth,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,
        pointer:{fine:matchMedia('(pointer: fine)').matches,coarse:matchMedia('(pointer: coarse)').matches,none:matchMedia('(pointer: none)').matches},
        touch:matchMedia('(pointer: coarse)').matches||innerWidth<900,
        statusParts:[...document.querySelectorAll('.status [data-status]')].filter(visible).map(part=>({label:part.textContent.replace(/\\s+/g,' ').trim(),height:part.getBoundingClientRect().height})),
        projectList:visible(document.querySelector('#proj-list')),needs:visible(document.querySelector('#needs')),
        detail:visible(document.querySelector('#detail')),controls,toast};
    })())`));
    };
    /** Check document and body overflow against the actual layout viewport, excluding its scrollbar. */
    const fitsViewport = (layout) => layout.documentWidth <= layout.clientWidth && layout.bodyWidth <= layout.clientWidth;
    /** Assert the current pane fits and all its controls remain touchable. */
    const checkLayout = async (width, place) => {
      const layout = await snapshot();
      assert.ok(fitsViewport(layout),
        `${width} ${place}: no horizontal overflow: ${JSON.stringify(layout)}`);
      // Where a finger taps (a coarse pointer, or a window under 900px) every action is a 44px target, inline references
      // in running text excepted; under a mouse, or no pointer at all, there is no minimum. Status labels stay on one line.
      const short = layout.touch ? layout.controls.filter((control) => control.height < 44 && !control.inlineReference) : [];
      assert.deepEqual(layout.controls.filter((control) => !control.oneLine), [], `${width} ${place}: status labels stay on one line`);
      assert.deepEqual(short, [], `${width} ${place}: visible enabled actions are at least 44px high: ${JSON.stringify(short)}`);
      if (layout.toast) assert.deepEqual(layout.toast.overlaps, [], `${width} ${place}: the result toast clears every visible control: ${JSON.stringify(layout.toast)}`);
      if (place === 'successful add toast') assert.equal(layout.toast?.visible, true, `${width}: the successful action toast remains in the viewport: ${JSON.stringify(layout.toast)}`);
    };

    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("document.readyState === 'complete' && !!document.querySelector('#chain .row')");
    for (const width of [375, 1280]) {
      if (width === 1280) {
        box.run(demo.repo, 'shout', 'person', 'Should the desktop demo ship?', '--decision');
        await chrome.waitFor("document.querySelector('#needs').innerText.includes('Should the desktop demo ship?')", 15_000);
      }
      await setViewport(width);
      await click('[data-tab="items"]');
      if (width <= 900) {
        await click('#proj-switch');
        await chrome.waitFor("getComputedStyle(document.querySelector('#proj-list')).display !== 'none'");
        await checkLayout(width, 'open project list');
        await click(`[data-root="${other.repo}"]`);
        await chrome.waitFor("document.querySelector('#proj-name').textContent === 'other-demo'");
        await click('#proj-switch');
        await click(`[data-root="${demo.repo}"]`);
        await chrome.waitFor("document.querySelector('#proj-name').textContent === 'phone-demo' && !!document.querySelector('#chain .row')");
      }
      assert.ok(await chrome.evaluate("[...document.querySelectorAll('#proj-list .pname')].some(e=>e.textContent==='phone-demo')"), `${width}: demo appears in the project list`);
      assert.ok(await chrome.evaluate("!!document.querySelector('#needs:not([hidden])')"), `${width}: Needs you is visible`);
      await click('#chain .row');
      assert.ok(await chrome.evaluate("!!document.querySelector('#detail h2')"), `${width}: selected item detail is visible`);
      await checkLayout(width, 'items, Needs you and detail');
      for (const tab of ['shouts', 'spec', 'doctrine', 'activity']) {
        await click(`[data-tab="${tab}"]`);
        await checkLayout(width, `${tab} tab`);
        if (tab === 'spec') {
          await waitRendered(['#spec-chips button']);
          const chips = JSON.parse(await chrome.evaluate(`JSON.stringify([...document.querySelectorAll('#spec-chips button')].map(button => {
            const clone=button.cloneNode(true); clone.style.cssText += ';position:fixed;visibility:hidden;width:max-content;flex:none'; button.parentElement.append(clone);
            const naturalWidth=clone.getBoundingClientRect().width, actualWidth=button.getBoundingClientRect().width; clone.remove();
            return {text:button.textContent.trim(),actualWidth,naturalWidth};
          }))`));
          assert.ok(chips.length >= 2, `${width}: spec filters render as chips`);
          for (const chip of chips) assert.ok(Math.abs(chip.actualWidth - chip.naturalWidth) < 2, `${width}: ${chip.text} keeps its natural width: ${JSON.stringify(chip)}`);
        }
        if (tab === 'activity') {
          await chrome.waitFor(`(() => {
            const element = [...document.querySelectorAll('#activity .what')].find(node => node.textContent === ${JSON.stringify(wrapTitle)});
            return element?.getBoundingClientRect().width > 0 && element.firstChild?.nodeType === Node.TEXT_NODE;
          })()`);
          const wrap = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
            const element=[...document.querySelectorAll('#activity .what')].find(node=>node.textContent===${JSON.stringify(wrapTitle)});
            if(!element) return null;
            const text=element.firstChild, ranges=(word)=>{const start=text.textContent.indexOf(word),range=document.createRange();range.setStart(text,start);range.setEnd(text,start+word.length);return [...range.getClientRects()].map(rect=>({x:rect.x,y:rect.y,width:rect.width}));};
            const lines=(rects)=>new Set(rects.map(rect=>Math.round(rect.y))).size;
            return {width:element.clientWidth,height:element.getBoundingClientRect().height,wordLines:lines(ranges('boundary')),tokenLines:lines(ranges('abcdef0123456789'.repeat(12)))};
          })())`));
          assert.ok(wrap, `${width}: the activity feed shows the long item title`);
          assert.equal(wrap.wordLines, 1, `${width}: a normal word stays together at a line boundary: ${JSON.stringify(wrap)}`);
          assert.ok(wrap.tokenLines > 1, `${width}: only the overflowing unbroken token splits: ${JSON.stringify(wrap)}`);
        }
        if (tab === 'shouts') {
          await chrome.evaluate("(() => { const fold = document.querySelector('.asks-toggle[data-fold=\"waiting\"]'); if (fold && fold.getAttribute('aria-expanded') !== 'true') fold.click(); })()");
          await waitRendered(['#decisions .shout:not(:has(.answer)) header', '#decisions .shout:not(:has(.answer)) .text', '#decisions .shout .answer']);
          const asks = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
            const waiting = document.querySelector('#decisions .shout:not(:has(.answer))');
            const waitingMeta = waiting?.querySelector('header');
            const waitingText = waiting?.querySelector('.text');
            const button = document.querySelector('#decisions .shout .answer');
            const answerText = button?.closest('.shout-main').querySelector('.text');
            const rect = e => { const r=e.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
            return {
              waitingIsNeedsYou: document.querySelector('#decisions').classList.contains('needs-you'),
              waitingHasNoAnswer: !!waiting && !waiting.querySelector('.answer'),
              waitingMeta: waitingMeta && rect(waitingMeta),
              waitingMetaLine: waitingMeta && parseFloat(getComputedStyle(waitingMeta.querySelector('.who')).lineHeight),
              waitingMain: waiting && rect(waiting.querySelector('.shout-main')), waitingText: waitingText && rect(waitingText),
              answerText: answerText && rect(answerText), button: button && rect(button),
            };
          })())`));
          assert.ok(asks.waitingIsNeedsYou && asks.waitingHasNoAnswer, `${width}: the waiting ask is a card in the Needs-you panel without an Answer button`);
          assert.ok(asks.waitingMeta.width > 0 && asks.waitingMeta.height <= asks.waitingMetaLine + 1,
            `${width}: waiting ask who/when stays on one line: ${JSON.stringify(asks)}`);
          assert.ok(asks.waitingText.width >= asks.waitingMain.width - 1,
            `${width}: waiting ask text spans the card: ${JSON.stringify(asks)}`);
          assert.ok(asks.button.top >= asks.answerText.bottom && asks.button.left >= asks.answerText.left - 1 && asks.button.height >= tapTarget(width),
            `${width}: the Answer button sits under the ask it answers: ${JSON.stringify(asks)}`);
        }
      }
      await click('[data-tab="items"]');

      await click('#new-item');
      await checkLayout(width, 'add form');
      await fill('#add-lane', 'web');
      await fill('#add-title', `Phone item ${width}`);
      await fill('#add-specs', 'G1');
      await click('#add-form button[type="submit"]');
      await chrome.waitFor(`document.querySelector('#chain').innerText.includes('Phone item ${width}')`);
      await chrome.waitFor("document.querySelector('#console.ok') && document.querySelector('#console').textContent.includes('added #')");
      await checkLayout(width, 'successful add toast');

      await click('[data-tab="shouts"]');
      await checkLayout(width, 'shout and hold forms');
      await fill('#shout-to', 'web');
      await fill('#shout-text', `Phone shout ${width}`);
      await submit('#shout-form');
      await chrome.waitFor(`document.querySelector('#feed').innerText.includes('Phone shout ${width}')`);

      await chrome.waitFor("!!document.querySelector('#decisions [data-go]')");
      const decision = await chrome.evaluate("document.querySelector('#decisions [data-go]')?.getAttribute('data-go')");
      assert.ok(decision, `${width}: a decision is offered for answer`);
      await click(`#decisions [data-go="${decision}"]`);
      await checkLayout(width, 'answer form');
      await fill('#shout-text', `Phone answer ${width}`);
      await submit('#shout-form');
      await chrome.waitFor(`document.querySelector('#feed').innerText.includes('Phone answer ${width}')`);

      await fill('#hold-lane', 'web');
      await fill('#hold-reason', `Phone hold ${width}`);
      await submit('#hold-form');
      await chrome.waitFor("!!document.querySelector('#lanes [data-release=web]')");
      await click('#lanes [data-release="web"]');
      await chrome.waitFor("!document.querySelector('#lanes [data-release=web]')");
    }

    const originalPointer = JSON.parse(await chrome.evaluate(`JSON.stringify({ fine:matchMedia('(pointer: fine)').matches, coarse:matchMedia('(pointer: coarse)').matches, none:matchMedia('(pointer: none)').matches })`));
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await chrome.waitFor("matchMedia('(pointer: coarse)').matches");
    await setViewport(1280);
    await checkLayout(1280, 'coarse touch status and controls');
    const touchLayout = await snapshot();
    assert.deepEqual(touchLayout.pointer, { fine: false, coarse: true, none: false }, `1280 touch emulation selects the coarse primary pointer: ${JSON.stringify(touchLayout.pointer)}`);
    assert.ok(touchLayout.statusParts.length > 0, 'the real status bar exposes its visible controls');
    assert.ok(touchLayout.statusParts.every((part) => part.height >= 44), `1280 touch status controls keep a 44px target: ${JSON.stringify(touchLayout.statusParts)}`);
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await chrome.waitFor(`matchMedia('(pointer: fine)').matches === ${originalPointer.fine} && matchMedia('(pointer: coarse)').matches === ${originalPointer.coarse} && matchMedia('(pointer: none)').matches === ${originalPointer.none}`);

    await chrome.evaluate(`(() => {
      const probe = document.createElement('div');
      probe.dataset.scrollbarProof = '';
      probe.style.cssText = 'position:absolute;left:0;top:0;width:2000px;height:1px;';
      document.body.append(probe);
    })()`);
    const overflowingLayout = await snapshot();
    assert.ok(overflowingLayout.documentWidth > overflowingLayout.clientWidth,
      'the deliberate probe extends past the content viewport');
    assert.equal(fitsViewport(overflowingLayout), false,
      'the no-horizontal-overflow predicate detects deliberate content overflow');
    await chrome.evaluate("document.querySelector('[data-scrollbar-proof]').remove()");
    await checkLayout(1280, 'after removing the deliberate overflow probe');

    const posts = chrome.requests.filter((request) => request.method === 'POST' && new URL(request.url).pathname.endsWith('/moves'));
    assert.equal(posts.length, 10, 'each viewport sends add, shout, answer, hold and release through the public move endpoint');
    const apiRequests = chrome.requests.filter((request) => new URL(request.url).pathname.includes('/api/'));
    assert.ok(apiRequests.length > 0 && apiRequests.every((request) => new URL(request.url).pathname.startsWith('/api/v1/boards')),
      'every observed API request uses public v1');
    const state = await boardOf(view, demo.repo);
    for (const width of [375, 1280]) {
      assert.ok(state.items.some((item) => item.title === `Phone item ${width}`));
      assert.ok(state.shouts.some((shout) => shout.shout_text === `Phone shout ${width}`));
      assert.ok(state.shouts.some((shout) => shout.shout_from === 'person' && shout.shout_text.includes(`Phone answer ${width}`)));
    }
    assert.deepEqual(state.holds, [], 'both widths released the held lane');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught exceptions');
    assert.deepEqual(consoleErrors, [], 'Chrome reports no console errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('Spec and Doctrine line up, open on a row and decide with quiet controls [N26, B26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for Spec layout checks.');

  const spec = '# Demo spec\n\n## G · Goals\n- G1 [draft, must] One short line. | gate: web test\n- G2 [draft, must] A second draft row. | gate: web test\n- G3 [approved, must] An approved row. | gate: web test\n';
  const box = machine();
  project(box, 'spec-layout', spec);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-spec-layout-chrome-'));
  let chrome;
  /** Where the list and detail cards start, what is picked, and how a row's decision sits beside its text. */
  const read = async (kind) => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    const pane = document.querySelector('[data-pane="${kind}"]');
    const box = (e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
    const row = document.querySelector('#${kind}-list .srow[data-row="${kind}:G1"]');
    const text = row?.querySelector('.srow-text');
    const buttons = row ? [...row.querySelectorAll('[data-row-decision]')] : [];
    const quiet = (e) => { const s = getComputedStyle(e); return s.borderTopWidth === '0px' && s.backgroundColor === 'rgba(0, 0, 0, 0)'; };
    const line = text ? parseFloat(getComputedStyle(text).lineHeight) : 0;
    return { list: box(pane.querySelector('.rows-card')), detail: box(pane.querySelector('.detail')), picked: document.querySelector('#${kind}-list .srow.on')?.dataset.row ?? null,
      shown: document.querySelector('#${kind}-detail h2 span')?.textContent ?? null, first: document.querySelector('#${kind}-list .srow')?.dataset.row ?? null,
      row: row && box(row), text: text && box(text), line, buttons: buttons.map((e) => ({ ...box(e), quiet: quiet(e), word: e.textContent })),
      decide: [...document.querySelectorAll('#${kind}-detail [data-row-decision]')].map((e) => ({ ...box(e), quiet: quiet(e), word: e.textContent })),
      section: [...document.querySelectorAll('#${kind}-list [data-section-approve], #${kind}-detail [data-row-decision]')].map((e) => quiet(e)),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data && !!data.project");
    for (const width of [1280, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.evaluate("document.querySelector('[data-tab=spec]').click(); document.querySelector('#spec-chips [data-rows=\"spec:decide\"]').click(); view.row.spec = null; render();");
      await chrome.waitFor(`innerWidth === ${width} && !!document.querySelector('#spec-list [data-row="spec:G1"]')`);
      const spec = await read('spec');
      if (width === 1280) assert.ok(Math.abs(spec.list.top - spec.detail.top) < 0.5, `${width}: the list and the detail start on one line: ${JSON.stringify([spec.list, spec.detail])}`);
      assert.deepEqual([spec.picked, spec.shown], ['spec:G1', 'G1'], `${width}: with nothing picked, the detail opens on the first row shown`);
      assert.deepEqual([spec.buttons.length, spec.decide.map((b) => b.word)], [0, ['Approve', 'Decline']], `${width}: a row carries no decision; the picked row's detail holds it once`);
      assert.ok(spec.decide.every((b) => b.quiet && b.height >= tapTarget(width)), `${width}: quiet words, no box or fill until hovered, each a target: ${JSON.stringify(spec.decide)}`);
      assert.ok(spec.section.length >= 3 && spec.section.every(Boolean), `${width}: Approve all and the detail's decision are quiet too`);
      if (width === 1280) {
        assert.ok(spec.row.height <= 60 && Math.round(spec.text.height / spec.line) <= 2, `${width}: a one-sentence row takes one or two lines: ${JSON.stringify([spec.row, spec.text, spec.line])}`);
      }
      assert.ok(!spec.overflow, `${width}: nothing runs off the screen`);
      // A filter that hides the pick moves it to the new first row; one that keeps it keeps it.
      await chrome.evaluate("document.querySelector('#spec-list [data-row=\"spec:G2\"]').click()");
      await chrome.evaluate("document.querySelector('#spec-chips [data-rows=\"spec:all\"]').click()");
      assert.equal((await read('spec')).picked, 'spec:G2', `${width}: a filter that still shows the pick keeps it`);
      await chrome.evaluate("document.querySelector('#spec-chips [data-rows=\"spec:approved\"]').click()");
      const moved = await read('spec');
      assert.deepEqual([moved.picked, moved.shown], ['spec:G3', 'G3'], `${width}: a filter that hides the pick moves it to the first row shown`);
      await chrome.evaluate("document.querySelector('[data-tab=doctrine]').click(); view.row.doctrine = null; render();");
      const doctrine = await read('doctrine');
      if (width === 1280) assert.ok(Math.abs(doctrine.list.top - doctrine.detail.top) < 0.5, `${width}: Doctrine's cards start on one line too`);
      assert.ok(doctrine.picked && doctrine.picked === doctrine.first && doctrine.shown === doctrine.first.split(':')[1], `${width}: and Doctrine opens on its first row: ${JSON.stringify([doctrine.picked, doctrine.shown])}`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('spec rows read as a list, decided in the panel [N26]', { timeout: 300_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for Spec list checks.');

  // Each of the four layouts decides two rows on each tab, one approved and one declined, so each tab has eight drafts.
  const drafts = (prefix, from, words) => words.map((w, n) => `- ${prefix}${from + n} [draft, must] ${w} | gate: review\n`).join('');
  const eight = ['The page names its owner.', 'Every list says when it was read.', 'A failed save says why.', 'Dates say which day they were.',
    'Long titles end in an ellipsis.', 'The theme follows the system.', 'Each tab keeps its place.', 'Empty lists say how to start.'];
  const spec = '# Decisions\n\n## S · Screens\n'
    + '- S1 [draft, must] The board loads in under a second. | gate: web test\n'
    + '- S2 [pending] Should the board remember the last tab? | gate: review\n'
    + '- S3 [approved, must] Pages never scroll sideways. | gate: web test\n'
    + drafts('S', 4, eight);
  const box = machine();
  const demo = project(box, 'spec-list', spec, { practice: 'ways.md' });
  // Rules this repo wrote, as drafts: the person decides them as Spec rows are decided. Pullboard's own rules come too.
  writeFileSync(join(demo.repo, 'ways.md'), '# Local rules\n\n## Team\n' + drafts('D', 1, eight));
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-spec-list-chrome-'));
  let chrome;
  /** One tab's rows and detail as they read: each row's chip, gutter, words and lines, and the detail's decision. */
  const read = async (kind) => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const rows = [...document.querySelectorAll('#${kind}-list .srow')].map((row) => {
      const s = getComputedStyle(row), text = row.querySelector('.srow-text');
      return { id: row.dataset.row.slice(${kind.length + 1}), chip: row.querySelector('.chip')?.textContent ?? null, gutter: box(row.querySelector('code')), text: box(text), row: box(row),
        lines: Math.round(text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight)), buttons: row.querySelectorAll('button').length,
        on: row.classList.contains('on'), tint: s.backgroundColor, edges: [s.borderLeftWidth, s.borderLeftColor].join() === [s.borderRightWidth, s.borderRightColor].join() };
    });
    const detail = document.querySelector('#${kind}-detail');
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
      rows, picked: view.row['${kind}'], shown: detail.querySelector('h2 span')?.textContent ?? null, viewport: innerHeight,
      decide: [...detail.querySelectorAll('[data-row-decision]')].map((b) => ({ word: b.textContent, ...box(b) })),
      section: [...document.querySelectorAll('#${kind}-list [data-section-approve]')].map((b) => ({ word: b.textContent, height: b.getBoundingClientRect().height, head: !!b.closest('.spec-section-head') })),
    };
  })())`));
  /** A tint is quiet when its colour channels sit close together: grey, not a hue. */
  const neutral = (css) => { const [r, g, b] = (css.match(/[\d.]+/g) || []).map(Number); return Math.max(r, g, b) - Math.min(r, g, b) <= 12; };
  /** Press a key the way a keyboard does, into whatever has focus. */
  const press = async (key, code, keyCode) => {
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, ...(type === 'keyDown' && key.length === 1 ? { text: key, unmodifiedText: key } : {}) });
  };
  /** Tap an element through Chrome's input path at its centre. */
  const tap = async (selector) => {
    const point = JSON.parse(await chrome.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
    for (const type of ['mousePressed', 'mouseReleased']) await chrome.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  };
  const filter = async (kind, name) => {
    await chrome.evaluate(`document.querySelector('[data-tab=${kind}]').click(); document.querySelector('#${kind}-chips [data-rows="${kind}:${name}"]').click()`);
    await chrome.waitFor(`!document.querySelector('[data-pane=${kind}]').hidden && !!document.querySelector('#${kind}-list .srow')`);
  };
  /** A row as the board records it: Spec rows by id, Doctrine rules by id among the merged rules. */
  const recorded = async (kind, id) => {
    const state = await boardOf(view, demo.repo);
    const row = (kind === 'spec' ? state.spec : state.practice).find((entry) => entry.id === id);
    // An undecided row has no stage of its own, only its status; an approval carries no reason.
    return { stage: row?.stage || row?.status || null, decided: row?.decision ? (row.decision.reason || 'approved') : null };
  };
  const expected = { spec: { decide: [['S1', null], ['S2', 'pending'], ...eight.map((_, n) => [`S${n + 4}`, null])] }, doctrine: { decide: eight.map((_, n) => [`D${n + 1}`, null]) } };
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data?.project?.spec?.length && data.project.practice.some((r) => r.id === 'D8')");
    // Pullboard's own rules can wait on the person too; they list under Needs your decision, in the board's order, but are
    // changed in DOCTRINE.md rather than decided here.
    const order = JSON.parse(await chrome.evaluate("JSON.stringify(data.project.practice.map((r) => [r.id, r.origin, r.status, !!r.decision]))"));
    const standardWaiting = order.filter(([, origin, status, decided]) => origin === 'standard' && ['pending', 'draft'].includes(status) && !decided).map(([id, , status]) => [id, status === 'draft' ? null : status]);
    expected.doctrine.decide = [...standardWaiting, ...expected.doctrine.decide].sort(([a], [b]) => order.findIndex(([id]) => id === a) - order.findIndex(([id]) => id === b));
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        const at = `${width}px ${scheme}`;
        for (const kind of ['spec', 'doctrine']) {
          const tab = `${at} ${kind}`;
          await filter(kind, 'decide');
          let r = await read(kind);
          assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${tab}: no sideways scroll`);
          // Each row is its id in a slim gutter and its words at full width; a chip only where the status is not the filter's.
          const undecidedNow = expected[kind].decide;
          assert.deepEqual(r.rows.map((row) => [row.id, row.chip, row.buttons]), undecidedNow.map(([id, chip]) => [id, chip, 0]),
            `${tab}: drafts carry no chip under Needs your decision, an open question says pending, and no row carries a decision`);
          for (const row of r.rows) {
            assert.ok(row.gutter.width <= 52 && row.text.left - row.gutter.right <= 14 && row.row.right - row.text.right <= 12, `${tab}: ${row.id} is a slim gutter and full-width words: ${JSON.stringify(row)}`);
            if (width === 1280) assert.ok(row.lines <= 2, `${tab}: ${row.id}, one sentence, takes one or two lines: ${row.lines}`);
          }
          const picked = r.rows.find((row) => row.on);
          assert.ok(picked && neutral(picked.tint) && picked.edges, `${tab}: the picked row is a quiet neutral tint with no coloured edge: ${JSON.stringify(picked)}`);
          // On Spec, Approve all stays on the section's header.
          if (kind === 'spec') assert.deepEqual(r.section.map((b) => [b.word, b.head, b.height >= tapTarget(width)]), [[`Approve all ${undecidedNow.length} in this section`, true, true]], `${tab}: Approve all stays on the section header`);
          else assert.deepEqual(r.section, [], `${tab}: Doctrine rules are decided one at a time`);

          // With focus in the list the arrows move the pick, A approves and moves on, and D asks why, then records it.
          const [first, second, third] = undecidedNow.filter(([, chip]) => chip === null).map(([id]) => id);
          await tap(`#${kind}-list [data-row="${kind}:${first}"]`);
          await chrome.waitFor(`view.row['${kind}'] === '${first}' && document.activeElement === document.querySelector('#${kind}-list')`);
          // At 375 the detail stacks under the list: tapping a row brings its decision into view.
          if (width === 375) await chrome.waitFor(`(() => { const d = document.querySelector('#${kind}-detail [data-row-decision="approve"]')?.getBoundingClientRect(); return !!d && d.top >= 0 && d.bottom <= innerHeight; })()`, 10_000);
          // The picked row's detail holds its decision once, a 44px target each.
          const held = await read(kind);
          assert.deepEqual(held.decide.map((b) => b.word), ['Approve', 'Decline'], `${tab}: the picked row's detail holds its decision`);
          assert.ok(held.decide.every((b) => b.height >= tapTarget(width)), `${tab}: each a target, 44px where a finger taps`);
          await press('ArrowDown', 'ArrowDown', 40);
          assert.equal(await chrome.evaluate(`view.row['${kind}']`), undecidedNow[undecidedNow.findIndex(([id]) => id === first) + 1][0], `${tab}: down moves the pick`);
          await press('ArrowUp', 'ArrowUp', 38);
          assert.equal(await chrome.evaluate(`view.row['${kind}']`), first, `${tab}: and up moves it back`);
          await press('a', 'KeyA', 65);
          const after = undecidedNow[undecidedNow.findIndex(([id]) => id === first) + 1][0];
          await chrome.waitFor(`!!document.querySelector('#${kind}-list .spec-feedback.ok') && view.row['${kind}'] === '${after}'`, 15_000);
          assert.deepEqual([await recorded(kind, first), await recorded(kind, second)], [{ stage: 'approved, pending apply', decided: 'approved' }, { stage: 'draft', decided: null }],
            `${tab}: A approved the picked ${first}, and only ${first}`);
          assert.equal(await chrome.evaluate(`document.activeElement === document.querySelector('#${kind}-list')`), true, `${tab}: the list keeps focus for the next key`);
          // The pick moved on to the next row; when that is the open question, step past it to a draft.
          if (after !== second) { await press('ArrowDown', 'ArrowDown', 40); await chrome.waitFor(`view.row['${kind}'] === '${second}'`); }
          await press('d', 'KeyD', 68);
          await chrome.waitFor(`!document.querySelector('#spec-decline-dialog').hidden && document.querySelector('#spec-decline-title').textContent === 'Decline ${second}'`);
          // Never while typing in a field: an a in the reason is a letter, not an approval.
          await press('a', 'KeyA', 65);
          assert.equal(await chrome.evaluate("document.querySelector('#spec-decline-reason').value"), 'a', `${tab}: the key types into the reason`);
          assert.deepEqual(await recorded(kind, second), { stage: 'draft', decided: null }, `${tab}: and decides nothing`);
          await chrome.send('Input.insertText', { text: ' clearer outcome, please' });
          await chrome.evaluate("document.querySelector('#spec-decline-submit').click()");
          await chrome.waitFor(`document.querySelector('#spec-decline-dialog').hidden && !!document.querySelector('#${kind}-list .spec-feedback.ok')`, 15_000);
          assert.deepEqual(await recorded(kind, second), { stage: 'declined, pending apply', decided: 'a clearer outcome, please' }, `${tab}: D declined ${second} with its reason`);
          // The last layout decides the last two drafts, so only the earlier ones have a row after them to stay untouched.
          if (third) assert.deepEqual(await recorded(kind, third), { stage: 'draft', decided: null }, `${tab}: and nothing else`);
          assert.equal(await chrome.evaluate(`document.activeElement === document.querySelector('#${kind}-list')`), true, `${tab}: the dialog returns to the list`);
          // The two decided rows leave Needs your decision.
          expected[kind].decide = undecidedNow.filter(([id]) => id !== first && id !== second);
          await chrome.waitFor(`![...document.querySelectorAll('#${kind}-list .srow')].some((row) => ['${kind}:${first}', '${kind}:${second}'].includes(row.dataset.row))`, 15_000);

          // Under All rows, every row not approved says what it is.
          await filter(kind, 'all');
          r = await read(kind);
          const all = Object.fromEntries(r.rows.map((row) => [row.id, row.chip]));
          assert.deepEqual([all[first], all[second]], ['approved, pending apply', 'declined, pending apply'], `${tab}: under All rows the decided rows say so`);
          if (kind === 'spec') assert.deepEqual([all.S2, all.S3], ['pending', null], `${tab}: the open question says pending; the approved row needs no chip`);
          else assert.ok(r.rows.some((row) => row.id.startsWith('PB') && row.chip === null), `${tab}: Pullboard's own approved rules need no chip`);
        }
      }
    }

    // A rule that comes with Pullboard is changed in DOCTRINE.md, not decided here: its detail offers no decision, and A does nothing.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1280');
    await filter('doctrine', 'all');
    const standard = await chrome.evaluate("[...document.querySelectorAll('#doctrine-list .srow')].map((row) => row.dataset.row.slice(9)).find((id) => id.startsWith('PB'))");
    await tap(`#doctrine-list [data-row="doctrine:${standard}"]`);
    await chrome.waitFor(`view.row.doctrine === '${standard}' && document.activeElement === document.querySelector('#doctrine-list')`);
    assert.equal(await chrome.evaluate("document.querySelectorAll('#doctrine-detail [data-row-decision]').length"), 0, `${standard}: a standard rule's detail offers no decision`);
    await press('a', 'KeyA', 65);
    assert.equal((await recorded('doctrine', standard)).decided, null, `${standard}: A decides nothing on it`);
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the status bar holds one line under no pointer [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for status bar media checks.');

  const box = machine();
  const demo = project(box, 'pointer-none');
  for (let index = 1; index <= 3; index += 1) {
    box.run(demo.repo, 'add', 'web', `Status item ${index}`, '--specs', 'G1', '--criterion', 'visible on the board');
  }
  box.run(demo.web, 'shout', 'coordinator', 'Which status label should we use?');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-status-none-'));
  const wrapper = join(profile, 'chrome-pointer-none');
  const quotedExecutable = "'" + executable.replaceAll("'", "'\\''") + "'";
  writeFileSync(wrapper, '#!/bin/sh\nexec ' + quotedExecutable + ' --blink-settings=primaryPointerType=1,availablePointerTypes=1 "$@"\n');
  chmodSync(wrapper, 0o755);
  let chrome;
  try {
    chrome = await openSnapshotChrome(wrapper, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data && data.project?.items?.length === 3");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const layout = JSON.parse(await chrome.evaluate(`JSON.stringify({
      pointer: { none: matchMedia('(pointer: none)').matches, fine: matchMedia('(pointer: fine)').matches, coarse: matchMedia('(pointer: coarse)').matches },
      parts: [...document.querySelectorAll('.status [data-status]')].filter((button) => !button.hidden && button.getBoundingClientRect().width > 0).map((button) => {
        const rects = [...button.childNodes].flatMap((node) => {
          const range = document.createRange(); range.selectNodeContents(node);
          return [...range.getClientRects()].map((rect) => ({ top: rect.top, height: rect.height }));
        });
        const lineTops = [];
        for (const rect of rects) if (!lineTops.some((top) => Math.abs(top - rect.top) <= 2)) lineTops.push(rect.top);
        return { label: button.textContent.replace(/\\s+/g, ' ').trim(), height: button.getBoundingClientRect().height, minHeight: getComputedStyle(button).minHeight, rects, lineTops };
      })
    })`));
    console.log('375 pointer none raw layout', JSON.stringify(layout));
    assert.deepEqual(layout.pointer, { none: true, fine: false, coarse: false }, `wrapper produces real pointer:none CSS state: ${JSON.stringify(layout.pointer)}`);
    assert.ok(layout.parts.some((part) => part.label === '3 items'), `the real board's Items status part is present: ${JSON.stringify(layout.parts)}`);
    const audit = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const visible=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return !e.disabled&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0&&!e.closest('[hidden]')};
      const selector='button,a[href],input:not([type=hidden]),select,textarea,[role=button],[data-root],[data-tab],[data-go],[data-item],[data-state],[data-rows],[data-row],[data-release],[data-shout],[data-new],[data-code]';
      const controls=[...new Set(document.querySelectorAll(selector))].filter(visible).map(e=>{const r=e.getBoundingClientRect();return {text:(e.innerText||e.getAttribute('aria-label')||'').trim(),height:r.height,inlineReference:e.matches('.feed button.ref, .shout button.ref, .shout .band a, .detail button.ref')||!!e.closest('#chain .meta .gate, #detail .kv dd.waits-on'),statusBar:!!e.closest('.status')&&!matchMedia('(pointer: coarse)').matches,oneLine:!e.closest('.status')||getComputedStyle(e).whiteSpace==='nowrap'}});
      return {controls,tap:getComputedStyle(document.documentElement).getPropertyValue('--tap').trim(),wrapped:controls.filter(c=>!c.oneLine)};
    })())`));
    assert.equal(audit.tap, '32px', `with no pointer at 1280 the targets are the compact ones a mouse gets; touch keeps 44px: ${JSON.stringify(audit.controls)}`);
    assert.deepEqual(audit.wrapped, [], `the demo's visible status labels stay on one line at 1280: ${JSON.stringify(audit.controls)}`);
    assert.deepEqual(layout.parts.filter((part) => part.lineTops.length !== 1), [], `each status part occupies one text line: ${JSON.stringify(layout.parts)}`);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

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
  await chrome.evaluate(`(() => {
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
        const page = JSON.parse(await chrome.evaluate(`JSON.stringify({
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
      await chrome.evaluate('window.__pullboardSpecKeysDispose?.()');
    },
  };
}

test('real Chrome records Spec row decisions from the row, detail and confirmed section controls [B26,N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for Spec decision checks.');

  /** Click a visible control through Chrome's input path without scrolling the result away. */
  const click = async (chrome, selector) => {
    const point = JSON.parse(await chrome.evaluate(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) throw Error('missing ' + ${JSON.stringify(selector)});
      e.scrollIntoView({block:'center'});
      const r = e.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.top < 0 || r.bottom > innerHeight) throw Error('control is not visible: ' + ${JSON.stringify(selector)});
      return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});
    })()`));
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };

  /** Run the full decision story in a fresh real board and browser at one viewport width. */
  const runWidth = async (width) => {
    const rows = Array.from({ length: 29 }, (_, index) => `- G${index + 1} [draft, must] Goal ${index + 1}. | gate: web test`);
    const spec = `# Decisions\n\n## G · Goals\n${rows.join('\n')}\n\n## K · Follow-up\n- K1 [draft, must] Follow-up one. | gate: web test\n- K2 [draft, must] Follow-up two. | gate: web test\n`;
    const box = machine();
    const demo = project(box, `spec-decisions-${width}`, spec);
    const view = await startView(box);
    const profile = mkdtempSync(join(tmpdir(), `pullboard-spec-decisions-${width}-`));
    let chrome;
    let diagnostics;
    try {
      chrome = await openSnapshotChrome(executable, view.link.href, profile);
      await chrome.waitFor("typeof data === 'object' && !!data && !!data.project");
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.evaluate("document.querySelector('[data-tab=spec]').click()");
      await chrome.waitFor(`innerWidth === ${width} && !!document.querySelector('#spec-list [data-row="spec:G1"]')`);
      await chrome.evaluate("document.querySelector('#spec-chips [data-rows=\"spec:all\"]').click()");
      await chrome.waitFor("document.querySelector('#spec-list [data-row=\"spec:G2\"]') && document.querySelector('#spec-chips [data-rows=\"spec:decide\"] b')?.textContent === '31'");
      const geometry = JSON.parse(await chrome.evaluate(`JSON.stringify({
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        controls: [...document.querySelectorAll('#spec-list button[data-row-decision],#spec-list button[data-section-approve]')].map(e=>({height:e.getBoundingClientRect().height})),
        rows: [...document.querySelectorAll('#spec-list .srow')].map(row=>{
          const chip=row.querySelector('.srow-text .chip');
          const words=[...(row.querySelector('.srow-text')?.childNodes||[])].find(n=>n.nodeType===3&&n.textContent.trim());
          if (!chip || !words) return {id:row.dataset.row, missing:true};
          const range=document.createRange(); range.selectNodeContents(words);
          const a=chip.getBoundingClientRect(), b=range.getClientRects()[0];
          return {id:row.dataset.row, intersects:a.right>b.left && a.left<b.right && a.bottom>b.top && a.top<b.bottom};
        })
      })`));
      assert.equal(geometry.overflow, false, `${width}: Spec has no horizontal overflow`);
      assert.deepEqual(geometry.controls.filter((control) => control.height < tapTarget(width)), [], `${width}: row and section controls meet the target`);
      assert.deepEqual(geometry.rows.filter((row) => row.missing), [], `${width}: row status and text are present for every fixture row`);
      if (width === 1280) assert.deepEqual(geometry.rows.filter((row) => row.intersects), [], '1280: stage chips never cover row text');

      await chrome.evaluate("document.querySelector('#spec-list [data-row=\"spec:G2\"]').click()");
      await chrome.waitFor("document.querySelector('#spec-detail h2 span')?.textContent === 'G2'");
      assert.ok(await chrome.evaluate("document.querySelector('#spec-detail [data-row-decision=approve]') && document.querySelector('#spec-detail [data-row-decision=decline]')"), `${width}: selected G2 has both detail decisions`);
      diagnostics = await watchSpecDecisionWait(chrome);
      // Picked from the list, A approves G1, and the pick moves on to the next row.
      await click(chrome, '#spec-list [data-row="spec:G1"]');
      const specFocusCondition = "view.row.spec === 'G1' && document.activeElement === document.querySelector('#spec-list')";
      await diagnostics.waitFor(specFocusCondition);
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, ...(type === 'keyDown' ? { text: 'a', unmodifiedText: 'a' } : {}) });
      await chrome.waitFor("!!document.querySelector('#spec-list .spec-feedback.ok,#spec-list .spec-feedback.no')");
      let state = await boardOf(view, demo.repo);
      assert.equal(state.spec.find((row) => row.id === 'G1')?.stage, 'approved, pending apply', `${width}: A approves the picked G1`);
      assert.equal(state.spec.find((row) => row.id === 'G2')?.decision, undefined, `${width}: and nothing else`);
      await chrome.waitFor("view.row.spec === 'G2' && document.querySelector('#spec-detail h2 span')?.textContent === 'G2'");
      assert.ok(await chrome.evaluate(`(() => { const e=document.querySelector('#spec-list [data-row="spec:G2"]'); const r=e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`), `${width}: next undecided G2 stays in the viewport after G1 approval`);
      assert.equal(await chrome.evaluate("document.querySelector('#spec-chips [data-rows=\"spec:decide\"] b').textContent"), '30', `${width}: Needs your decision excludes the decided row`);
      if (width === 1280) assert.ok(await chrome.evaluate(`(() => {
        const row=document.querySelector('#spec-list [data-row="spec:G1"]');
        const chip=row.querySelector('.srow-text .chip').getBoundingClientRect();
        const words=[...row.querySelector('.srow-text').childNodes].find(n=>n.nodeType===3&&n.textContent.trim());
        const range=document.createRange(); range.selectNodeContents(words); const text=range.getClientRects()[0];
        return chip.right <= text.left || chip.bottom <= text.top || chip.top >= text.bottom;
      })()`), '1280: the approved pending stage does not cover row text');

      await chrome.evaluate("document.querySelector('#spec-chips [data-rows=\"spec:decide\"]').click()");
      assert.equal(await chrome.evaluate("!!document.querySelector('#spec-list [data-row=\"spec:G1\"]')"), false, `${width}: approval immediately leaves Needs your decision`);
      await chrome.evaluate("document.querySelector('#spec-chips [data-rows=\"spec:all\"]').click()");

      await click(chrome, '#spec-detail [data-row-decision="decline"]');
      assert.ok(await chrome.evaluate("!document.querySelector('#spec-decline-dialog').hidden && document.querySelector('#spec-decline-title').textContent === 'Decline G2'"), `${width}: G2 decline opens the reason form`);
      assert.ok(await chrome.evaluate(`[...document.querySelectorAll('#spec-decline-dialog input,#spec-decline-dialog button')].every(e => e.getBoundingClientRect().height >= ${tapTarget(width)})`), `${width}: decline reason and controls meet the 44px target`);
      await click(chrome, '#spec-decline-cancel');
      state = await boardOf(view, demo.repo);
      assert.equal(state.events.filter((event) => event.event_kind === 'row_decision').length, 1, `${width}: cancelling decline records no event`);
      assert.equal(state.spec.find((row) => row.id === 'G2')?.decision, undefined, `${width}: cancelling leaves G2 undecided`);

      await click(chrome, '#spec-detail [data-row-decision="decline"]');
      await chrome.evaluate("document.querySelector('#spec-decline-reason').value = 'Needs a clearer outcome'");
      box.run(demo.repo, 'shout', 'person', `refresh probe ${width}`);
      await chrome.waitFor(`data.project.shouts.some(shout => shout.shout_text === 'refresh probe ${width}')`);
      assert.equal(await chrome.evaluate("document.querySelector('#spec-decline-reason').value"), 'Needs a clearer outcome', `${width}: typed reason survives a live refresh`);
      await click(chrome, '#spec-decline-submit');
      await chrome.waitFor("!!document.querySelector('#spec-detail .spec-feedback.ok,#spec-detail .spec-feedback.no')");

      await chrome.evaluate("window.__sectionConfirm = null; window.confirm = message => { window.__sectionConfirm = message; return false; }");
      const sectionSelector = `#spec-list [data-section-approve]`;
      await chrome.evaluate(`(() => { const button=[...document.querySelectorAll(${JSON.stringify(sectionSelector)})].find(e=>e.parentElement.querySelector('h4')?.textContent.includes('Follow-up')); if(!button) throw Error('missing K section approval'); button.click(); })()`);
      state = await boardOf(view, demo.repo);
      assert.match(await chrome.evaluate('window.__sectionConfirm'), /Approve all 2 undecided rows in/, `${width}: section approval asks for confirmation`);
      assert.equal(await chrome.evaluate("!!document.querySelector('#spec-list .spec-feedback')"), false, `${width}: dismissing the confirmation starts no move`);
      assert.equal(state.events.filter((event) => event.event_kind === 'row_decision').length, 2, `${width}: dismissing section confirmation records no events`);
      assert.equal(state.spec.find((row) => row.id === 'K1')?.decision, undefined, `${width}: dismissed section approval leaves K1 undecided`);

      await chrome.evaluate("window.confirm = () => true");
      await chrome.evaluate(`(() => { const button=[...document.querySelectorAll(${JSON.stringify(sectionSelector)})].find(e=>e.parentElement.querySelector('h4')?.textContent.includes('Follow-up')); if(!button) throw Error('missing K section approval'); button.click(); })()`);
      await chrome.waitFor("document.querySelector('#spec-list [data-row=\"spec:K1\"]').innerText.includes('approved, pending apply') && document.querySelector('#spec-list [data-row=\"spec:K2\"]').innerText.includes('approved, pending apply')");
      state = await boardOf(view, demo.repo);
      const decisions = state.events.filter((event) => event.event_kind === 'row_decision');
      assert.equal(decisions.length, 4, `${width}: approve, decline and two section rows produce four events`);
      assert.deepEqual(decisions.map((event) => event.event_by), ['person', 'person', 'person', 'person'], `${width}: every decision is recorded by the person`);
      assert.deepEqual(decisions.map((event) => JSON.parse(event.event_detail).channel), ['view', 'view', 'view', 'view'], `${width}: every decision uses the view channel`);
      assert.equal(state.spec.find((row) => row.id === 'G2')?.stage, 'declined, pending apply', `${width}: G2 shows its pending decline stage`);
      assert.equal(state.spec.find((row) => row.id === 'G2')?.decision?.reason, 'Needs a clearer outcome', `${width}: decline reason is in board state`);
      assert.equal(state.spec.find((row) => row.id === 'K1')?.stage, 'approved, pending apply', `${width}: K1 was approved`);
      assert.equal(state.spec.find((row) => row.id === 'K2')?.stage, 'approved, pending apply', `${width}: K2 was approved`);
      assert.equal(state.spec.find((row) => row.id === 'G3')?.decision, undefined, `${width}: other section rows remain undecided`);
      if (width === 1280) assert.ok(await chrome.evaluate(`['G1','G2','K1','K2'].every(id => {
        const row=document.querySelector('#spec-list [data-row="spec:'+id+'"]');
        const chip=row.querySelector('.srow-text .chip').getBoundingClientRect();
        const words=[...row.querySelector('.srow-text').childNodes].find(n=>n.nodeType===3&&n.textContent.trim());
        const range=document.createRange(); range.selectNodeContents(words); const text=range.getClientRects()[0];
        return chip.right <= text.left || chip.bottom <= text.top || chip.top >= text.bottom;
      })`), '1280: every pending decision stage has room beside its row text');
      await chrome.evaluate("document.querySelector('#spec-chips [data-rows=\"spec:decide\"]').click()");
      await chrome.waitFor("document.querySelector('#spec-list [data-row=\"spec:G3\"]') && !document.querySelector('#spec-list [data-row=\"spec:G1\"]') && !document.querySelector('#spec-list [data-row=\"spec:G2\"]') && !document.querySelector('#spec-list [data-row=\"spec:K1\"]') && !document.querySelector('#spec-list [data-row=\"spec:K2\"]')");
      assert.ok(await chrome.evaluate("document.querySelector('#spec-chips [data-rows=\"spec:decide\"]').innerText.includes('27')"), `${width}: Needs your decision excludes all four decided rows`);
      assert.deepEqual(chrome.exceptions, [], `${width}: Chrome reports no uncaught exceptions`);
    } finally {
      try { await diagnostics?.dispose(); }
      finally {
        try { if (chrome) await closeSnapshotChrome(chrome); }
        finally {
          try { await view.stop(); }
          finally { rmSync(profile, { recursive: true, force: true }); }
        }
      }
    }
  };

  await runWidth(375);
  await runWidth(1280);
});

test('the spec decision wait names its state on timeout [N26]', { timeout: 60_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for Spec wait diagnostics.');

  const spec = '# Timeout probe\n\n## G · Goals\n- G1 [draft, must] First goal. | gate: web test\n- G2 [draft, must] Second goal. | gate: web test\n';
  const box = machine();
  const demo = project(box, 'spec-wait-timeout', spec);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-spec-timeout-'));
  let chrome;
  let diagnostics;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data?.project");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.evaluate("document.querySelector('[data-tab=spec]').click()");
    await chrome.waitFor("!!document.querySelector('#spec-list [data-row=\"spec:G1\"]') && !!document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    diagnostics = await watchSpecDecisionWait(chrome);
    const point = JSON.parse(await chrome.evaluate(`(() => {
      const row=document.querySelector('#spec-list [data-row="spec:G1"]');
      row.scrollIntoView({block:'center'});
      const r=row.getBoundingClientRect();
      return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});
    })()`));
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await chrome.waitFor("view.row.spec === 'G1' && document.activeElement === document.querySelector('#spec-list')");
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await chrome.waitFor("view.row.spec === 'G2'");

    let timeout;
    try { await diagnostics.waitFor('false', 10); } catch (error) { timeout = error; }
    assert.match(timeout?.message ?? '', /Browser condition did not arrive: false/, 'the test deliberately drives the real wait helper to timeout');
    assert.deepEqual(timeout.diagnostic.selectedRow, 'G2', 'the timeout record names the currently selected row');
    assert.equal(timeout.diagnostic.focusedElement.id, 'spec-list', 'the timeout record names the focused list');
    assert.ok(Array.isArray(timeout.diagnostic.pendingRequests), 'the timeout record includes bounded in-flight requests');
    assert.deepEqual(timeout.diagnostic.lastKeyEvents.slice(-2).map(({ type, key, code }) => [type, key, code]), [
      ['keydown', 'ArrowDown', 'ArrowDown'], ['keyup', 'ArrowDown', 'ArrowDown'],
    ], 'the timeout record includes the last real key events');
  } finally {
    try { await diagnostics?.dispose(); }
    finally {
      try { if (chrome) await closeSnapshotChrome(chrome); }
      finally {
        try { rmSync(profile, { recursive: true, force: true }); }
        finally { await view.stop(); }
      }
    }
  }
});

test('static export redacts structured checkout paths but preserves paths people wrote [A10]', async () => {
  const box = machine();
  const alpha = project(box, 'private-project');
  box.run(alpha.repo, 'add', 'web', 'Private checkout item', '--specs', 'G1', '--criterion', 'exports without checkout paths');
  const projectRoot = alpha.repo;
  const worktreeRoot = alpha.web;
  const commonGitDir = box.git(alpha.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const live = await startView(box);
  try {
    const listingResponse = await fetchLive(`${live.base}/api/v1/boards`, { headers: { 'x-pullboard-key': live.key } });
    assert.equal(listingResponse.status, 200);
    const listing = await listingResponse.json();
    const board = listing.boards.find((entry) => entry.root === projectRoot);
    assert.ok(board, 'the live listing keeps the absolute project root');
    assert.equal(board.root, projectRoot);
    const state = await boardOf(live, projectRoot);
    assert.equal(state.root, projectRoot, 'live state keeps the absolute root');
    const agent = state.agents.find((entry) => entry.agent_id === 'web-1');
    assert.ok(agent);
    assert.equal(agent.agent_path, worktreeRoot, 'live state keeps the agent worktree path');
    assert.equal(box.git(alpha.web, 'rev-parse', '--path-format=absolute', '--git-common-dir'), commonGitDir,
      'the linked worktree still shares the repository common Git directory');
    const boardEvents = await fetchLive(`${live.base}/api/v1/boards/${board.id}/events`, { headers: { 'x-pullboard-key': live.key } });
    assert.equal(boardEvents.status, 200);
    const events = await boardEvents.json();
    assert.ok(events.events.length > 0);

    /** Enumerate every exported file, including the API document subtree. */
    const filesBelow = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    });
    /** Read all bytes so an unexpected exported field cannot hide a private folder. */
    const exportedText = (directory) => filesBelow(directory).map((path) => readFileSync(path, 'utf8')).join('\n');
    const snapshot = join(box.dir, 'export-structured');
    box.run(alpha.repo, 'view', '--export', snapshot);
    const structuredFiles = exportedText(snapshot);
    for (const privatePath of [box.dir, projectRoot, worktreeRoot, commonGitDir]) {
      assert.ok(!structuredFiles.includes(privatePath), `export does not include structured path ${privatePath}`);
    }

    // A second export deliberately includes paths in human-authored prose. Those exact values are
    // the only allowed occurrences; project.root, agent_path and common Git metadata stay redacted.
    const brief = `Keep this literal checkout reference: ${projectRoot}`;
    const shout = `Please inspect this literal agent folder: ${worktreeRoot}`;
    box.run(alpha.repo, 'add', 'web', 'Path in prose', '--specs', 'G1', '--criterion', 'keeps prose literal', '--brief', brief);
    box.run(alpha.web, 'shout', 'all', shout);
    const proseSnapshot = join(box.dir, 'export-prose');
    box.run(alpha.repo, 'view', '--export', proseSnapshot);
    const stateFile = JSON.parse(readFileSync(join(proseSnapshot, 'api', 'v1', 'boards', board.id, 'state.json'), 'utf8')).state;
    assert.notEqual(stateFile.root, projectRoot, 'export redacts structured project root');
    assert.notEqual(stateFile.agents.find((entry) => entry.agent_id === 'web-1').agent_path, worktreeRoot,
      'export redacts the structured agent worktree');
    assert.equal(stateFile.items.find((entry) => entry.title === 'Path in prose').brief, brief);
    assert.ok(stateFile.shouts.some((entry) => entry.shout_text === shout), 'the authored shout remains literal');
    const proseFiles = filesBelow(proseSnapshot).map((path) => readFileSync(path, 'utf8'));
    let scrubbedText = proseFiles.join('\n');
    for (const text of [brief, shout]) {
      scrubbedText = scrubbedText.replaceAll(JSON.stringify(text), '"<authored prose>"')
        .replaceAll(JSON.stringify(JSON.stringify(text)).slice(1, -1), '<authored event prose>');
    }
    for (const privatePath of [box.dir, projectRoot, worktreeRoot, commonGitDir]) {
      assert.ok(!scrubbedText.includes(privatePath), `outside authored prose, export does not include ${privatePath}`);
    }
  } finally {
    await live.stop();
  }
});

test('a short code chip at a line end stays whole, and long code stays one chip inside the screen [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for code chip checks.');

  const box = machine();
  const demo = project(box, 'chip-ends');
  const long = 'docs/a/very/long/path/that/keeps/going/well/past/any/phone/screen/width.md';
  box.run(demo.repo, 'shout', 'all', `Pass the --flag option, then read ${long} before you submit.`);
  // Twenty-four wide characters are short by count but take two columns each: about 320px of one chip.
  const wide = '中文'.repeat(12);
  box.run(demo.repo, 'shout', 'all', 'Wide code `' + wide + '` wraps too.');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-chip-end-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!document.querySelector(\'[data-tab="shouts"]\')');
    await chrome.evaluate('document.querySelector(\'[data-tab="shouts"]\').click()');
    await chrome.waitFor(`[...document.querySelectorAll('#feed code.inline')].some((code) => code.textContent === ${JSON.stringify(wide)})`);
    for (const width of [320, 375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      const seen = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
        const chips = [...document.querySelectorAll('#feed code.inline')];
        const flag = chips.find((code) => code.textContent === '--flag'), path = chips.find((code) => code.textContent === ${JSON.stringify(long)});
        const text = flag.parentElement.closest('div');
        // Long code stays one chip, cut short with an ellipsis where the line is shorter, and inside the screen.
        const pathRects = [...path.getClientRects()];
        // Measured where the chips live: no shout's text runs wider than its column. (The page as a whole is
        // other lanes' layout; at 320 on Linux a 15px scrollbar leaves 305px for it.)
        const longCode = { fragments: pathRects.length, title: path.title, right: Math.max(...pathRects.map((r) => r.right)), screen: document.documentElement.clientWidth,
          overflow: [...document.querySelectorAll('#feed .shout .text')].some((column) => column.scrollWidth > column.clientWidth + 0.5) };
        const wideRects = [...chips.find((code) => code.textContent === ${JSON.stringify(wide)}).getClientRects()];
        const wideCode = { fragments: wideRects.length, right: Math.max(...wideRects.map((r) => r.right)), screen: document.documentElement.clientWidth };
        // Then end the chip's line three pixels inside the chip, whatever this machine's fonts measure.
        const start = text.getBoundingClientRect().left, end = flag.getBoundingClientRect().right, line = text.getBoundingClientRect().width;
        text.style.width = (end - start - 3) + 'px';
        const rects = [...flag.getClientRects()];
        const atEnd = { fragments: rects.length, display: getComputedStyle(flag).display, width: Math.max(...rects.map((r) => r.width)), line };
        text.style.width = '';
        return { atEnd, longCode, wideCode };
      })())`));
      assert.equal(seen.atEnd.fragments, 1, `${width}: a short chip at a line's end moves to the next line whole, never broken after its "--": ${JSON.stringify(seen)}`);
      assert.equal(seen.atEnd.display, 'inline', `${width}: and it is still inline code, not a bar`);
      assert.ok(seen.atEnd.width < seen.atEnd.line / 2, `${width}: and compact: ${JSON.stringify(seen.atEnd)}`);
      assert.deepEqual([seen.longCode.fragments, seen.longCode.title], [1, long], `${width}: code longer than its line stays one chip, the whole of it on hover: ${JSON.stringify(seen.longCode)}`);
      assert.equal(seen.wideCode.fragments, 1, `${width}: so does code of wide characters: ${JSON.stringify(seen.wideCode)}`);
      assert.ok(seen.wideCode.right <= seen.wideCode.screen + 0.5, `${width}: inside the screen, by the columns it takes: ${JSON.stringify(seen.wideCode)}`);
      assert.ok(seen.longCode.right <= seen.longCode.screen + 0.5 && !seen.longCode.overflow, `${width}: and never runs past the screen: ${JSON.stringify(seen.longCode)}`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('real Chrome styles shout code and item text without growing linked lines [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for rendered shout checks.');

  const box = machine();
  const alpha = project(box, 'shout-code');
  const title = 'A `title` <img src=x onerror=alert(1)> #1';
  box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'Criterion `value` stays safe', '--brief', 'Run $ pullboard claim 1\nKeep `<safe>` literal.');
  box.run(alpha.web, 'claim', '1');
  const sourceHead = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const sample = 'Inline `code <b>safe</b>`; pullboard shout --decision; --flag; src/cockpit.js; 0123456789abcdef0123456789abcdef01234567.\nPreview SPEC.md:1-2@' + sourceHead + '. Invalid prefix:SPEC.md:1-2@' + sourceHead + '.\n```js\n<script>alert(1)</script>\n```\n$ pullboard claim 1\n<script>alert(1)</script>';
  const wrappedLinkedText = 'This deliberately long linked sample wraps across lines so text length does not define line height. '.repeat(3) + '#1';
  box.run(alpha.repo, 'shout', 'person', sample, '--decision');
  box.run(alpha.web, 'shout', 'coordinator', 'A linked line #1');
  box.run(alpha.web, 'shout', 'coordinator', 'A plain line here');
  box.run(alpha.web, 'shout', 'coordinator', 'X #1');
  box.run(alpha.web, 'shout', 'coordinator', 'X');
  box.run(alpha.web, 'shout', 'coordinator', wrappedLinkedText);
  box.run(alpha.web, 'shout', 'coordinator', 'OK');
  box.run(alpha.web, 'shout', 'coordinator', '<script>alert(2)</script> outside code');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-shout-code-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    const consoleErrors = [];
    chrome.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') consoleErrors.push(message.params.entry.text);
    });
    await chrome.send('Log.enable');
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.shouts?.length >= 4 && document.querySelectorAll("#feed > .shout").length >= 4');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1280 && document.querySelector("#detail .text.muted code.inline")?.getBoundingClientRect().width > 0');
    const desktopBrief = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const code=document.querySelector('#detail .text.muted code.inline'), line=code?.parentElement;
      const rect=code?.getBoundingClientRect(), lineRect=line?.getBoundingClientRect();
      return {display:code&&getComputedStyle(code).display,width:rect?.width,lineWidth:lineRect?.width};
    })())`));
    assert.equal(desktopBrief.display, 'inline', `1280px brief code computes inline: ${JSON.stringify(desktopBrief)}`);
    assert.ok(desktopBrief.width > 0 && desktopBrief.width < desktopBrief.lineWidth / 2, `1280px brief code is a compact chip: ${JSON.stringify(desktopBrief)}`);
    await chrome.evaluate("document.querySelector('#new-item').click()");
    await chrome.waitFor("!document.querySelector('#add-form').hidden && getComputedStyle(document.querySelector('#add-form')).display === 'grid'");
    const desktopForm = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const form=document.querySelector('#add-form'), box=form.getBoundingClientRect();
      const fields=[...form.querySelectorAll('label')].map(field=>{const r=field.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};});
      return {display:getComputedStyle(form).display,box:{left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height},fields,actions:getComputedStyle(form.querySelector('.actions')).display};
    })())`));
    assert.equal(desktopForm.display, 'grid', `1280px add-item form keeps its grid: ${JSON.stringify(desktopForm)}`);
    assert.equal(desktopForm.actions, 'flex', `1280px add-item actions keep their row: ${JSON.stringify(desktopForm)}`);
    assert.equal(desktopForm.fields.length, 5, '1280px add-item form keeps all five fields');
    assert.ok(desktopForm.fields.every((field, index, fields) => field.width > 0 && field.left >= desktopForm.box.left && field.right <= desktopForm.box.right && field.top >= desktopForm.box.top && field.bottom <= desktopForm.box.bottom && (index === 0 || field.top >= fields[index - 1].bottom)), `1280px add-item fields remain a non-overlapping grid: ${JSON.stringify(desktopForm)}`);
    await chrome.evaluate("document.querySelector('#add-cancel').click()");
    await chrome.waitFor("document.querySelector('#add-form').hidden");
    await chrome.evaluate(`document.querySelector('[data-tab="shouts"]').click()`);

    const rendered = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const shout = [...document.querySelectorAll('#feed > .shout')].find((row) => row.textContent.includes('Inline'));
      const shoutCode=[...(shout?.querySelectorAll('code.inline')||[])].find(code=>code.textContent==='--flag'), shoutLine=shout?.querySelector('.text');
      const shoutRect=shoutCode?.getBoundingClientRect(), shoutLineRect=shoutLine?.getBoundingClientRect();
      const ask = [...document.querySelectorAll('#decisions .shout')].find((row) => row.textContent.includes('Inline'));
      const titleNode = document.querySelector('#chain .row .t');
      const outside = [...document.querySelectorAll('#feed > .shout')].find((row) => row.textContent.includes('alert(2)'));
      const itemDetail = document.querySelector('#detail');
      const agentItem = document.querySelector('#agents .agent-row');
      /** Measure the complete rendered content line box, including its item link. */
      const lineMetrics = (message) => {
        const row = [...document.querySelectorAll('#feed > .shout')].find((entry) => {
          const content = entry.querySelector('.text');
          return content && content.textContent.trim() === message;
        });
        const content = row.querySelector('.text');
        const height = content.getBoundingClientRect().height;
        const lineHeight = parseFloat(getComputedStyle(content).lineHeight);
        return { height, lineHeight, lines: Math.round(height / lineHeight) };
      };
      return {
        shoutHtml: shout.innerHTML, shoutScripts: shout.querySelectorAll('script').length,
        shoutCodeMetrics: {display:shoutCode&&getComputedStyle(shoutCode).display,width:shoutRect?.width,lineWidth:shoutLineRect?.width},
        askHtml: ask.innerHTML, titleHtml: titleNode.innerHTML,
        linkedMetrics: lineMetrics('X #1'), plainMetrics: lineMetrics('X'),
        wrapLinked: lineMetrics(${JSON.stringify(wrappedLinkedText)}), wrapPlain: lineMetrics('OK'),
        linkedButtons: [...document.querySelectorAll('#feed > .shout')].find((entry) => entry.textContent.includes('A linked line'))?.querySelectorAll('button.ref').length,
        previewLinks: shout.querySelectorAll('button[data-code^="SPEC.md:1-2@"]').length,
        outsideHtml: outside.innerHTML, askNestedButtons: [...ask.querySelectorAll('button')].filter(link => link.parentElement.closest('button')).length,
        criterionHtml: itemDetail.querySelector('.text')?.innerHTML, briefHtml: itemDetail.querySelector('.text.muted')?.innerHTML,
        needsNestedButtons: [...document.querySelectorAll('#needs button.ref')].filter(link => link.parentElement.closest('button')).length,
        agentNestedButtons: [...document.querySelectorAll('#agents button.ref')].filter(link => link.parentElement.closest('button')).length,
        agentItemHeight: agentItem?.getBoundingClientRect().height,
      };
    })())`));
    assert.equal(rendered.shoutCodeMetrics.display, 'inline', `1280px shout code computes inline: ${JSON.stringify(rendered.shoutCodeMetrics)}`);
    assert.ok(rendered.shoutCodeMetrics.width > 0 && rendered.shoutCodeMetrics.width < rendered.shoutCodeMetrics.lineWidth / 2,
      `1280px shout code is a compact chip: ${JSON.stringify(rendered.shoutCodeMetrics)}`);
    assert.match(rendered.shoutHtml, /<code class="inline">code &lt;b&gt;safe&lt;\/b&gt;<\/code>/, 'backticks create escaped inline code');
    assert.match(rendered.shoutHtml, /<code class="inline cmd(?: long" title="pullboard shout --decision)?">pullboard shout --decision<\/code>/, 'a pullboard command is inline code, with the flags that follow it');
    assert.match(rendered.shoutHtml, /<code class="inline cmd">--flag<\/code>/, 'a flag on its own is a command chip');
    assert.match(rendered.shoutHtml, /<code class="inline path">src\/cockpit\.js<\/code>/, 'slash paths are path chips');
    assert.match(rendered.shoutHtml, /<code class="inline sha" title="0123456789abcdef0123456789abcdef01234567">0123456789<\/code>/, 'a hex SHA is a ten-character chip with the whole SHA on hover');
    assert.ok((rendered.shoutHtml.match(/<code class="code block">/g) ?? []).length >= 2, 'fences and dollar-prefixed lines are code blocks');
    assert.match(rendered.shoutHtml, /<code class="code block">\$ pullboard claim 1<\/code>/, 'the shell prompt stays visible in command blocks');
    assert.match(rendered.shoutHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'script text is escaped inside code');
    assert.equal(rendered.shoutScripts, 0, 'a shout cannot create a script element');
    assert.match(rendered.outsideHtml, /&lt;script&gt;alert\(2\)&lt;\/script&gt; outside code/, 'script text outside code is escaped too');
    assert.equal(rendered.previewLinks, 1, 'only a path:lines@SHA reference with the original whole-word boundaries becomes an actionable preview');
    assert.match(rendered.shoutHtml, /Invalid prefix:<code class="inline long" title="SPEC\.md:1-2@[0-9a-f]+">SPEC\.md:1-2@/, 'a path:lines@SHA suffix after a colon stays plain inline code');
    await chrome.evaluate(`document.querySelector('#feed button[data-code^="SPEC.md:1-2@"]').click()`);
    await chrome.waitFor(`document.querySelector('#feed button[data-code^="SPEC.md:1-2@"]').getAttribute('aria-expanded') === 'true'`);
    await chrome.waitFor(`document.querySelector('#feed button[data-code^="SPEC.md:1-2@"] + .code-ref .code-wrap > .code')?.textContent.includes('Demo spec')`);
    assert.match(await chrome.evaluate(`document.querySelector('#feed button[data-code^="SPEC.md:1-2@"] + .code-ref .code-wrap > .code')?.textContent || ''`), /Demo spec/, 'the original code preview still opens its referenced lines');
    assert.match(rendered.askHtml, /<code class="inline cmd(?: long" title="pullboard shout --decision)?">pullboard shout --decision<\/code>/, 'needs-you uses the same code renderer');
    assert.equal(rendered.askNestedButtons, 0, 'formatted text in an ask cannot nest interactive controls');
    assert.equal(rendered.needsNestedButtons, 0, 'needs-you keeps its button markup valid');
    assert.equal(rendered.agentNestedButtons, 0, 'agent item buttons never nest reference controls');
    assert.ok(rendered.agentItemHeight >= 44, 'agent item controls keep a 44px touch target');
    assert.match(rendered.titleHtml, /<code class="inline">title<\/code>/, 'item titles use the same code renderer');
    assert.match(rendered.titleHtml, /&lt;img src=x onerror=alert\(1\)&gt;/, 'item text remains escaped');
    assert.match(rendered.criterionHtml, /<code class="inline">value<\/code>/, 'criterion text uses the renderer');
    assert.match(rendered.briefHtml, /<code class="inline">&lt;safe&gt;<\/code>/, 'brief text uses the renderer without interpreting markup');
    assert.equal(rendered.linkedButtons, 1, 'the compared row contains a rendered item link');
    assert.equal(rendered.linkedMetrics.lines, 1, 'the short linked sample occupies one desktop line');
    assert.equal(rendered.plainMetrics.lines, 1, 'the short plain sample occupies one desktop line');
    assert.ok(Math.abs(rendered.linkedMetrics.height - rendered.plainMetrics.height) < 1, 'the complete one-line desktop boxes match within 1px');
    assert.ok(Math.abs(rendered.linkedMetrics.height - rendered.linkedMetrics.lineHeight) < 1, 'the linked desktop box equals one computed line-height');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375 && document.querySelector("#feed > .shout")?.getBoundingClientRect().width > 0');
    await chrome.evaluate("document.querySelector('[data-tab=items]').click()");
    await chrome.waitFor('document.querySelector("[data-pane=items]:not([hidden])") && document.querySelector("#detail .text.muted code.inline")?.getBoundingClientRect().width > 0');
    const phoneBrief = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const code=document.querySelector('#detail .text.muted code.inline'), line=code?.parentElement;
      const rect=code?.getBoundingClientRect(), lineRect=line?.getBoundingClientRect();
      return {display:code&&getComputedStyle(code).display,width:rect?.width,lineWidth:lineRect?.width};
    })())`));
    assert.equal(phoneBrief.display, 'inline', `375px brief code computes inline: ${JSON.stringify(phoneBrief)}`);
    assert.ok(phoneBrief.width > 0 && phoneBrief.width < phoneBrief.lineWidth / 2, `375px brief code is a compact chip: ${JSON.stringify(phoneBrief)}`);
    await chrome.evaluate("document.querySelector('#new-item').click()");
    await chrome.waitFor("!document.querySelector('#add-form').hidden && getComputedStyle(document.querySelector('#add-form')).display === 'grid'");
    const phoneForm = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const form=document.querySelector('#add-form'), box=form.getBoundingClientRect();
      const fields=[...form.querySelectorAll('label')].map(field=>{const r=field.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};});
      return {display:getComputedStyle(form).display,box:{left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height},fields,actions:getComputedStyle(form.querySelector('.actions')).display};
    })())`));
    assert.equal(phoneForm.display, 'grid', `375px add-item form keeps its grid: ${JSON.stringify(phoneForm)}`);
    assert.equal(phoneForm.actions, 'flex', `375px add-item actions keep their row: ${JSON.stringify(phoneForm)}`);
    assert.equal(phoneForm.fields.length, 5, '375px add-item form keeps all five fields');
    assert.ok(phoneForm.fields.every((field, index, fields) => field.width > 0 && field.left >= phoneForm.box.left && field.right <= phoneForm.box.right && field.top >= phoneForm.box.top && field.bottom <= phoneForm.box.bottom && (index === 0 || field.top >= fields[index - 1].bottom)), `375px add-item fields remain a non-overlapping grid: ${JSON.stringify(phoneForm)}`);
    await chrome.evaluate("document.querySelector('#add-cancel').click()");
    await chrome.waitFor("document.querySelector('#add-form').hidden");
    await chrome.evaluate("document.querySelector('[data-tab=shouts]').click()");
    await chrome.waitFor('document.querySelector("[data-pane=shouts]:not([hidden])") && document.querySelector("#feed code.inline")?.getBoundingClientRect().width > 0');
    const phoneMetrics = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      /** Measure the complete rendered content line box, including its item link. */
      const lineMetrics = (message) => {
        const row = [...document.querySelectorAll('#feed > .shout')].find((entry) => {
          const content = entry.querySelector('.text');
          return content && content.textContent.trim() === message;
        });
        const content = row.querySelector('.text');
        const height = content.getBoundingClientRect().height;
        const lineHeight = parseFloat(getComputedStyle(content).lineHeight);
        return { height, lineHeight, lines: Math.round(height / lineHeight) };
      };
      const row=[...document.querySelectorAll('#feed > .shout')].find(entry=>entry.textContent.includes('Inline'));
      const code=[...(row?.querySelectorAll('code.inline')||[])].find(entry=>entry.textContent==='--flag'), line=row?.querySelector('.text'), codeRect=code?.getBoundingClientRect(), lineRect=line?.getBoundingClientRect();
      return { linked: lineMetrics('X #1'), plain: lineMetrics('X'), wrapLinked: lineMetrics(${JSON.stringify(wrappedLinkedText)}), wrapPlain: lineMetrics('OK'), shoutCode:{display:code&&getComputedStyle(code).display,width:codeRect?.width,lineWidth:lineRect?.width} };
    })())`));
    assert.equal(phoneMetrics.shoutCode.display, 'inline', `375px shout code computes inline: ${JSON.stringify(phoneMetrics.shoutCode)}`);
    assert.ok(phoneMetrics.shoutCode.width > 0 && phoneMetrics.shoutCode.width < phoneMetrics.shoutCode.lineWidth / 2,
      `375px shout code is a compact chip: ${JSON.stringify(phoneMetrics.shoutCode)}`);
    assert.equal(phoneMetrics.linked.lines, 1, 'the short linked sample occupies one phone line');
    assert.equal(phoneMetrics.plain.lines, 1, 'the short plain sample occupies one phone line');
    assert.ok(Math.abs(phoneMetrics.linked.height - phoneMetrics.plain.height) < 1, 'the complete one-line phone boxes match within 1px');
    assert.ok(Math.abs(phoneMetrics.linked.height - phoneMetrics.linked.lineHeight) < 1, 'the linked phone box equals one computed line-height');
    assert.ok(phoneMetrics.wrapLinked.lines > 1, 'the long linked probe actually wraps at 375px');
    assert.equal(phoneMetrics.wrapPlain.lines, 1, 'the short plain wrap probe remains on one line');
    assert.ok(Math.abs(phoneMetrics.wrapLinked.height / phoneMetrics.wrapLinked.lines - phoneMetrics.wrapPlain.lineHeight) < 1,
      'normalizing the forced wrap by its rendered line count proves the same per-line height');
    assert.ok(Math.abs(phoneMetrics.wrapLinked.height - phoneMetrics.wrapPlain.height) >= 1,
      'the old whole-text-box comparison would fail on the deliberately wrapped sample');
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception on its first load');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

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

/** Put the page in a width and a colour scheme, and wait for the shouts to lay out again. */
async function shoutsAt(chrome, width, scheme) {
  await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches && document.querySelector('#feed .shout')?.getBoundingClientRect().width > 0`);
  await chrome.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
}

test('shouts read as cards [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for rendered shout checks.');

  const box = machine();
  const alpha = project(box, 'cards');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G1', '--criterion', 'says goodbye');
  box.run(alpha.web, 'claim', '1');
  const second = join(box.dir, 'cards-web-2');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/cards2');
  box.run(second, 'join', 'web');
  // A committed page at a path too long for a phone, for a code reference to name.
  const deep = 'docs/a/very/long/path/that/keeps/going/past/a/phone/screen.md';
  mkdirSync(join(alpha.repo, deep, '..'), { recursive: true });
  writeFileSync(join(alpha.repo, deep), 'Deep line one\n');
  box.git(alpha.repo, 'add', deep);
  box.git(alpha.repo, 'commit', '-q', '-m', 'docs: a deep page');
  const head = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const lines = (first, n) => [first, ...Array.from({ length: n - 1 }, (_, k) => `Line ${k + 2} of the note.`)].join('\n');
  const older = 'Started on #1 two days back.';
  const colour = lines('Which colour for the button? #99 is no item.', 8);
  const ship = 'Ship #1 today?';
  const chips = `See #1 in src/cockpit.js at ${sha}; run pullboard check --json, then \`npm test\`.`;
  const long = lines('A long note that folds.', 12);
  const mixed = 'Moved #2 along.';
  const longCommand = 'node bin/run-tests.js test/relay-person-requests.test.js', longPath = 'test/relay-person-requests.test.js';
  const longerPath = 'docs/a/very/long/path/that/keeps/going/well/past/any/phone/screen/width.md';
  const longChips = `Ran \`${longCommand}\` on ${longPath} and ${longerPath} today.`;
  const sourceRefs = [`SPEC.md:1-2@${head}`, `${deep}:1@${head}`];
  const refsShout = `Check ${sourceRefs[0]} and ${sourceRefs[1]} before you merge.`;
  const blockShout = `Evidence for the page:\n${sourceRefs[0]}`;
  const twoDays = new Date(); twoDays.setDate(twoDays.getDate() - 2); twoDays.setHours(12, 0, 0, 0);
  earlier(alpha.repo, twoDays, (board) => shoutOnBoard(board, { from: 'web-1', to: 'coordinator', text: older, lanes: ['web'] }));
  earlier(alpha.repo, Date.now() - 65 * 60e3, (board) => shoutOnBoard(board, { from: 'web-2', to: 'coordinator', text: colour, decision: true, lanes: ['web'] }));
  earlier(alpha.repo, Date.now() - 125e3, (board) => shoutOnBoard(board, { from: 'web-1', to: 'coordinator', text: ship, decision: true, lanes: ['web'] }));
  const asked = JSON.parse(box.run(alpha.repo, 'decisions', '--json')).decisions.find((d) => d.shout_text === ship);
  box.run(alpha.repo, 'answer', String(asked.shout_id), 'Yes, ship it.');
  box.run(alpha.web, 'shout', 'all', 'the page loads in 80ms', '--evidence', 'receipt', '--outcome', 'measured 80ms', '--item', '1', '--commit', head);
  box.run(alpha.web, 'shout', 'all', chips);
  box.run(alpha.web, 'shout', 'all', mixed, '--evidence', 'receipt', '--outcome', 'moved', '--item', '1', '--commit', head);
  box.run(alpha.web, 'shout', 'all', longChips);
  box.run(alpha.web, 'shout', 'all', refsShout);
  box.run(alpha.web, 'shout', 'all', blockShout);
  box.run(alpha.repo, 'shout', 'person', 'Launch on Friday?', '--decision');
  box.run(alpha.web, 'shout', 'all', long);

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-cards-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.shouts?.length >= 12');
    await chrome.evaluate("document.querySelector('[data-tab=shouts]').click()");
    await chrome.waitFor('document.querySelector("[data-pane=shouts]:not([hidden]) #feed .shout")');
    await chrome.evaluate("(() => { const fold = document.querySelector('.asks-toggle[data-fold=\"waiting\"]'); if (fold && fold.getAttribute('aria-expanded') !== 'true') fold.click(); })()");
    const ids = JSON.parse(await chrome.evaluate('JSON.stringify(Object.fromEntries(data.project.shouts.map((s) => [s.shout_text, s.shout_id])))'));
    const answerId = await chrome.evaluate(`data.project.shouts.find((s) => s.shout_answers === ${asked.shout_id}).shout_id`);
    const stamps = JSON.parse(await chrome.evaluate('JSON.stringify(data.project.shouts.map((s) => [s.shout_id, s.shout_at]))'));

    /** Everything a card shows, measured where it stands. */
    const read = async () => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const style = (e) => getComputedStyle(e);
      const card = (place, id) => {
        const e = document.querySelector(place + ' #shout-' + id) ?? [...document.querySelectorAll(place + ' .shout')].find((c) => c.dataset.shoutId === String(id));
        if (!e) return null;
        const avatar = e.querySelector('.avatar'), who = e.querySelector('.who'), time = e.querySelector('header time'), text = e.querySelector('.text');
        const edges = [e, ...e.querySelectorAll('.receipt, .band')].map((part) => { const s = style(part); return { left: [s.borderLeftWidth, s.borderLeftColor], right: [s.borderRightWidth, s.borderRightColor] }; });
        return {
          classes: e.className, avatar: { text: avatar.textContent, svg: !!avatar.querySelector('svg'), radius: style(avatar).borderTopLeftRadius, color: style(avatar).color, background: style(avatar).backgroundColor, box: box(avatar) },
          who: { text: who.textContent, color: style(who).color }, to: e.querySelector('.to')?.textContent, item: e.querySelector('header .item')?.textContent ?? null,
          item_color: e.querySelector('header .item') && style(e.querySelector('header .item')).color, ink: style(text).color,
          time: { text: time.textContent, title: time.title, box: box(time) }, header: box(e.querySelector('header')), text: { box: box(text), lines: Math.round(text.clientHeight / parseFloat(style(text).lineHeight)), clamped: text.scrollHeight > text.clientHeight + 1 },
          more: (() => { const m = e.querySelector('.more'); return m && style(m).display !== 'none' ? m.textContent : null; })(),
          band: e.querySelector('.band') ? { text: e.querySelector('.band').textContent, done: e.querySelector('.band').classList.contains('done'), href: e.querySelector('.band a')?.getAttribute('href') ?? null } : null,
          receipt: e.querySelector('.receipt') ? { badge: e.querySelector('.receipt .badge').textContent, outcome: e.querySelector('.receipt .outcome').textContent, foot: e.querySelector('.receipt-foot').textContent,
            sha: e.querySelector('.receipt-foot code.sha')?.textContent, shaTitle: e.querySelector('.receipt-foot code.sha')?.title } : null,
          answer: e.querySelector('.answer')?.textContent ?? null, edges,
        };
      };
      const chip = (selector) => { const e = document.querySelector('#feed #shout-${ids[chips]} .text ' + selector); return e && { text: e.textContent, title: e.title, display: style(e).display, rects: e.getClientRects().length, color: style(e).color, background: style(e).backgroundColor }; };
      const feed = document.querySelector('#feed'), rule = feed.querySelector('.day-rule'), label = rule?.querySelector('span');
      return {
        page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
        feedKinds: [...feed.children].map((e) => e.classList.contains('day-rule') ? 'rule:' + e.textContent : e.classList.contains('shout') ? 'shout:' + e.dataset.shoutId : e.className),
        rule: rule && { box: box(rule), label: box(label) },
        heads: [...document.querySelectorAll('#decisions .head')].map((h) => h.textContent),
        decisions: [...document.querySelectorAll('#decisions .shout')].map((e) => e.dataset.shoutId),
        feed: { older: card('#feed', ${ids[older]}), colour: card('#feed', ${ids[colour]}), ship: card('#feed', ${ids[ship]}), chips: card('#feed', ${ids[chips]}), long: card('#feed', ${ids[long]}),
          receipt: card('#feed', ${ids['the page loads in 80ms']}), answer: card('#feed', ${answerId}), friday: card('#feed', ${ids['Launch on Friday?']}), mixed: card('#feed', ${ids[mixed]}) },
        longs: [...document.querySelectorAll('#feed #shout-${ids[longChips]} .text code.inline')].map((e) => {
          const c = e.getBoundingClientRect(), t = e.closest('.text').getBoundingClientRect();
          return { text: e.textContent, title: e.title, rects: e.getClientRects().length, inside: c.left >= t.left - 0.5 && c.right <= t.right + 0.5, cut: e.scrollWidth > e.clientWidth + 1, ends: getComputedStyle(e).textOverflow };
        }),
        block: (() => {
          const b = document.querySelector('#feed #shout-${ids[blockShout]} .text .code-ref > button.ref.block');
          if (!b) return null;
          const c = b.getBoundingClientRect(), t = b.closest('.text').getBoundingClientRect(), edge = getComputedStyle(b.parentElement);
          return { label: b.textContent, height: c.height, full: Math.abs(c.width - t.width) < 3, caret: (() => { const k = getComputedStyle(b, '::before'); return k.content === 'none' || k.content === 'normal' || !(parseFloat(k.width) > 0) ? 'none' : k.clipPath.startsWith('polygon') ? 'drawn' : 'unshaped'; })(),
            edges: [edge.borderLeftWidth, edge.borderLeftColor].join() === [edge.borderRightWidth, edge.borderRightColor].join() };
        })(),
        refs: [...document.querySelectorAll('#feed #shout-${ids[refsShout]} .text button[data-code]')].map((e) => {
          const c = e.getBoundingClientRect(), t = e.closest('.text').getBoundingClientRect(), path = e.querySelector('.ref-path'), tail = e.querySelector('.ref-at').getBoundingClientRect();
          return { text: e.textContent, title: e.title, code: e.dataset.code, rects: e.getClientRects().length, inside: c.left >= t.left - 0.5 && c.right <= t.right + 0.5,
            tail: tail.width > 0 && tail.left >= c.left - 0.5 && tail.right <= c.right + 0.5, cut: path.scrollWidth > path.clientWidth + 1, ends: getComputedStyle(path).textOverflow };
        }),
        asks: { friday: card('#decisions', ${ids['Launch on Friday?']}), colour: card('#decisions', ${ids[colour]}) },
        answerTarget: !!document.getElementById('shout-${answerId}'),
        repeated: [...document.querySelectorAll('[id]')].map((e) => e.id).filter((id, n, all) => all.indexOf(id) !== n),
        chips: { ref: chip('button.ref'), path: chip('code.path'), sha: chip('code.sha'), cmd: chip('code.cmd'), code: chip('code.inline:not(.path):not(.sha):not(.cmd)') },
      };
    })())`));

    const seen = {};
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await shoutsAt(chrome, width, scheme);
        const at = `${width}px ${scheme}`;
        const r = await read();
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll: ${JSON.stringify(r.page)}`);
        const { older: old, colour: asking, ship: shipped, chips: chipCard, long: folded, receipt, answer, friday, mixed: both } = r.feed;

        // A card: avatar, name in its colour, arrow and recipient, item, and the age at the top right over the text.
        for (const [name, c] of Object.entries(r.feed)) {
          assert.ok(c, `${at}: the ${name} shout is a card`);
          assert.equal(c.classes.includes('lead') ? c.avatar.background : c.avatar.color, c.who.color, `${at}: ${name}: the name is in its avatar's colour`);
          assert.ok(Math.abs(c.time.box.right - c.header.right) <= 1 && c.time.box.top < c.text.box.top, `${at}: ${name}: the age sits at the top right: ${JSON.stringify([c.time, c.header])}`);
          assert.ok(c.text.box.top >= c.header.bottom - 1, `${at}: ${name}: the text sits below the header`);
          for (const edge of c.edges) assert.deepEqual(edge.left, edge.right, `${at}: ${name}: no box in the card carries a coloured edge`);
        }
        assert.deepEqual([old.avatar.text, old.who.text, old.to], ['W1', 'web-1', '→ coordinator'], `${at}: initials, name, arrow and recipient`);
        assert.equal(old.avatar.radius, '50%', `${at}: an agent's avatar is a circle`);
        assert.equal(chipCard.avatar.color, old.avatar.color, `${at}: one agent keeps one colour`);
        assert.notEqual(asking.avatar.color, old.avatar.color, `${at}: another agent has its own`);
        assert.ok(answer.avatar.svg && answer.avatar.radius !== '50%' && Math.abs(answer.avatar.box.width - answer.avatar.box.height) < 1 && answer.classes.includes('lead'),
          `${at}: the coordinator's avatar is a square with the Pullboard mark: ${JSON.stringify(answer.avatar)}`);
        assert.deepEqual([old.item, chipCard.item, receipt.item, asking.item, both.item], ['#1', '#1', '#1', null, '#2'], `${at}: the item is the first #N that names one, or else the evidence's`);
        assert.notEqual(old.item_color, old.who.color, `${at}: the item is muted, not the agent's colour`);
        assert.deepEqual([folded.time.text, shipped.time.text, asking.time.text], ['now', '2m ago', '1h ago'], `${at}: ages read now, 2m ago, 1h ago`);
        assert.ok(/\d\d:\d\d$/.test(shipped.time.title) && /^\S+ \d+ \d\d:\d\d$/.test(old.time.title), `${at}: the clock time is on hover, with the date when it was another day`);

        // Chips: inline, whole, ref, path and hash each in a colour of their own; a sha shows ten characters.
        for (const [kind, c] of Object.entries(r.chips)) {
          assert.ok(c, `${at}: the ${kind} chip renders`);
          assert.match(c.display, /^inline/, `${at}: the ${kind} chip stays inline`);
          assert.equal(c.rects, 1, `${at}: the ${kind} chip never breaks across lines`);
        }
        assert.equal(new Set([r.chips.ref.color, r.chips.path.color, r.chips.sha.color]).size, 3, `${at}: item refs, paths and hashes each have a colour: ${JSON.stringify(r.chips)}`);
        assert.deepEqual([r.chips.sha.text, r.chips.sha.title], [sha.slice(0, 10), sha], `${at}: a full sha shows its first ten characters, the whole on hover`);
        assert.deepEqual([r.chips.ref.text, r.chips.path.text, r.chips.cmd.text, r.chips.code.text], ['#1', 'src/cockpit.js', 'pullboard check --json', 'npm test']);
        // Long chips too: each one piece inside the text, the whole of it on hover; one longer than the line is cut short.
        assert.deepEqual(r.longs.map((c) => [c.text, c.title, c.rects, c.inside]), [longCommand, longPath, longerPath].map((text) => [text, text, 1, true]),
          `${at}: a long command, path and code stay one chip each: ${JSON.stringify(r.longs)}`);
        if (width === 375) assert.ok(r.longs[2].cut && r.longs[2].ends === 'ellipsis', `${at}: a chip longer than its line is cut short with an ellipsis: ${JSON.stringify(r.longs)}`);
        // A code reference reads path:lines@ten characters as one piece, the whole reference on hover and in its action.
        assert.deepEqual(r.refs.map((c) => [c.text, c.title, c.code, c.rects, c.inside, c.tail]), sourceRefs.map((ref) => [ref.replace(head, head.slice(0, 10)), ref, ref, 1, true, true]),
          `${at}: each code reference is one piece with its lines and short commit in view: ${JSON.stringify(r.refs)}`);
        if (width === 375) assert.ok(r.refs[1].cut && r.refs[1].ends === 'ellipsis', `${at}: a path too long for the line is cut short first: ${JSON.stringify(r.refs)}`);
        // A reference on a line of its own is a block, collapsed: a caret header the width of the text, no coloured edge.
        assert.deepEqual(r.block && [r.block.label, r.block.height >= tapTarget(width), r.block.full, r.block.caret, r.block.edges], [sourceRefs[0].replace(head, head.slice(0, 10)), true, true, 'drawn', true],
          `${at}: a whole-line reference is a collapsed block: ${JSON.stringify(r.block)}`);

        // Decisions: a band until answered, then who answered and a link to the answer.
        assert.deepEqual(asking.band, { text: 'Decision needed', done: false, href: null }, `${at}: an open ask carries a Decision needed band`);
        assert.deepEqual(shipped.band, { text: 'Answered by coordinator: see the answer', done: true, href: `#shout-${answerId}` }, `${at}: an answered one says who answered, linking the answer`);
        assert.ok(r.answerTarget, `${at}: the link lands on the answer`);
        assert.deepEqual(r.repeated, [], `${at}: an ask shown in the feed and above the composer never repeats an id`);

        // Evidence: a receipt with kind, outcome and a footer of item, agent and short sha.
        assert.deepEqual([receipt.receipt.badge, receipt.receipt.outcome], ['receipt', 'measured 80ms']);
        assert.ok(receipt.receipt.foot.startsWith('#1 · web-1 · ') && receipt.receipt.sha === head.slice(0, 10) && receipt.receipt.shaTitle === head, `${at}: the receipt's footer: ${JSON.stringify(receipt.receipt)}`);

        // A long shout folds at six lines; the asks above the composer are the same cards, folded at three.
        assert.deepEqual([folded.text.lines, folded.text.clamped, folded.more], [6, true, 'more'], `${at}: a long shout folds at six lines with more`);
        assert.equal(old.more, null, `${at}: a short shout has no more`);
        assert.deepEqual(r.heads, ['Decision needed'], `${at}: the asks above the composer: the person's under their head, the rest opened from their fold line`);
        assert.deepEqual([r.asks.friday.answer, r.asks.colour.answer], ['Answer', null], `${at}: the person's ask has an Answer button; one waiting on others has none`);
        assert.deepEqual([r.asks.colour.text.lines, r.asks.colour.text.clamped, r.asks.colour.more], [3, true, 'more'], `${at}: an ask folds at three lines`);
        assert.ok(r.asks.friday.avatar.svg && r.asks.friday.who.text === 'coordinator', `${at}: the asks are the feed's cards`);

        // Days: none above today's shouts; a rule in the middle names the earlier day where the feed crosses into it.
        let day = new Date().toDateString();
        const expected = [...stamps.flatMap(([id, iso]) => { const was = day; day = new Date(iso).toDateString(); return day === was ? [`shout:${id}`] : ['rule', `shout:${id}`]; })];
        assert.deepEqual(r.feedKinds.map((k) => k.startsWith('rule:') ? 'rule' : k), expected, `${at}: a rule only where the day changes, none above today's: ${r.feedKinds}`);
        assert.ok(r.feedKinds[r.feedKinds.indexOf(`shout:${ids[older]}`) - 1].startsWith('rule:') && !r.feedKinds.some((k) => k === 'rule:Today'), `${at}: the earlier day is named above its first shout`);
        assert.ok(Math.abs((r.rule.label.left + r.rule.label.right) / 2 - (r.rule.box.left + r.rule.box.right) / 2) < 2, `${at}: the day sits in the middle of its rule`);
        seen[at] = { ink: old.ink, who: old.who.color };
      }
    }
    assert.notDeepEqual(seen['1280px light'], seen['1280px dark'], 'dark mode changes the cards');

    // Folding: more opens the whole shout, less closes it, and an open shout stays open across a refresh.
    await shoutsAt(chrome, 1280, 'light');
    const foldOf = () => chrome.evaluate(`JSON.stringify((() => { const c = document.querySelector('#feed #shout-${ids[long]}'), t = c.querySelector('.text'); return [c.querySelector('.more').textContent, Math.round(t.clientHeight / parseFloat(getComputedStyle(t).lineHeight))]; })())`).then(JSON.parse);
    await chrome.evaluate(`document.querySelector('#feed #shout-${ids[long]} .more').click()`);
    assert.deepEqual(await foldOf(), ['less', 12], 'more shows every line');
    box.run(alpha.web, 'shout', 'all', 'A later shout.');
    await chrome.waitFor(`data.project.shouts.some((s) => s.shout_text === 'A later shout.') && document.querySelector('#feed .shout .text')?.textContent === 'A later shout.'`, 15_000);
    assert.deepEqual(await foldOf(), ['less', 12], 'an open shout stays open across a refresh');
    await chrome.evaluate(`document.querySelector('#feed #shout-${ids[long]} .more').click()`);
    assert.deepEqual(await foldOf(), ['more', 6], 'less folds it again');

    // The block opens on its header to the lines it names, in its own frame.
    const blockRef = `document.querySelector('#feed #shout-${ids[blockShout]} .code-ref > button.ref.block')`;
    await chrome.evaluate(`${blockRef}.click()`);
    await chrome.waitFor(`${blockRef}.parentElement.classList.contains('open') && ${blockRef}.getAttribute('aria-expanded') === 'true' && ${blockRef}.parentElement.querySelector('.code-wrap .code')?.textContent.includes('Demo spec')`, 15_000);

    // The short label still opens the code it names, at that commit.
    const deepRef = `[...document.querySelectorAll('#feed #shout-${ids[refsShout]} button[data-code]')][1]`;
    await chrome.evaluate(`${deepRef}.click()`);
    await chrome.waitFor(`${deepRef}.getAttribute('aria-expanded') === 'true' && ${deepRef}.nextElementSibling?.textContent.includes('Deep line one')`, 15_000);
    // An inline reference keeps its label in the sentence and opens the same block a reference on its own line is.
    const opened = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const inline = ${deepRef}, block = inline.nextElementSibling, header = block?.querySelector(':scope > button.ref.block');
      const standalone = document.querySelector('#feed #shout-${ids[blockShout]} .code-ref.open');
      return { label: !inline.classList.contains('block') && inline.textContent, next: block?.className, header: header && [header.dataset.code, header.textContent, header.getAttribute('aria-expanded')],
        lines: block?.querySelector(':scope > .code-wrap .code')?.textContent.includes('Deep line one'),
        shape: block && [...block.children].map((e) => e.className), standalone: standalone && [...standalone.children].map((e) => e.className) };
    })())`));
    assert.deepEqual([opened.next, opened.header, opened.lines], ['code-ref open', [sourceRefs[1], opened.label, 'true'], true],
      `an inline reference opens the collapsed block with its own header, under its label: ${JSON.stringify(opened)}`);
    assert.deepEqual(opened.shape, opened.standalone, 'the same block a reference on its own line opens to');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the shout composer, agent filter and agents panel [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for rendered shout checks.');

  const box = machine();
  const alpha = project(box, 'composer');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.web, 'claim', '1');
  const idle = join(box.dir, 'composer-web-2'), fresh = join(box.dir, 'composer-web-3');
  box.git(alpha.repo, 'worktree', 'add', '-q', idle, '-b', 'web/composer2');
  // web-2 joined and spoke three hours ago, and has not moved since.
  earlier(alpha.repo, Date.now() - 3 * 36e5, (board) => {
    assert.equal(register(board, { lane: 'web', path: idle }), 'web-2');
    shoutOnBoard(board, { from: 'web-2', to: 'coordinator', text: 'An idle agent spoke this morning.', lanes: ['web'] });
  });
  box.run(alpha.repo, 'shout', 'web-2', 'The coordinator wrote to the idle agent.');
  box.git(alpha.repo, 'worktree', 'add', '-q', fresh, '-b', 'web/composer3');
  box.run(fresh, 'join', 'web');
  box.run(fresh, 'shout', 'all', 'A fresh agent says hello.');
  box.run(alpha.web, 'shout', 'all', 'The claim holder reports in.');

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-composer-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.shouts?.length >= 4');
    await chrome.evaluate("document.querySelector('[data-tab=shouts]').click()");
    await chrome.waitFor('document.querySelector("[data-pane=shouts]:not([hidden]) #feed .shout")');
    await chrome.evaluate("(() => { const fold = document.querySelector('.fold-line[data-fold=\"idle\"]'); if (fold && fold.getAttribute('aria-expanded') !== 'true') fold.click(); })()");
    const agents = JSON.parse(await chrome.evaluate('JSON.stringify(data.project.agents.map((a) => [a.agent_id, a.agent_path]))'));
    assert.deepEqual(agents.filter(([, path]) => [alpha.web, idle, fresh].includes(path)).map(([id]) => id).sort(), ['web-1', 'web-2', 'web-3'], 'three agents joined the web lane');
    const total = await chrome.evaluate('data.project.shouts.length');
    const state = async () => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const pane = document.querySelector('[data-pane=shouts]'), list = document.querySelector('#agents');
      return {
        page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
        listed: [...list.querySelectorAll('[data-agent]')].map((e) => e.dataset.agent), on: [...list.querySelectorAll('.agent-card.on [data-agent], .agent-pill.on')].map((e) => e.dataset.agent),
        all: list.querySelector('.all-agents')?.textContent ?? null, panel: list.offsetParent !== null, bare: pane.classList.contains('bare'),
        toggle: document.querySelector('.asks-slot [data-agents-toggle], .panel-head [data-agents-toggle]')?.textContent, bar: document.querySelector('#feed .feed-bar span')?.textContent ?? '',
        cards: [...document.querySelectorAll('#feed .shout')].map((c) => [c.querySelector('.who').textContent, c.querySelector('.to').textContent.replace('→ ', '')]),
        to: document.querySelector('#shout-to').value, feed: box(document.querySelector('#feed')),
        composer: box(document.querySelector('.composer')), message: box(document.querySelector('#shout-text')), send: box(document.querySelector('#shout-send')),
        pickers: [...document.querySelectorAll('.composer select, .composer datalist, .composer input')].filter((e) => e.type !== 'hidden').length,
        kept: (() => { try { return localStorage.getItem('pb.agents'); } catch { return 'unreadable'; } })(),
      };
    })())`));
    const click = (selector) => chrome.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const key = async (modifiers) => {
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers, ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    };

    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await shoutsAt(chrome, width, scheme);
        const at = `${width}px ${scheme}`;
        const s = await state();
        assert.ok(s.page.scroll <= s.page.width && s.page.body <= s.page.width, `${at}: no sideways scroll: ${JSON.stringify(s.page)}`);
        // One bar: the message, the send button on the right, in one row; no recipient picker.
        for (const part of ['message', 'send']) assert.ok(s[part].top >= s.composer.top - 0.5 && s[part].bottom <= s.composer.bottom + 0.5, `${at}: the ${part} sits inside the composer bar: ${JSON.stringify(s)}`);
        assert.ok(s.pickers === 0 && s.message.right <= s.send.left + 0.5 && s.composer.right - s.send.right < 12, `${at}: the message, then send: ${JSON.stringify(s)}`);
        assert.ok(s.send.width >= tapTarget(width) && s.send.height >= tapTarget(width), `${at}: the send button is a target, 44px where a finger taps`);
        // Only agents at work are listed, the idle ones in their fold, which ends with show all.
        assert.ok(s.panel && s.listed.includes('web-1') && s.listed.includes('web-3') && !s.listed.includes('web-2'), `${at}: the agents at work, and not the idle one: ${s.listed}`);
        assert.equal(s.all, `show all ${agents.length}`, `${at}: every agent is one click away`);
      }
    }

    await shoutsAt(chrome, 1280, 'light');
    await click('#agents .all-agents');
    let s = await state();
    assert.ok(s.listed.includes('web-2') && s.listed.length === agents.length && s.all === 'show only agents at work', `show all lists every agent: ${JSON.stringify(s.listed)}`);

    // An agent's name filters the feed to its shouts, from or to it, and addresses the composer to it.
    await click('#agents [data-agent="web-2"]');
    s = await state();
    assert.deepEqual(s.cards, [['coordinator', 'web-2'], ['web-2', 'coordinator']], 'only shouts from or to web-2');
    assert.deepEqual([s.bar, s.to, s.on], ['Shouts with web-2 show all', 'web-2', ['web-2']], 'the bar says whose, the composer is addressed to them, and the agent is marked');
    await click('#feed .feed-bar [data-agent=""]');
    s = await state();
    assert.deepEqual([s.cards.length, s.bar, s.on, s.to], [total, '', [], 'coordinator'], 'show all undoes the filter, and the composer goes back to the coordinator');
    await click('#agents .all-agents');

    // The message grows as it is typed; Shift+Enter starts a line, Enter sends.
    await chrome.evaluate("document.querySelector('#shout-text').focus()");
    const height = () => chrome.evaluate("document.querySelector('#shout-text').getBoundingClientRect().height");
    const one = await height();
    await chrome.send('Input.insertText', { text: 'First line' });
    await key(8);
    await chrome.send('Input.insertText', { text: 'second line' });
    await key(8);
    await chrome.send('Input.insertText', { text: 'third line' });
    assert.equal(await chrome.evaluate("document.querySelector('#shout-text').value"), 'First line\nsecond line\nthird line', 'Shift+Enter starts a new line');
    assert.ok(await height() > one + 20, 'the message grows as it is typed');
    assert.equal(await chrome.evaluate('data.project.shouts.length'), total, 'and sends nothing');
    await key(0);
    await chrome.waitFor("data.project.shouts.some((s) => s.shout_text === 'First line\\nsecond line\\nthird line' && s.shout_to === 'coordinator')", 15_000);
    await chrome.waitFor("document.querySelector('#shout-text').value === ''");
    assert.ok(Math.abs(await height() - one) < 1, 'Enter sends, and the bar shrinks back to one line');
    assert.ok(await chrome.evaluate("!document.querySelector('#console').hidden && !document.querySelector('.composer #console') && document.querySelector('#console').getBoundingClientRect().bottom <= document.querySelector('.composer').getBoundingClientRect().top"),
      'the result stands above the bar, never inside it');

    // The panel hides and shows, and the browser remembers.
    await click('.panel-head [data-agents-toggle]');
    s = await state();
    const wide = s.feed.width;
    assert.deepEqual([s.bare, s.panel, s.toggle, s.kept], [true, false, 'Show agents', 'hidden'], 'Hide agents hides the panel and remembers it');
    await chrome.send('Page.reload');
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.shouts?.length > 0 && !!document.querySelector("[data-tab=shouts]")');
    await chrome.evaluate("document.querySelector('[data-tab=shouts]').click()");
    await chrome.waitFor('document.querySelector("[data-pane=shouts]:not([hidden]) #feed .shout")');
    s = await state();
    assert.deepEqual([s.bare, s.panel, s.toggle], [true, false, 'Show agents'], 'still hidden after a reload');
    for (const width of [375, 1280]) {
      await shoutsAt(chrome, width, 'dark');
      s = await state();
      assert.ok(s.page.scroll <= s.page.width && s.page.body <= s.page.width, `${width}px hidden: no sideways scroll`);
    }
    await click('.asks-slot [data-agents-toggle]');
    s = await state();
    assert.deepEqual([s.bare, s.panel, s.toggle, s.kept], [false, true, 'hide', 'shown'], 'Show agents brings it back');
    assert.ok(s.feed.width < wide, 'and the feed gives it room');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
test('the agents panel is rows for work and pills for idle [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for rendered agent checks.');

  const box = machine();
  const alpha = project(box, 'roster');
  for (const title of ['Header', 'Footer']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  // web-1 waits on a verdict for #2 and builds #1: two things, the claim first.
  build(box, alpha, 2, 'footer.html');
  box.run(alpha.web, 'claim', '1');
  const second = join(box.dir, 'roster-web-2'), gone = join(box.dir, 'roster-web-3');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/roster2');
  box.run(second, 'join', 'web');
  box.git(alpha.repo, 'worktree', 'add', '-q', gone, '-b', 'web/roster3');
  // web-3 joined three hours ago and has not moved since: not at work, so behind show all.
  earlier(alpha.repo, Date.now() - 3 * 36e5, (board) => assert.equal(register(board, { lane: 'web', path: gone }), 'web-3'));
  box.run(alpha.web, 'shout', 'coordinator', 'Header is under way.');
  box.run(second, 'shout', 'coordinator', 'Free when you need me.');

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roster-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.agents?.length >= 4 && data.project.shouts.length >= 2');
    await chrome.evaluate("document.querySelector('[data-tab=shouts]').click()");
    await chrome.waitFor('document.querySelector("[data-pane=shouts]:not([hidden]) #agents [data-agent]")');
    assert.equal(await chrome.evaluate("document.querySelectorAll('#agents .agent-pill').length + ':' + document.querySelector('#agents .fold-line[data-fold=\"idle\"]').getAttribute('aria-expanded')"), '0:false', 'the idle agents start folded');
    await chrome.evaluate("(() => { const fold = document.querySelector('.fold-line[data-fold=\"idle\"]'); if (fold && fold.getAttribute('aria-expanded') !== 'true') fold.click(); })()");
    const agents = await chrome.evaluate('data.project.agents.length');
    /** The panel as it reads: each row and pill, measured where it stands. */
    const panel = async () => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const box = (e) => { const r = e.getBoundingClientRect(); return { height: r.height, width: r.width }; };
      const list = document.querySelector('#agents');
      return {
        page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
        rows: [...list.querySelectorAll('.agent-card')].map((card) => {
          const row = card.querySelector('.agent-row');
          return { id: row.dataset.agent, text: row.innerText.replace(/\\s+/g, ' ').trim(), title: row.title, height: box(row).height, on: card.classList.contains('on'),
            face: getComputedStyle(row.querySelector('.avatar')).color, name: getComputedStyle(row.querySelector('.agent-who b')).color,
            work: [...card.querySelectorAll('.agent-work[data-item]')].map((work) => [work.dataset.item, box(work).height]) };
        }),
        pills: [...list.querySelectorAll('.agent-pill')].map((pill) => ({ id: pill.dataset.agent, title: pill.title, height: box(pill).height, on: pill.classList.contains('on') })),
        idle: list.querySelector('.fold-line[data-fold="idle"] span')?.textContent ?? null, all: list.querySelector('.all-agents')?.textContent ?? null, height: box(list).height,
        chip: document.querySelector('#shout-to-chip').hidden ? null : document.querySelector('#shout-to-chip').textContent, to: document.querySelector('#shout-to').value,
        cards: [...document.querySelectorAll('#feed .shout')].map((card) => [card.querySelector('.who').textContent, card.querySelector('.to').textContent.replace('→ ', '')]),
      };
    })())`));

    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await shoutsAt(chrome, width, scheme);
        const at = `${width}px ${scheme}`;
        const p = await panel();
        assert.ok(p.page.scroll <= p.page.width && p.page.body <= p.page.width, `${at}: no sideways scroll: ${JSON.stringify(p.page)}`);
        // The agent holding work is one row: avatar, name, age, its first thing with that item's state, and how many more.
        assert.deepEqual(p.rows.map((row) => row.id), ['web-1'], `${at}: only an agent holding work takes a row`);
        const [row] = p.rows;
        assert.match(row.text, /^W1 web-1 building \+1 (?:now|\d+[mhd]) #1 Header$/, `${at}: what the row says: ${row.text}`);
        assert.equal(row.face, row.name, `${at}: the name is in its avatar's colour, as in the feed`);
        assert.ok(row.height >= tapTarget(width), `${at}: the row is a target`);
        assert.ok(!/strong/.test(row.text) && row.title.includes('web · strong') && row.title.includes(alpha.web), `${at}: lane, route and path are on hover, not in the row: ${row.title}`);
        // Agents holding nothing are pills in the idle fold; one that has not moved in the last hour waits behind show all.
        assert.deepEqual([p.idle, p.pills.map((pill) => pill.id)], ['2 idle', ['coordinator', 'web-2']], `${at}: the idle agents are pills`);
        assert.ok(p.pills.every((pill) => pill.height >= tapTarget(width) && pill.title.includes(' · ')), `${at}: each pill a target with its lane on hover`);
        assert.equal(p.all, `show all ${agents}`, `${at}: every agent one click away`);
        assert.ok(p.height < 260, `${at}: four agents take little room: ${p.height}px`);
      }
    }

    // A row filters the feed to that agent and addresses the composer to it, and opens to each thing it holds.
    await shoutsAt(chrome, 1280, 'light');
    await chrome.evaluate(`document.querySelector('#agents .agent-row[data-agent="web-1"]').click()`);
    let p = await panel();
    assert.deepEqual([p.rows[0].on, p.rows[0].work.map(([id]) => id), p.chip, p.to, p.cards], [true, ['1', '2'], 'to web-1×', 'web-1', [['web-1', 'coordinator']]],
      `the picked row opens to what it holds, the feed shows its shouts and the composer is addressed to it: ${JSON.stringify(p)}`);
    assert.ok(p.rows[0].work.every(([, height]) => height >= tapTarget(1280)), 'each thing it holds is a target');
    // A pill does the same.
    await chrome.evaluate(`document.querySelector('#agents .agent-pill[data-agent="web-2"]').click()`);
    p = await panel();
    assert.deepEqual([p.pills.find((pill) => pill.id === 'web-2').on, p.chip, p.cards], [true, 'to web-2×', [['web-2', 'coordinator']]], 'a pill filters and addresses too');
    // And a thing an agent holds opens its item.
    await chrome.evaluate(`document.querySelector('#agents .agent-row[data-agent="web-1"]').click()`);
    await chrome.evaluate(`document.querySelector('#agents .agent-work[data-item="2"]').click()`);
    await chrome.waitFor(`!document.querySelector('[data-pane=items]').hidden && document.querySelector('#detail h2')?.textContent.includes('Footer')`);
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the composer goes to the coordinator and says who heard [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for rendered composer checks.');

  const box = machine();
  // A docs lane nobody has joined: a shout to it reaches no agent.
  const alpha = project(box, 'heard', SPEC, { lanes: { web: { owns: ['web/'], specs: ['G'] }, docs: { owns: ['docs/'], specs: ['G'] } } });
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.web, 'shout', 'coordinator', 'Starting on the greeting.');
  earlier(alpha.repo, Date.now(), (board) => shoutOnBoard(board, { from: 'person', to: 'docs', text: 'Docs, anyone?', lanes: ['web', 'docs'] }));
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-heard-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.shouts?.length >= 1');
    await chrome.evaluate("document.querySelector('[data-tab=shouts]').click()");
    await chrome.waitFor('document.querySelector("[data-pane=shouts]:not([hidden]) #feed .shout")');
    await chrome.evaluate("document.querySelector('#agents .fold-line[data-fold=\"idle\"]').click()");
    /** The composer and every shout of the person's, with what its Heard line says. */
    const read = async () => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const chip = document.querySelector('#shout-to-chip'), clear = chip.querySelector('[data-to-clear]');
      return {
        page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
        pickers: [...document.querySelectorAll('.composer select, .composer datalist, .composer input')].filter((e) => e.type !== 'hidden').length,
        to: document.querySelector('#shout-to').value, placeholder: document.querySelector('#shout-text').placeholder,
        chip: chip.hidden ? null : chip.textContent, clear: clear ? [clear.getBoundingClientRect().width, clear.getBoundingClientRect().height] : null,
        heard: [...document.querySelectorAll('#feed .shout')].filter((card) => card.querySelector('.heard')).map((card) => {
          const line = card.querySelector('.heard');
          return [card.querySelector('.text').textContent, line.lastChild.textContent, line.querySelectorAll('.heard-face').length, line.title];
        }),
      };
    })())`));
    const key = async () => {
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    };
    const heardOf = (text) => `[...document.querySelectorAll('#feed .shout')].find((card) => card.querySelector('.text').textContent === ${JSON.stringify(text)})?.querySelector('.heard')?.lastChild.textContent`;

    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await shoutsAt(chrome, width, scheme);
        const at = `${width}px ${scheme}`;
        const r = await read();
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll`);
        assert.deepEqual([r.pickers, r.to, r.placeholder, r.chip], [0, 'coordinator', 'Shout to the coordinator', null], `${at}: no recipient picker; a shout goes to the coordinator, and says so`);
        // A shout to a lane no agent has joined reached no one, so it has not been heard.
        assert.deepEqual(r.heard.find(([text]) => text === 'Docs, anyone?')?.slice(1), ['Not heard yet', 0, ''], `${at}: a shout that reached no agent says Not heard yet`);
        // A picked agent's chip has an x that is a 44px square target; picking the agent again puts it back.
        await chrome.evaluate(`document.querySelector('#agents [data-agent="web-1"]').click()`);
        const picked = await read();
        assert.ok(picked.chip === 'to web-1×' && picked.clear[0] >= tapTarget(width) && picked.clear[1] >= tapTarget(width), `${at}: the chip's x is a square target: ${JSON.stringify(picked.clear)}`);
        await chrome.evaluate(`document.querySelector('#agents [data-agent="web-1"]').click()`);
        assert.equal((await read()).chip, null, `${at}: picking the agent again returns the composer to the coordinator`);
      }
    }

    // The person shouts with Enter: it goes to the coordinator, and says it is not heard until the coordinator reads it.
    await shoutsAt(chrome, 1280, 'light');
    await chrome.evaluate("document.querySelector('#shout-text').focus()");
    await chrome.send('Input.insertText', { text: 'Ship the greeting?' });
    await key();
    await chrome.waitFor("data.project.shouts.some((s) => s.shout_from === 'person' && s.shout_to === 'coordinator' && s.shout_text === 'Ship the greeting?')", 15_000);
    await chrome.waitFor(`${heardOf('Ship the greeting?')} === 'Not heard yet'`, 15_000);
    box.run(alpha.repo, 'inbox');
    await chrome.waitFor(`${heardOf('Ship the greeting?')} === 'Heard by coordinator'`, 15_000);
    // A shout that reaches everyone says who of them has read it: the coordinator first, then how many agents.
    // (The person reaches every agent through the relay's requests; here the board records one directly.)
    earlier(alpha.repo, Date.now(), (board) => shoutOnBoard(board, { from: 'person', to: 'all', text: 'Hold the merge, please.', lanes: ['web'] }));
    await chrome.waitFor("data.project.shouts.some((s) => s.shout_from === 'person' && s.shout_to === 'all')", 15_000);
    box.run(alpha.repo, 'inbox');
    box.run(alpha.web, 'inbox');
    await chrome.waitFor(`${heardOf('Hold the merge, please.')} === 'Heard by coordinator and 1 agent'`, 15_000);
    const all = (await read()).heard.find(([text]) => text === 'Hold the merge, please.');
    assert.deepEqual(all.slice(2), [2, 'Heard by coordinator, web-1'], 'with their avatars, and every name on hover');

    // Picking an agent addresses the composer to it; the chip's x returns it to the coordinator.
    await chrome.evaluate(`document.querySelector('#agents [data-agent="web-1"]').click()`);
    let r = await read();
    assert.deepEqual([r.chip, r.to, r.placeholder], ['to web-1×', 'web-1', 'Shout to web-1'], 'a picked agent shows as a chip');
    const clearAt = tapTarget(await chrome.evaluate('innerWidth'));
    assert.ok(r.clear[0] >= clearAt && r.clear[1] >= clearAt, 'whose x is a square target');
    await chrome.evaluate(`document.querySelector('#shout-to-chip [data-to-clear]').click()`);
    r = await read();
    assert.deepEqual([r.chip, r.to, r.placeholder], [null, 'coordinator', 'Shout to the coordinator'], 'the x returns it to the coordinator');
    // An item's Shout button addresses its lane the same way.
    await chrome.evaluate("document.querySelector('[data-tab=items]').click()");
    await chrome.waitFor('!!document.querySelector("#chain [data-item=\\"1\\"]")');
    await chrome.evaluate(`document.querySelector('#chain [data-item="1"]').click()`);
    await chrome.waitFor('!!document.querySelector("#detail [data-shout]")');
    await chrome.evaluate(`document.querySelector('#detail [data-shout]').click()`);
    await chrome.waitFor("!document.querySelector('[data-pane=shouts]').hidden");
    for (const width of [375, 1280]) {
      await shoutsAt(chrome, width, 'dark');
      r = await read();
      assert.deepEqual([r.chip, r.to], ['to web×', 'web'], `${width}px dark: an item's Shout button names its lane on the chip`);
      assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${width}px dark: no sideways scroll with the chip`);
    }
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
test("item detail merges API facts and moves in one responsive timeline [B33,B29]", { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for item-thread rendering checks.');

  const box = machine();
  const alpha = project(box, 'item-thread');
  box.run(alpha.repo, 'add', 'web', 'Thread fixture', '--specs', 'G1', '--criterion', 'The item keeps its evidence.');
  box.run(alpha.web, 'claim', '1');
  const sourceHead = box.git(alpha.repo, 'rev-parse', 'HEAD');
  /** Append a real board fact and return the identity the correction must name. */
  const addFact = (kind, text, ...flags) => JSON.parse(box.run(alpha.web, 'fact', '1', kind, text, ...flags, '--json')).fact;
  const oldNote = addFact('note', 'Earlier observation, now replaced.');
  addFact('capture', 'Captured the rendered page.', '--ref', `SPEC.md:1-2@${sourceHead}`);
  box.run(alpha.web, 'release', '1');
  addFact('measurement', 'The view settles in 8 seconds.');
  box.run(alpha.web, 'claim', '1');
  addFact('diff', 'The detail gained a thread.');
  addFact('decision', 'Keep the thread in the item.');
  addFact('rejection', 'The first layout wrapped poorly.');
  const replacement = addFact('supersession', 'Correction: the note is replaced.', '--supersedes', oldNote.id);
  addFact('root-cause', 'The missing projection hid the facts.');

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-item-thread-chrome-'));
  let chrome;
  try {
    const apiState = await boardOf(view, alpha.repo);
    const expected = apiState.items.find((item) => item.id === 1).thread;
    assert.deepEqual(expected.filter((entry) => entry.type === 'fact').map((entry) => entry.kind),
      ['note', 'capture', 'measurement', 'diff', 'decision', 'rejection', 'supersession', 'root-cause'],
      'the API provides every fact in append order');
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.items?.find((item) => item.id === 1)?.thread?.length === ' + expected.length);
    await chrome.waitFor('document.querySelectorAll("#detail .tl [data-event-id]").length === ' + expected.length);
    const expectedIds = expected.map((entry) => entry.eventId);
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.querySelector('#detail .tl')?.getBoundingClientRect().width > 0`);
      const rendered = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
        const timeline = document.querySelector('#detail .tl');
        const old = document.querySelector('#detail #fact-${oldNote.id}');
        const replacement = document.querySelector('#detail #fact-${replacement.id}');
        const live = document.querySelector('#detail #fact-${expected.find((entry) => entry.type === 'fact' && entry.kind === 'capture').id}');
        const plain = document.querySelector('#detail .tl-fact:not(.tl-judgement):not(.tl-superseded)');
        const judgementColors = Object.fromEntries(['decision', 'rejection', 'supersession', 'root-cause'].map((kind) => {
          const row = [...timeline.querySelectorAll('.tl-fact')].find((entry) => entry.querySelector('.tl-fact-head .chip')?.textContent === kind);
          return [kind, row ? getComputedStyle(row, '::before').backgroundColor : null];
        }));
        return {
          ids: [...timeline.querySelectorAll('[data-event-id]')].map((row) => Number(row.dataset.eventId)),
          rows: timeline.querySelectorAll('li').length,
          kinds: [...timeline.querySelectorAll('.tl-fact-head .chip')].map((chip) => chip.textContent),
          authors: [...timeline.querySelectorAll('.tl-fact-head b')].map((name) => name.textContent),
          ages: timeline.querySelectorAll('.tl-fact small time[data-ago]').length,
          oldClass: old?.className,
          replacementHref: old?.querySelector('.thread-replacement')?.getAttribute('href'),
          oldOpacity: Number(old && getComputedStyle(old).opacity),
          replacementOpacity: Number(replacement && getComputedStyle(replacement).opacity),
          liveOpacity: Number(live && getComputedStyle(live).opacity),
          plainMarker: plain ? getComputedStyle(plain, '::before').backgroundColor : null,
          judgementColors,
          judgementKinds: Object.keys(judgementColors).filter((kind) => judgementColors[kind] !== null),
          ref: timeline.querySelector('.tl-fact button[data-code]')?.dataset.code,
          viewport: document.documentElement.clientWidth,
          pageWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        };
      })())`));
      assert.deepEqual(rendered.ids, expectedIds, `${width}px: moves and facts follow the API's event order`);
      assert.equal(rendered.rows, expected.length, `${width}px: each API event appears exactly once`);
      const expectedFacts = expected.filter((entry) => entry.type === 'fact');
      assert.deepEqual(rendered.kinds, expectedFacts.map((entry) => entry.kind), `${width}px: every fact kind is a visible chip`);
      assert.deepEqual(rendered.authors, expectedFacts.map((entry) => entry.by), `${width}px: each fact names its API author`);
      assert.equal(rendered.ages, expectedFacts.length, `${width}px: each fact shows its age`);
      assert.match(rendered.oldClass, /tl-superseded/, `${width}px: the earlier fact is visibly dimmed`);
      assert.equal(rendered.replacementHref, `#fact-${replacement.id}`, `${width}px: the earlier fact links to its replacement`);
      assert.ok(rendered.oldOpacity < rendered.replacementOpacity && rendered.oldOpacity < rendered.liveOpacity,
        `${width}px: computed opacity dims the superseded fact`);
      assert.deepEqual(rendered.judgementKinds, ['decision', 'rejection', 'supersession', 'root-cause'], `${width}px: all judgement kinds appear`);
      for (const [kind, color] of Object.entries(rendered.judgementColors)) {
        assert.notEqual(color, rendered.plainMarker, `${width}px: ${kind} uses a distinct computed marker color`);
      }
      assert.equal(rendered.ref, `SPEC.md:1-2@${sourceHead}`, `${width}px: the committed code reference is actionable`);
      assert.equal(rendered.pageWidth, rendered.viewport, `${width}px: the timeline causes no sideways page scroll`);
    }
    const scrollBefore = JSON.parse(await chrome.evaluate(`JSON.stringify({ page: document.documentElement.scrollTop, detail: document.querySelector('#detail').scrollTop })`));
    await chrome.evaluate(`document.querySelector('#detail #fact-${oldNote.id} .thread-replacement').click()`);
    await chrome.waitFor(`location.hash === '#fact-${replacement.id}' && document.querySelector('#detail #fact-${replacement.id}')`);
    const target = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const detail = document.querySelector('#detail'), fact = document.querySelector('#detail #fact-${replacement.id}');
      const box = fact.getBoundingClientRect(), panel = detail.getBoundingClientRect();
      return { item: view.item, id: fact.id, text: document.querySelector('#detail h2')?.textContent,
        page: document.documentElement.scrollTop, detail: detail.scrollTop,
        visible: box.top >= panel.top && box.bottom <= panel.bottom };
    })())`));
    assert.equal(target.id, `fact-${replacement.id}`, 'the replacement anchor resolves to a visible fact');
    assert.equal(target.item, 1, 'following the link keeps the same item selected');
    assert.equal(target.text, '#1Thread fixture', 'the item detail stays open after following the replacement link');
    assert.ok(target.page > scrollBefore.page || target.detail > scrollBefore.detail,
      'following the replacement anchor scrolls to its existing target');
    assert.equal(target.visible, true, 'the replacement is visible after following its link');
    await chrome.evaluate(`document.querySelector('#detail .tl-fact button[data-code]').click()`);
    await chrome.waitFor(`document.querySelector('#detail .tl-fact button[data-code]')?.getAttribute('aria-expanded') === 'true'`);
    await chrome.waitFor(`document.querySelector('#detail .tl-fact .code')?.textContent.includes('Demo spec')`);
    assert.match(await chrome.evaluate(`document.querySelector('#detail .tl-fact .code')?.textContent || ''`), /Demo spec/, 'the code reference opens the committed lines');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('in-text item references stay inline and open their target at phone and desktop widths [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for item-reference layout checks.');

  const box = machine();
  const demo = project(box, 'inline-references', SPEC, { practice: 'ways.md' });
  writeFileSync(join(demo.repo, 'ways.md'), '# Local rules\n\n## Team\n- R1 [approved, must] Items carry the page behavior. | gate: review\n');
  box.run(demo.repo, 'add', 'web', 'Target item', '--specs', 'G1', '--criterion', 'the linked target');
  box.run(demo.repo, 'add', 'web', 'Title links to #1', '--specs', 'G1', '--criterion', 'Criterion links to #1', '--brief', 'Brief links to #1');
  box.run(demo.web, 'claim', '2');
  box.run(demo.repo, 'shout', 'person', 'Please choose #1 next', '--decision');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-inline-references-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('document.querySelectorAll("#chain .row").length >= 2 && document.querySelector("#needs .row")');

    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      // Needs you heads the Items list under Active; the steps below leave other tabs and filters open.
      await chrome.evaluate("document.querySelector('[data-tab=items]').click(); document.querySelector('[data-state=active]').click()");
      // The row inlineReference stays on its title line beside the text.
      const rendered = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
        const row = document.querySelector('#chain .row[data-item="2"]');
        const plain = document.querySelector('#chain .row[data-item="1"]');
        const titleRef = row?.querySelector('.t button.ref');
        const need = [...document.querySelectorAll('#needs .row')].find((entry) => entry.textContent.includes('Please choose'));
        const needRef = need?.querySelector('.t button.ref');
        const needAction = need;
        const realButton = document.querySelector('#new-item');
        /** Measure the element box independently of the inline-link assertion. */
        const rect = node => { const r=node.getBoundingClientRect(); return {height:r.height,width:r.width}; };
        return {
          titleRef: titleRef && { ...rect(titleRef), border:getComputedStyle(titleRef).borderWidth, lineHeight:getComputedStyle(titleRef).lineHeight },
          linkedTitle: row && rect(row.querySelector('.t')),
          plainTitle: plain && rect(plain.querySelector('.t')),
          needRef: needRef && { ...rect(needRef), border:getComputedStyle(needRef).borderWidth, lineHeight:getComputedStyle(needRef).lineHeight },
          needText: need?.querySelector('.t') && rect(need.querySelector('.t')),
          needAction: needAction && rect(needAction), realButton: realButton && rect(realButton),
        };
      })())`));
      assert.ok(rendered.titleRef && rendered.needRef, `${width}: list and Needs-you references are links: ${JSON.stringify(rendered)}`);
      assert.equal(rendered.titleRef.border, '0px', `${width}: the title reference has no button border`);
      assert.equal(rendered.needRef.border, '0px', `${width}: the Needs-you reference has no button border`);
      assert.ok(Math.abs(rendered.linkedTitle.height - rendered.plainTitle.height) < 1,
        `${width}: the title line matches a plain title: ${JSON.stringify(rendered)}`);
      assert.ok(Math.abs(rendered.titleRef.height - rendered.linkedTitle.height) < 1,
        `${width}: the title link has the surrounding line height: ${JSON.stringify(rendered)}`);
      assert.ok(Math.abs(rendered.needRef.height - rendered.needText.height) < 1,
        `${width}: the Needs-you link has the surrounding line height: ${JSON.stringify(rendered)}`);
      assert.ok(rendered.needAction.height >= tapTarget(width) && rendered.realButton.height >= tapTarget(width),
        `${width}: real controls keep their targets: ${JSON.stringify(rendered)}`);

      for (const section of ['agents', 'spec', 'doctrine']) {
        if (section === 'agents') {
          await chrome.evaluate(`document.querySelector('[data-tab="shouts"]').click()`);
          await chrome.evaluate("(() => { const item = data.project.items.find((i) => i.id === 2); const who = item.owner || item.reviewer || item.builtBy; if (!document.querySelector('#agents .agent-card.on [data-agent=\"' + who + '\"]')) document.querySelector('#agents [data-agent=\"' + who + '\"]').click(); })()");
          await chrome.waitFor('document.querySelector("#agents [data-item=\\"2\\"]")');
        } else {
          await chrome.evaluate(`document.querySelector('[data-tab="${section}"]').click()`);
          await chrome.evaluate(`document.querySelector('[data-rows="${section}:all"]').click()`);
          const citedRow = section === 'doctrine' ? 'R1' : 'G1';
          if (section === 'doctrine') {
            // Item citations normally point to SPEC ids; add the distinct practice id to the
            // browser projection to exercise the shared doctrine citing-item renderer.
            await chrome.evaluate("data.project.items.find(item => item.id === 2).specs.push('R1'); render();");
          }
          await chrome.waitFor(`document.querySelector('#${section}-list [data-row="${section}:${citedRow}"]')`);
          await chrome.evaluate(`document.querySelector('#${section}-list [data-row="${section}:${citedRow}"]').click()`);
          await chrome.waitFor(`document.querySelector('#${section}-detail [data-item="2"]')`);
        }
        const selector = section === 'agents' ? '#agents [data-item="2"] .ref' : `#${section}-detail .links [data-item="2"] .ref`;
        const metrics = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
          const ref = document.querySelector(${JSON.stringify(selector)});
          const container = ref?.closest('[data-item="2"]');
          const r = ref?.getBoundingClientRect();
          const c = container?.getBoundingClientRect();
          return { present:!!ref, border:ref && getComputedStyle(ref).borderWidth,
            refHeight:r?.height, lineHeight:ref && parseFloat(getComputedStyle(ref).lineHeight),
            containerHeight:c?.height, nestedButtons:container ? [...container.querySelectorAll('.ref')].filter(link => link.parentElement.closest('button')).length : 0 };
        })())`));
        assert.ok(metrics.present, `${width}: ${section} citing title renders a compact item reference: ${JSON.stringify(metrics)}`);
        assert.equal(metrics.border, '0px', `${width}: ${section} reference has no button border`);
        assert.ok(Math.abs(metrics.refHeight - metrics.lineHeight) < 1, `${width}: ${section} reference keeps the text line height: ${JSON.stringify(metrics)}`);
        assert.ok(metrics.containerHeight >= tapTarget(width), `${width}: ${section} containing item keeps a target`);
        assert.equal(metrics.nestedButtons, 0, `${width}: ${section} title has no nested controls`);
        await chrome.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
        await chrome.waitFor("document.querySelector('[data-tab=items].on') && document.querySelector('#detail h2')?.textContent.includes('Target item')");
        await chrome.evaluate(`document.querySelector(${JSON.stringify(selector)}).closest('[data-item="2"]').click()`);
        await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Title links to #1')");
      }

      await chrome.evaluate(`document.querySelector('#chain .row[data-item="2"] .t button.ref').click()`);
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Target item')");
      await chrome.evaluate(`document.querySelector('#needs .row .t button.ref').click()`);
      await chrome.waitFor("document.querySelector('[data-tab=items].on') && document.querySelector('#detail h2')?.textContent.includes('Target item')");

      await chrome.evaluate(`document.querySelector('[data-tab="activity"]').click()`);
      await chrome.waitFor("document.querySelector('#activity .what button.ref')");
      await chrome.evaluate(`document.querySelector('#activity .what button.ref').click()`);
      await chrome.waitFor("document.querySelector('[data-tab=items].on') && document.querySelector('#detail h2')?.textContent.includes('Target item')");

      await chrome.evaluate(`document.querySelector('#chain .row[data-item="2"]').click()`);
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Title links to #1') && document.querySelector('#detail .text button.ref') && document.querySelector('#detail .text.muted button.ref')");
      await chrome.evaluate(`document.querySelector('#detail .text button.ref').click()`);
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Target item')");
      await chrome.evaluate(`document.querySelector('#chain .row[data-item="2"]').click()`);
      await chrome.waitFor("document.querySelector('#detail .text.muted button.ref')");
      await chrome.evaluate(`document.querySelector('#detail .text.muted button.ref').click()`);
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Target item')");
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('list rows hold their shape: one-line titles end in an ellipsis, every row as tall as the next [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for list row checks.');

  const box = machine();
  const demo = project(box, 'row-shape');
  const long = 'A title far too long for one line of the list: it names `pullboard land` and #1, then keeps on going past every width a phone or a laptop gives a row, so only an ellipsis can end it';
  const titles = { 1: 'Short title', 2: long, 3: 'Waits on the short one', 4: 'Built, then sent back with a long reason', 5: 'Being built right now' };
  box.run(demo.repo, 'add', 'web', titles[1], '--specs', 'G1', '--criterion', 'short');
  box.run(demo.repo, 'add', 'web', titles[2], '--specs', 'G1', '--criterion', 'long');
  box.run(demo.repo, 'add', 'web', titles[3], '--specs', 'G1', '--criterion', 'gated', '--after', '1');
  box.run(demo.repo, 'add', 'web', titles[4], '--specs', 'G1', '--criterion', 'back');
  box.run(demo.repo, 'add', 'web', titles[5], '--specs', 'G1', '--criterion', 'busy');
  build(box, demo, 4, 'four.txt');
  sendBack(box, demo, 4, `It misses the edge: ${'the criterion names a blank name and the page still greets it, '.repeat(4)}`);
  box.run(demo.web, 'claim', '5');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-row-shape-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('document.querySelectorAll("#chain .row").length === 5');
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      const rows = JSON.parse(await chrome.evaluate(`JSON.stringify([...document.querySelectorAll('#chain .row')].map((row) => {
        const box = (node) => node.getBoundingClientRect();
        const lines = (node) => Math.round(box(node).height / parseFloat(getComputedStyle(node).lineHeight));
        const apart = (a, b) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
        const title = row.querySelector('.t'), meta = row.querySelector('.meta'), chip = row.querySelector(':scope > .chip');
        return { id: row.dataset.item, tip: row.title, height: Math.round(box(row).height),
          titleLines: lines(title), ellipsis: getComputedStyle(title).textOverflow === 'ellipsis' && getComputedStyle(title).whiteSpace === 'nowrap',
          cut: title.scrollWidth > title.clientWidth, metaLines: lines(meta), chip: chip.className + ': ' + chip.textContent,
          chipHeight: Math.round(box(chip).height), chipClear: apart(box(chip), box(meta)) && apart(box(chip), box(title)),
          code: [...title.querySelectorAll('code')].map((code) => getComputedStyle(code).display) };
      }))`));
      const place = (row) => `${width}, #${row.id}: ${JSON.stringify(row)}`;
      assert.deepEqual(rows.map((row) => row.id).sort(), ['1', '2', '3', '4', '5'], `${width}: every item has a row`);
      for (const row of rows) {
        assert.equal(row.tip, titles[row.id], `${width}: the row's tooltip is its whole title`);
        assert.ok(row.titleLines === 1 && row.ellipsis, `title is one line, set to end in an ellipsis at ${place(row)}`);
        assert.equal(row.metaLines, 1, `the meta line never wraps, a long verdict reason included, at ${place(row)}`);
        assert.ok(row.chipHeight < 24 && row.chipClear, `the chip is one line and nothing runs over it at ${place(row)}`);
      }
      assert.ok(rows.find((row) => row.id === '2').cut, `${width}: the long title is cut, so its ellipsis shows`);
      assert.deepEqual(rows.find((row) => row.id === '2').code, ['inline'], `${width}: inline code in a title stays a word in the line, not a block`);
      assert.equal(new Set(rows.map((row) => row.height)).size, 1, `${width}: every row is as tall as the next: ${JSON.stringify(rows.map((row) => [row.id, row.height]))}`);
      assert.equal(new Set(rows.map((row) => row.chipHeight)).size, 1, `${width}: every chip is the same size`);
      const chips = Object.fromEntries(rows.map((row) => [row.id, row.chip]));
      assert.deepEqual([chips[1], chips[2], chips[3], chips[4]], ['chip free: unclaimed', 'chip free: unclaimed', 'chip gate: gated', 'chip no: sent back'], `${width}: each state's chip in the list`);
      assert.match(chips[5], /^chip busy: web-\d+$/, `${width}: a claimed item names who builds it, in the building colour`);
      // The same state wears the same chip in the item's detail as in its row.
      for (const row of rows) {
        await chrome.evaluate(`document.querySelector('#chain .row[data-item="${row.id}"]').click()`);
        await chrome.waitFor(`document.querySelector('#detail h2')?.textContent.startsWith('#${row.id}')`);
        const detail = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
          const chip = document.querySelector('#detail .meta.spaced .chip'), listed = document.querySelector('#chain .row[data-item="${row.id}"] > .chip');
          const paint = (node) => [getComputedStyle(node).backgroundColor, getComputedStyle(node).color, getComputedStyle(node).outlineStyle];
          return { chip: chip.className + ': ' + chip.textContent, samePaint: JSON.stringify(paint(chip)) === JSON.stringify(paint(listed)) };
        })())`));
        assert.ok(detail.samePaint, `${width}: #${row.id}'s chip has its row's colours in the detail: ${JSON.stringify(detail)} vs ${row.chip}`);
        if (row.id !== '5') assert.equal(detail.chip, row.chip, `${width}: #${row.id}'s detail says what its row says`);
        else assert.equal(detail.chip, 'chip busy: building', `${width}: the detail says building, in the colour of its row's builder chip`);
      }
    }
    // A builder's name can be long; its chip stops at its cap and ends in an ellipsis, leaving the title its line.
    await chrome.evaluate("data.project.items.find((item) => item.id === 5).owner = 'claude-opus-designer-on-the-studio-7'; render();");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.querySelector('#chain .row[data-item="5"] > .chip')?.textContent.startsWith('claude-opus')`);
      const named = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
        const row = document.querySelector('#chain .row[data-item="5"]'), chip = row.querySelector(':scope > .chip'), meta = row.querySelector('.meta');
        const a = chip.getBoundingClientRect(), b = meta.getBoundingClientRect();
        return { chipWidth: a.width, cap: 10 * parseFloat(getComputedStyle(document.documentElement).fontSize), cut: chip.scrollWidth > chip.clientWidth,
          ellipsis: getComputedStyle(chip).textOverflow === 'ellipsis', clear: b.right <= a.left + 0.5, heights: [...new Set([...document.querySelectorAll('#chain .row')].map((r) => Math.round(r.getBoundingClientRect().height)))] };
      })())`));
      assert.ok(named.chipWidth <= named.cap + 0.5 && named.cut && named.ellipsis, `${width}: a long builder name stops at the chip's cap, cut with an ellipsis: ${JSON.stringify(named)}`);
      assert.ok(named.clear && named.heights.length === 1, `${width}: and the row keeps its meta clear and its height: ${JSON.stringify(named)}`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('Roadmap and rule prose references stay inline and open the item on their own board [N26,N38]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for prose-reference checks.');
  const box = machine();
  const demo = project(box, 'a-inline-prose', `${SPEC}- G3 [approved, must] Follow #1 first. | gate: review\n`, { practice: 'ways.md' });
  writeFileSync(join(demo.repo, 'ways.md'), '# Local rules\n\n## Team\n- R1 [approved, must] Review #1 first. | gate: review\n');
  box.run(demo.repo, 'add', 'web', 'Local target', '--specs', 'G1', '--criterion', 'target');
  box.run(demo.repo, 'add', 'web', 'Local title links to #1', '--specs', 'G1', '--criterion', 'title');
  build(box, demo, 2, 'title.txt');
  sendBack(box, demo, 2, 'Review #1 before accepting.');
  const other = project(box, 'beacon-prose');
  box.run(other.repo, 'add', 'web', 'Remote target', '--specs', 'G1', '--criterion', 'target');
  box.run(other.repo, 'add', 'web', 'Remote title links to #1', '--specs', 'G1', '--criterion', 'title');
  box.run(demo.repo, 'milestone', 'add', 'Choose #1', '--note', 'Review #1 next.', '--items', '2,beacon-prose#2');
  box.run(demo.repo, 'shout', 'person', 'Choose #1 before shipping.', '--decision');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-prose-references-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("document.querySelector('#chain .row[data-item=\"2\"]')");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const contexts = [
        ['roadmap', '#roadmap .milestone h2 .ref', 'Local target'],
        ['roadmap', '#roadmap .milestone-note .ref', 'Local target'],
        ['roadmap', '#roadmap .milestone-item[data-go="item:2"]:not([data-board]) .t .ref', 'Local target'],
        ['roadmap', '#roadmap .milestone-item[data-board] .t .ref', 'Remote target'],
        ['spec', '#spec-list [data-row="spec:G3"] .ref', 'Local target'],
        ['doctrine', '#doctrine-list [data-row="doctrine:R1"] .ref', 'Local target'],
      ];
      for (const [tab, selector, target] of contexts) {
        await chrome.evaluate(`document.querySelector('[data-root=${JSON.stringify(demo.repo)}]').click();`);
        await chrome.waitFor("data?.project?.root === view.root && !document.body.classList.contains('switching') && document.querySelector('#proj-name').textContent === 'a-inline-prose'");
        await chrome.evaluate(`document.querySelector('[data-tab="${tab}"]').click()`);
        if (tab !== 'roadmap') await chrome.evaluate(`document.querySelector('[data-rows="${tab}:all"]').click()`);
        const metrics = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
          const ref = document.querySelector(${JSON.stringify(selector)});
          const row = ref?.closest('.milestone-item');
          const style = ref && getComputedStyle(ref);
          return { present:!!ref, title:ref?.title, border:style?.borderWidth, height:ref?.getBoundingClientRect().height,
            line:style && parseFloat(style.lineHeight), nested:!!ref?.parentElement.closest('button'),
            rowHeight:row?.getBoundingClientRect().height };
        })())`));
        assert.ok(metrics.present, `${width}: ${selector} contains its inline reference`);
        assert.equal(metrics.title, target, `${width}: the reference tooltip names the target on its own board`);
        assert.equal(metrics.border, '0px', `${width}: ${selector} has no box`);
        assert.ok(Math.abs(metrics.height - metrics.line) < 1, `${width}: ${selector} keeps the text line height`);
        assert.equal(metrics.nested, false, `${width}: ${selector} never nests buttons`);
        if (metrics.rowHeight !== undefined) assert.ok(metrics.rowHeight >= tapTarget(width), `${width}: the containing Roadmap control keeps its target`);
        await chrome.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
        await chrome.waitFor("!document.body.classList.contains('switching') && document.querySelector('[data-tab=items].on') && document.querySelector('#detail h2 > span')?.textContent === '#1'");
        assert.ok((await chrome.evaluate("document.querySelector('#detail h2').textContent")).includes(target), 'the reference opens its target title');
        assert.equal(await chrome.evaluate('view.root'), target === 'Remote target' ? other.repo : demo.repo, 'duplicate item numbers stay bound to their own board');
      }
      await chrome.evaluate(`document.querySelector('[data-tab="items"]').click(); document.querySelector('#chain .row[data-item="2"]').click()`);
      await chrome.waitFor("document.querySelector('#detail .verdict .note')");
      assert.equal(await chrome.evaluate("document.querySelectorAll('#detail .verdict .note .ref').length"), 1, 'verdict prose keeps its item reference');
      await chrome.evaluate("document.querySelector('#detail .verdict .note .ref').click()");
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Local target')");
      await chrome.evaluate("document.querySelector('#needs .row[data-go^=\"decide:\"]').click()");
      assert.equal(await chrome.evaluate("document.querySelectorAll('#answering-q .ref').length"), 1, 'the answering question keeps its inline item reference');
      await chrome.evaluate("document.querySelector('#answering-q .ref').click()");
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Local target') && document.querySelector('[data-tab=items].on')");
      await chrome.evaluate("document.querySelector('[data-tab=roadmap]').click(); document.querySelector('#roadmap .milestone-item[role=button]:not([data-board])').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))");
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Local title links to #1') && document.querySelector('[data-tab=items].on')");
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('wait references stay on one line and link to every prerequisite at phone and desktop widths [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for prerequisite layout checks.');
  const box = machine();
  const demo = project(box, 'waits-demo');
  box.run(demo.repo, 'add', 'web', 'Prerequisite one', '--specs', 'G1', '--criterion', 'finish first');
  box.run(demo.repo, 'add', 'web', 'Prerequisite two', '--specs', 'G1', '--criterion', 'finish second');
  box.run(demo.repo, 'add', 'web', 'Blocked item', '--specs', 'G1', '--criterion', 'wait on both', '--after', '1,2');
  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'waits-chrome'));
    /** Pick a visible click target only after scrolling and its hit-test position have settled. */
    const click = async (selector) => {
      const point = JSON.parse(await chrome.evaluate(`(async () => {
        const element=document.querySelector(${JSON.stringify(selector)});
        if (!element) throw Error('missing '+${JSON.stringify(selector)});
        const visible=()=>{const style=getComputedStyle(element),rect=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0&&!element.closest('[hidden]');};
        if(!visible())throw Error('target is not visible: '+${JSON.stringify(selector)});
        element.scrollIntoView({block:'center'});
        const point=()=>{const currentElement=document.querySelector(${JSON.stringify(selector)});if(!currentElement)return null;const style=getComputedStyle(currentElement),rect=currentElement.getBoundingClientRect();if(style.display==='none'||style.visibility==='hidden'||rect.width<=0||rect.height<=0||currentElement.closest('[hidden]'))return null;const x=rect.x+rect.width/2,y=rect.y+rect.height/2,hit=document.elementFromPoint(x,y);return {x,y,scrollX,scrollY,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},hit:!!hit&&(hit===currentElement||currentElement.contains(hit))};};
        const targets=[window,document,...(()=>{const nodes=[];for(let node=element.parentElement;node;node=node.parentElement)if(node.scrollHeight>node.clientHeight||node.scrollWidth>node.clientWidth)nodes.push(node);return nodes;})()];
        let scrolled=false,scrollEnded=false;
        const onScroll=()=>{scrolled=true;};
        const onScrollEnd=()=>{scrollEnded=true;};
        targets.forEach(target=>{target.addEventListener('scroll',onScroll,{passive:true});target.addEventListener('scrollend',onScrollEnd);});
        try {
          return JSON.stringify(await new Promise((resolve,reject)=>{
            let previous=null,stable=0,frameId=0,finished=false;
            const timeout=setTimeout(()=>{finished=true;cancelAnimationFrame(frameId);reject(Error('scroll did not settle for '+${JSON.stringify(selector)}+': '+JSON.stringify(previous)));},5000);
            const frame=()=>{
              if(finished)return;
              const current=point();
              if(!current){previous=null;stable=0;frameId=requestAnimationFrame(frame);return;}
              const same=previous&&Math.abs(current.scrollX-previous.scrollX)<=.1&&Math.abs(current.scrollY-previous.scrollY)<=.1&&Math.abs(current.rect.x-previous.rect.x)<=.1&&Math.abs(current.rect.y-previous.rect.y)<=.1&&Math.abs(current.rect.width-previous.rect.width)<=.1&&Math.abs(current.rect.height-previous.rect.height)<=.1;
              stable=same?stable+1:0;previous=current;
              if(stable>=3&&current.hit&&(!scrolled||scrollEnded||stable>=12)){finished=true;clearTimeout(timeout);resolve(current);return;}
              frameId=requestAnimationFrame(frame);
            };
            frameId=requestAnimationFrame(frame);
          }));
        } finally { targets.forEach(target=>{target.removeEventListener('scroll',onScroll);target.removeEventListener('scrollend',onScrollEnd);}); }
      })()`));
      const deadline = Date.now() + 5000;
      let ready;
      let settled = false;
      while (Date.now() < deadline) {
        ready = JSON.parse(await chrome.evaluate(`(async()=>{
          const sample=()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;const style=getComputedStyle(element),rect=element.getBoundingClientRect();if(style.display==='none'||style.visibility==='hidden'||rect.width<=0||rect.height<=0||element.closest('[hidden]'))return null;const x=rect.x+rect.width/2,y=rect.y+rect.height/2,hit=document.elementFromPoint(x,y);return {x,y,scrollX,scrollY,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},hit:!!hit&&(hit===element||element.contains(hit))};};
          let previous=null,stable=0,current=null,frameId=0,finished=false;
          await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{finished=true;cancelAnimationFrame(frameId);reject(Error('pointer target did not stabilize for '+${JSON.stringify(selector)}));},1500);const frame=()=>{if(finished)return;current=sample();const same=current&&previous&&Math.abs(current.scrollX-previous.scrollX)<=.1&&Math.abs(current.scrollY-previous.scrollY)<=.1&&Math.abs(current.rect.x-previous.rect.x)<=.1&&Math.abs(current.rect.y-previous.rect.y)<=.1&&Math.abs(current.rect.width-previous.rect.width)<=.1&&Math.abs(current.rect.height-previous.rect.height)<=.1;stable=same?stable+1:0;previous=current;if(stable>=2&&current.hit){finished=true;clearTimeout(timeout);resolve();}else frameId=requestAnimationFrame(frame);};frameId=requestAnimationFrame(frame);});
          return JSON.stringify(current);
        })()`));
        await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ready.x, y: ready.y });
        const underPointer = JSON.parse(await chrome.evaluate(`(async()=>{
          const sample=()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;const rect=element.getBoundingClientRect(),hit=document.elementFromPoint(${ready.x},${ready.y});return {scrollX,scrollY,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},hit:!!hit&&(hit===element||element.contains(hit))};};
          let previous=null,stable=0,current=null,frameId=0,finished=false;
          await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{finished=true;cancelAnimationFrame(frameId);reject(Error('pointer target did not stabilize for '+${JSON.stringify(selector)}));},1000);const frame=()=>{if(finished)return;current=sample();const same=current&&previous&&Math.abs(current.scrollX-previous.scrollX)<=.1&&Math.abs(current.scrollY-previous.scrollY)<=.1&&Math.abs(current.rect.x-previous.rect.x)<=.1&&Math.abs(current.rect.y-previous.rect.y)<=.1&&Math.abs(current.rect.width-previous.rect.width)<=.1&&Math.abs(current.rect.height-previous.rect.height)<=.1;stable=same?stable+1:0;previous=current;if(stable>=2&&current.hit){finished=true;clearTimeout(timeout);resolve();}else frameId=requestAnimationFrame(frame);};frameId=requestAnimationFrame(frame);});return JSON.stringify({current,stable});
        })()`));
        if (underPointer?.current?.hit && underPointer.stable >= 2 && Math.abs(underPointer.current.scrollX-ready.scrollX)<=.1 && Math.abs(underPointer.current.scrollY-ready.scrollY)<=.1 && Math.abs(underPointer.current.rect.x-ready.rect.x)<=.1 && Math.abs(underPointer.current.rect.y-ready.rect.y)<=.1 && Math.abs(underPointer.current.rect.width-ready.rect.width)<=.1 && Math.abs(underPointer.current.rect.height-ready.rect.height)<=.1) {
          point.x = ready.x;
          point.y = ready.y;
          point.scrollX = ready.scrollX;
          point.scrollY = ready.scrollY;
          point.rect = ready.rect;
          settled = true;
          break;
        }
      }
      assert.ok(settled && ready && point.x === ready.x && point.y === ready.y,
        `${selector}: scroll and target geometry settle under the pointer before press: ${JSON.stringify({ point, ready })}`);
      await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    };
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.querySelector('#chain [data-item="3"] .meta .gate')?.getBoundingClientRect().width > 0`);
      await click('#chain [data-item="1"] .t');
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Prerequisite one')");
      const itemIds = await chrome.evaluate('data.project.items.map(item => item.id + ":" + item.title + ":" + item.blockedBy.join(","))');
      assert.ok(await chrome.evaluate('!!document.querySelector(\'#chain [data-item="3"]\')'), `${width}: blocked item appears among ${itemIds.join('; ')}`);
      const list = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
        const gate=document.querySelector('#chain [data-item="3"] .meta .gate');
        const lineHeight=e=>parseFloat(getComputedStyle(e).lineHeight);
        const neighbors=[...gate.parentElement.children].filter(e=>e!==gate).map(lineHeight).filter(Number.isFinite);
        const units=[...gate.querySelectorAll('.wait-unit')];
        return {height:gate.getBoundingClientRect().height,neighborHeight:Math.max(...neighbors),unitWhiteSpaces:units.map(unit=>getComputedStyle(unit).whiteSpace),unitY:units.map(unit=>unit.getBoundingClientRect().y),links:[...gate.querySelectorAll('button.ref')].map(link=>link.dataset.go)};
      })())`));
      t.diagnostic(`${width}px list wait marker: ${list.height}px tall, neighboring metadata line ${list.neighborHeight}px`);
      assert.ok(list.height <= list.neighborHeight + 1, `${width}: list reference matches neighboring metadata height: ${JSON.stringify(list)}`);
      assert.deepEqual(list.unitWhiteSpaces, ['nowrap', 'nowrap'], `${width}: each list prerequisite stays intact`);
      assert.equal(new Set(list.unitY).size, 1, `${width}: both list prerequisites fit on one line: ${JSON.stringify(list)}`);
      assert.deepEqual(list.links, ['item:1', 'item:2'], `${width}: every prerequisite is a link`);

      await click('#chain [data-item="3"] .t');
      await chrome.waitFor("!!document.querySelector('#detail .kv dd.waits-on')");
      const detail = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
        const waits=document.querySelector('#detail .kv dd.waits-on');
        const units=[...waits.querySelectorAll('.wait-unit')];
        return {height:waits.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(waits).lineHeight),unitWhiteSpaces:units.map(unit=>getComputedStyle(unit).whiteSpace),unitY:units.map(unit=>unit.getBoundingClientRect().y),
          links:[...waits.querySelectorAll('button.ref')].map(link=>link.dataset.go)};
      })())`));
      t.diagnostic(`${width}px detail wait marker: ${detail.height}px tall, neighboring metadata line ${detail.lineHeight}px`);
      assert.ok(detail.height <= detail.lineHeight + 1, `${width}: detail prerequisite line matches its metadata: ${JSON.stringify(detail)}`);
      assert.deepEqual(detail.unitWhiteSpaces, ['nowrap', 'nowrap'], `${width}: each detail prerequisite stays intact`);
      assert.deepEqual(detail.links, ['item:1', 'item:2'], `${width}: detail links every prerequisite`);
      assert.equal(new Set(detail.unitY).size, 1, `${width}: detail links share one line: ${JSON.stringify(detail)}`);
      t.diagnostic(`${width}px detail wait links share y=${detail.unitY[0]}`);
      for (const [id, title] of [['1', 'Prerequisite one'], ['2', 'Prerequisite two']]) {
        await click('#chain [data-item="3"] .t');
        await chrome.waitFor("!!document.querySelector('#detail .kv dd.waits-on')");
        await click(`#detail .waits-on [data-go="item:${id}"]`);
        await chrome.waitFor(`document.querySelector('#detail h2').textContent.includes(${JSON.stringify(title)})`);
      }
    }
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught page exceptions');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});

/** Click what a page expression finds, through Chrome's own mouse input, as a person would. */
async function press(chrome, find) {
  const point = JSON.parse(await chrome.evaluate(`(async () => {
    const target = () => ${find};
    if (!target()) throw new Error(${JSON.stringify(`nothing to press: ${find}`)});
    target().scrollIntoView({ block: 'center' });
    // Press where the target is when the press arrives: opening an item on a phone scrolls its detail into
    // view, which moves the tab bar after it is measured (#255: measured at scroll 0, pressed at 32, landed on
    // main). So measure once the target, found afresh each frame since a refresh can redraw it, has held still
    // for two frames.
    const frame = () => new Promise((done) => requestAnimationFrame(() => done()));
    let last = '', still = 0;
    for (let n = 0; n < 240 && still < 2; n++) { await frame(); const now = target() ? (({ x, y, width, height }) => [x, y, width, height, scrollX, scrollY].join())(target().getBoundingClientRect()) : ''; still = now && now === last ? still + 1 : 0; last = now; }
    const element = target();
    if (!element) throw new Error(${JSON.stringify(`gone before the press: ${find}`)});
    const rect = element.getBoundingClientRect();
    // Keep where the press really lands, so a wait that follows it can say so when it fails.
    const name = (node) => node ? node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\\s+/).join('.') : '') : 'nothing';
    window.__pressed = { meant: name(element), at: Math.round(rect.y + rect.height / 2), scrollY: Math.round(scrollY) };
    document.addEventListener('mousedown', (event) => Object.assign(window.__pressed, { landed: name(event.target), landedAt: Math.round(event.clientY), scrolledTo: Math.round(scrollY) }), { capture: true, once: true });
    return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  })()`));
  await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}

/** Go back (-1) or forward (1) one entry in the tab's history, as the browser's own buttons do. */
async function travel(chrome, step) {
  const { currentIndex, entries } = await chrome.send('Page.getNavigationHistory');
  await chrome.send('Page.navigateToHistoryEntry', { entryId: entries[currentIndex + step].id });
}

/** Wait for a condition after a press; if it never arrives, say what the page shows and where the press landed. */
async function pressedInto(chrome, expression, timeoutMs = 10_000) {
  try {
    await chrome.waitFor(expression, timeoutMs);
  } catch (error) {
    const shows = await chrome.evaluate(`JSON.stringify({ panes: [...document.querySelectorAll('[data-pane]')].filter((each) => !each.hidden).map((each) => each.dataset.pane), address: location.pathname + location.search + location.hash, lit: document.querySelector('.tab.on')?.dataset.tab ?? null, viewTab: typeof view === 'object' ? view.tab : null, item: typeof view === 'object' ? view.item : null, scrollY: Math.round(scrollY), pressed: window.__pressed ?? null, entries: history.length })`).catch((failure) => 'an unreadable page: ' + failure.message);
    throw new Error(`${error.message}; the page shows ${shows}`, { cause: error });
  }
}

/** Wait for a page condition that may span a page load, when the page asked may still be loading. */
async function settled(chrome, expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await chrome.evaluate(expression)) return; } catch { /* The next page is still loading. */ }
    await browserPause(50);
  }
  throw new Error(`Browser condition did not arrive: ${expression}`);
}

/** A page expression for the Roadmap row showing an id, such as #3 or beacon#1. */
function roadmapRow(id) {
  return `[...document.querySelectorAll('#roadmap .milestone-item')].find((row) => row.querySelector('.id')?.textContent === ${JSON.stringify(id)})`;
}

/** A page expression that is true when only this pane shows, at this address. */
function showing(pane, address) {
  return `[...document.querySelectorAll('[data-pane]')].filter((each) => !each.hidden).map((each) => each.dataset.pane).join() === ${JSON.stringify(pane)} && location.pathname + location.hash === ${JSON.stringify(address)}`;
}

/**
 * The Roadmap as Chrome draws it: the address and the pane shown, the page's width, and each card
 * with its count, the share of its bar that is filled, its note and its rows. A row has the id and
 * chip label the person reads, the chip's tone and colours, its dot's colour, its tooltip and title,
 * and how many lines the title takes and whether it is cut with an ellipsis.
 */
async function readRoadmap(chrome) {
  return JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
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
          count: card.querySelector('.milestone-count')?.innerText ?? null,
          filled: bar ? Math.round(1000 * bar.querySelector('rect').getBoundingClientRect().width / bar.getBoundingClientRect().width) / 1000 : null,
          progress: bar ? [Number(bar.getAttribute('aria-valuenow')), Number(bar.getAttribute('aria-valuemax'))] : null,
          empty: card.querySelector('.milestone-empty')?.innerText ?? null,
          note: card.querySelector('.milestone-note')?.innerText ?? null,
          rows: [...card.querySelectorAll('.milestone-item')].map((row) => {
            const chip = row.querySelector('.chip'), title = row.querySelector('.t'), style = getComputedStyle(title), box = chip.getBoundingClientRect();
            return {
              id: row.querySelector('.id').innerText, label: chip.innerText, tone: [...chip.classList].filter((name) => name !== 'chip').join(' '),
              seen: box.width > 0 && box.height > 0 && getComputedStyle(chip).visibility === 'visible',
              chip: paint(chip), dot: getComputedStyle(row.querySelector('.dot')).backgroundColor,
              button: row.tagName === 'BUTTON', tip: row.title, title: [...title.childNodes].slice(1).map((node) => node.textContent).join(''),
              lines: Math.round(title.getBoundingClientRect().height / parseFloat(style.lineHeight)),
              cut: title.scrollWidth > title.clientWidth, ellipsis: style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap' && style.overflow === 'hidden',
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
  return JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    const bar = document.querySelector('#tabs'), tabs = [...bar.querySelectorAll('.tab')], picked = tabs.find((tab) => tab.classList.contains('on'));
    const layouts = tabs.map((on) => {
      tabs.forEach((tab) => tab.classList.toggle('on', tab === on));
      return { on: on.dataset.tab, bar: [bar.getBoundingClientRect().left, bar.getBoundingClientRect().right], tabs: tabs.map((tab) => {
        const range = document.createRange();
        range.selectNodeContents(tab.firstChild);
        const box = tab.getBoundingClientRect(), label = range.getBoundingClientRect();
        return { tab: tab.dataset.tab, left: box.left, right: box.right, labelLeft: label.left, labelRight: label.right };
      }) };
    });
    tabs.forEach((tab) => tab.classList.toggle('on', tab === picked));
    return { client: document.documentElement.clientWidth, layouts };
  })())`));
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
    await chrome.evaluate(`document.documentElement.dataset.theme = '${theme}'`);
    const height = await chrome.evaluate('Math.ceil(document.documentElement.scrollHeight)');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: Math.max(900, height), deviceScaleFactor: 2, mobile: false });
    await browserPause(150);
    const shot = await chrome.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.PULLBOARD_ROADMAP_PROOF, `${name}-${width}-${theme}.png`), Buffer.from(shot.data, 'base64'));
  }
  await chrome.evaluate('delete document.documentElement.dataset.theme');
  await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
}

test('the roadmap reads every item as the Items tab does, opens each one, another repo\'s too, and keeps its own address [N26,N38]', { timeout: 150_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for roadmap browser checks.');
  const box = machine();
  const alpha = project(box, 'roadmap-demo');
  const beacon = project(box, 'beacon');
  const long = 'A deliberately long title that runs past the width of a phone and keeps going, far enough to be cut on a wide desktop card as well';
  const titles = ['Merged greeting page', 'Verified farewell page', 'Session timeout banner', 'Upload progress bar', 'Live search results', long, 'Withdrawn experiment'];
  for (const title of titles) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  // One item in each state: verified and merged, verified, sent back, to verify, building, open, withdrawn.
  build(box, alpha, 1, 'one.txt');
  accept(box, alpha, 1);
  const itemCommit = box.git(alpha.repo, 'rev-parse', alpha.branch);
  box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', alpha.branch);
  const trunkCommit = box.git(alpha.repo, 'rev-parse', 'HEAD');
  assert.notEqual(trunkCommit, itemCommit, 'the Roadmap receipt names the trunk merge commit');
  box.run(alpha.repo, 'merged', '1', trunkCommit);
  build(box, alpha, 2, 'two.txt');
  accept(box, alpha, 2);
  build(box, alpha, 3, 'three.txt');
  sendBack(box, alpha, 3, 'the banner does not time out yet');
  build(box, alpha, 4, 'four.txt');
  box.run(alpha.web, 'claim', '5');
  box.run(alpha.repo, 'withdraw', '7', 'no longer needed');
  // Another repo's item, sent back on its own board.
  box.run(beacon.repo, 'add', 'web', 'Billing webhook retries', '--specs', 'G1', '--criterion', 'retries');
  build(box, beacon, 1, 'retry.txt');
  sendBack(box, beacon, 1, 'retry twice before failing');
  box.run(alpha.repo, 'milestone', 'add', 'Launch', '--note', 'Ships when the review lands; your call on the name.', '--items', '1,2,3,4,beacon#1');
  box.run(alpha.repo, 'milestone', 'add', 'Next', '--note', 'Queued behind Launch.', '--items', '5,6,7');
  box.run(alpha.repo, 'milestone', 'add', 'Later', '--note', 'Ideas not filed yet.');
  // What the person reads on each row: the Items tab's word for the item's state, and its colour's class.
  const words = [
    { id: '#1', label: 'verified', tone: 'ok' },
    { id: '#2', label: 'verified', tone: 'ok' },
    { id: '#3', label: 'sent back', tone: 'no' },
    { id: '#4', label: 'to verify', tone: 'warn' },
    { id: 'beacon#1', label: 'sent back', tone: 'no' },
    { id: '#5', label: 'building', tone: 'busy' },
    { id: '#6', label: 'unclaimed', tone: 'free' },
    { id: '#7', label: 'withdrawn', tone: '' },
  ];
  const view = await startView(box);
  const roadmap = `/roadmap${view.link.search}`;
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-chrome-'));
  let chrome;
  try {
    const direct = await fetchLive(new URL(roadmap, view.link));
    assert.equal(direct.status, 200, 'the view serves its page at /roadmap, behind its secret');
    assert.equal((await fetchLive(new URL('/roadmap', view.link))).status, 403, 'and nothing there without the secret');
    chrome = await openSnapshotChrome(executable, new URL(roadmap, view.link).href, profile);
    const consoleErrors = [];
    chrome.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') consoleErrors.push(message.params.entry.text);
    });
    await chrome.send('Log.enable');
    await settled(chrome, `!!data?.project && ${showing('roadmap', '/roadmap')} && document.querySelectorAll('#roadmap .milestone').length === 3`);

    let seen;
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && ${showing('roadmap', '/roadmap')}`);
      seen = await readRoadmap(chrome);
      assert.deepEqual([seen.address, seen.shown, seen.tab], [roadmap, ['roadmap'], 'roadmap'], `${width}: the direct address shows the Roadmap tab, and only it`);
      assert.ok(seen.document <= seen.client && seen.body <= seen.client, `${width}: no sideways scroll: ${JSON.stringify(seen)}`);
      assert.deepEqual(seen.cards.map((card) => card.name), ['Launch', 'Next', 'Later'], `${width}: a card for each milestone, in order`);
      assert.deepEqual(seen.cards.map((card) => card.note), ['Ships when the review lands; your call on the name.', 'Queued behind Launch.', 'Ideas not filed yet.'], `${width}: each card's note`);
      assert.deepEqual(seen.cards.map((card) => [card.count, card.progress, card.filled]), [['2/5 done', [2, 5], 0.4], ['0/3 done', [0, 3], 0], [null, null, null]], `${width}: counts and bars say how many items are verified`);
      assert.deepEqual([seen.cards[2].empty, seen.cards[2].rows.length], ['No items yet.', 0], `${width}: an empty milestone says so, with no bar or count`);
      const rows = seen.cards.flatMap((card) => card.rows);
      assert.deepEqual(rows.map(({ id, label, tone }) => ({ id, label, tone })), words, `${width}: each chip shows the word and colour the Items tab gives its item's state`);
      assert.ok(rows.every((row) => row.seen), `${width}: every chip is on screen`);
      assert.deepEqual(rows.map((row) => row.title), [...titles.slice(0, 4), 'Billing webhook retries', ...titles.slice(4)], `${width}: each row names its item`);
      assert.deepEqual(rows.map((row) => row.tip), rows.map((row) => row.title), `${width}: each row's tooltip is its whole title`);
      assert.ok(rows.every((row) => row.lines === 1 && row.ellipsis), `${width}: every title holds one line, set to end in an ellipsis: ${JSON.stringify(rows)}`);
      assert.ok(rows.find((row) => row.id === '#6').cut, `${width}: the long title is cut, so its ellipsis shows`);
      assert.ok(rows.every((row) => row.button), `${width}: every item opens, another repo's included`);

      const bar = await tabBar(chrome);
      for (const layout of bar.layouts) {
        const place = `${width} with ${layout.on} picked`;
        assert.equal(layout.tabs.length, 6, `${place}: six tabs`);
        for (const tab of layout.tabs) assert.ok(tab.labelLeft >= tab.left + 2 && tab.labelRight <= tab.right - 2, `${place}: ${tab.tab}'s label sits inside its highlight: ${JSON.stringify(tab)}`);
        layout.tabs.forEach((tab, n) => { if (n) assert.ok(tab.left >= layout.tabs[n - 1].right - 0.5, `${place}: ${tab.tab} starts after the tab before it ends`); });
        assert.ok(layout.tabs[0].left >= layout.bar[0] - 0.5 && layout.tabs.at(-1).right <= layout.bar[1] + 0.5 && layout.bar[1] <= bar.client, `${place}: the tab bar fits on screen: ${JSON.stringify(layout)}`);
      }
      await proofShot(chrome, 'roadmap', width);

      // An item opens on the Items tab; Back shows the Roadmap at its address again, Forward the item.
      await press(chrome, roadmapRow('#3'));
      await pressedInto(chrome, `${showing('items', '/')} && document.querySelector('#detail h2')?.innerText.includes('Session timeout banner')`);
      assert.equal(await chrome.evaluate('location.search'), view.link.search, `${width}: the address keeps the rest of itself`);
      await travel(chrome, -1);
      await settled(chrome, `${showing('roadmap', '/roadmap')} && document.querySelector('.tab.on')?.dataset.tab === 'roadmap'`);
      await travel(chrome, 1);
      await settled(chrome, `${showing('items', '/')} && document.querySelector('.tab.on')?.dataset.tab === 'items' && document.querySelector('#detail h2')?.innerText.includes('Session timeout banner')`);
      await press(chrome, `document.querySelector('[data-tab="roadmap"]')`);
      await pressedInto(chrome, `${showing('roadmap', '/roadmap')} && location.search === ${JSON.stringify(view.link.search)}`);
    }

    // Another repo's item opens on its own board, and Back and Forward move between the two boards.
    await press(chrome, roadmapRow('beacon#1'));
    await chrome.waitFor(`document.querySelector('#proj-name').textContent === 'beacon' && ${showing('items', '/')} && document.querySelector('#detail h2')?.innerText.includes('Billing webhook retries')`);
    const there = JSON.parse(await chrome.evaluate(`JSON.stringify((() => { const chip = document.querySelector('#detail .meta .chip'); return {
      id: document.querySelector('#detail h2 span').innerText, label: chip.innerText, chip: getComputedStyle(chip).color + ' on ' + getComputedStyle(chip).backgroundColor,
      dot: getComputedStyle(document.querySelector('#chain [data-item="1"] .dot')).backgroundColor }; })())`));
    const crossed = seen.cards[0].rows.find((row) => row.id === 'beacon#1');
    assert.deepEqual(there, { id: '#1', label: crossed.label, chip: crossed.chip, dot: crossed.dot }, "the other repo's Items tab shows that item with the Roadmap's word and colours");
    await travel(chrome, -1);
    await settled(chrome, `document.querySelector('#proj-name').textContent === 'roadmap-demo' && ${showing('roadmap', '/roadmap')} && !!${roadmapRow('beacon#1')}`);
    await travel(chrome, 1);
    await settled(chrome, `document.querySelector('#proj-name').textContent === 'beacon' && ${showing('items', '/')} && document.querySelector('#detail h2')?.innerText.includes('Billing webhook retries')`);
    await travel(chrome, -1);
    await settled(chrome, `document.querySelector('#proj-name').textContent === 'roadmap-demo' && ${showing('roadmap', '/roadmap')} && !!${roadmapRow('#1')}`);

    // Each of this board's rows opens its item on the Items tab, which gives it the same word and
    // colours, its list dot included; a withdrawn item is left out of the list while browsing.
    for (const row of seen.cards.flatMap((card) => card.rows).filter((each) => each.id.startsWith('#'))) {
      await press(chrome, roadmapRow(row.id));
      await chrome.waitFor(`${showing('items', '/')} && document.querySelector('#detail h2 span')?.innerText === ${JSON.stringify(row.id)}`);
      const here = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
        const chip = document.querySelector('#detail .meta .chip'), dot = document.querySelector('#chain [data-item="${row.id.slice(1)}"] .dot');
        return { label: chip.innerText, chip: getComputedStyle(chip).color + ' on ' + getComputedStyle(chip).backgroundColor, dot: dot ? getComputedStyle(dot).backgroundColor : 'not listed' };
      })())`));
      assert.deepEqual(here, { label: row.label, chip: row.chip, dot: row.label === 'withdrawn' ? 'not listed' : row.dot }, `${row.id}: the Items tab shows it with the Roadmap's word and colours`);
      await travel(chrome, -1);
      await settled(chrome, `${showing('roadmap', '/roadmap')} && !!${roadmapRow(row.id)}`);
    }

    // It updates live as items move, here and on the other repo's board.
    accept(box, alpha, 4);
    await chrome.waitFor(`${roadmapRow('#4')}?.querySelector('.chip').innerText === 'verified' && document.querySelector('#roadmap .milestone-count').innerText === '3/5 done'`, 15_000);
    box.run(beacon.web, 'claim', '1');
    await chrome.waitFor(`${roadmapRow('beacon#1')}?.querySelector('.chip').innerText === 'building'`, 15_000);

    // A board with no milestones says how one starts; the address stays the Roadmap's.
    await press(chrome, `document.querySelector('[data-root=${JSON.stringify(beacon.repo)}]')`);
    await chrome.waitFor(`document.querySelector('#proj-name').textContent === 'beacon' && ${showing('roadmap', '/roadmap')} && document.querySelector('#roadmap').innerText.startsWith('No milestones yet.')`);
    await press(chrome, `document.querySelector('[data-root=${JSON.stringify(alpha.repo)}]')`);
    await chrome.waitFor(`document.querySelector('#proj-name').textContent === 'roadmap-demo' && !!${roadmapRow('#1')}`);

    // A reload keeps the Roadmap. The board's own address shows the tab last picked there, never the
    // Roadmap, even when the Roadmap was picked last.
    await chrome.send('Page.reload');
    await settled(chrome, `!!data?.project && ${showing('roadmap', '/roadmap')} && !!${roadmapRow('#1')}`);
    await press(chrome, `document.querySelector('[data-tab="shouts"]')`);
    await chrome.waitFor(showing('shouts', '/'));
    await press(chrome, `document.querySelector('[data-tab="roadmap"]')`);
    await chrome.waitFor(showing('roadmap', '/roadmap'));
    await chrome.send('Page.navigate', { url: view.link.href });
    await settled(chrome, `!!data?.project && ${showing('shouts', '/')} && document.querySelector('.tab.on')?.dataset.tab === 'shouts'`);
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught page exceptions');
    assert.deepEqual(consoleErrors, [], 'Chrome reports no console errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('an exported roadmap has its own address under a folder, and Back and Forward return to it [N38,A10]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for exported roadmap checks.');
  const box = machine();
  const alpha = project(box, 'roadmap-snapshot');
  const beacon = project(box, 'beacon');
  box.run(alpha.repo, 'add', 'web', 'Verified page', '--specs', 'G1', '--criterion', 'renders');
  box.run(alpha.repo, 'add', 'web', 'Open page', '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 1, 'one.txt');
  accept(box, alpha, 1);
  box.run(beacon.repo, 'add', 'web', 'Billing webhook retries', '--specs', 'G1', '--criterion', 'retries');
  box.run(alpha.repo, 'milestone', 'add', 'Launch', '--note', 'Ships with the snapshot.', '--items', '1,2,beacon#1');
  box.run(alpha.repo, 'milestone', 'add', 'Later');
  const folder = join(box.dir, 'roadmap-export');
  box.run(alpha.repo, 'view', '--export', folder);
  const host = await serveFolder(folder, '/demo/');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-export-chrome-'));
  const ready = "document.body.classList.contains('snapshot') && !!data?.project && snapshotReplay.index === snapshotReplay.events.length";
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `${host.base}/demo/`, profile);
    await settled(chrome, `${ready} && ${showing('items', '/demo/')}`);
    await press(chrome, `document.querySelector('[data-tab="roadmap"]')`);
    await chrome.waitFor(showing('roadmap', '/demo/#roadmap'));
    const seen = await readRoadmap(chrome);
    assert.deepEqual(seen.cards[0].rows.map(({ id, label, tone, button }) => ({ id, label, tone, button })), [
      { id: '#1', label: 'verified', tone: 'ok', button: true },
      { id: '#2', label: 'unclaimed', tone: 'free', button: true },
      { id: 'beacon#1', label: 'unclaimed', tone: 'free', button: false },
    ], "the snapshot's rows read as its Items tab does; another repo's item, not in the snapshot, opens nothing");
    assert.equal(seen.cards[0].rows[2].tip, 'Billing webhook retries (not in this snapshot)', 'and says why');
    assert.deepEqual([seen.cards[1].name, seen.cards[1].empty], ['Later', 'No items yet.']);

    // The address survives a reload on a static host, and Back and Forward show the tab it names,
    // whether the browser keeps the page for an entry or loads it again.
    await chrome.send('Page.reload');
    await settled(chrome, `${ready} && ${showing('roadmap', '/demo/#roadmap')} && !!${roadmapRow('#1')}`);
    await travel(chrome, -1);
    await settled(chrome, `${ready} && ${showing('items', '/demo/')}`);
    await travel(chrome, 1);
    await settled(chrome, `${ready} && ${showing('roadmap', '/demo/#roadmap')} && !!${roadmapRow('#2')}`);
    await press(chrome, roadmapRow('#2'));
    await chrome.waitFor(`${showing('items', '/demo/')} && document.querySelector('#detail h2')?.innerText.includes('Open page')`);
    await travel(chrome, -1);
    await settled(chrome, `${ready} && ${showing('roadmap', '/demo/#roadmap')}`);

    // Opened afresh, the folder shows the board's tab, and its #roadmap address the Roadmap.
    for (const [address, pane] of [['/demo/', 'items'], ['/demo/#roadmap', 'roadmap']]) {
      await chrome.send('Page.navigate', { url: 'about:blank' });
      await settled(chrome, "location.href === 'about:blank'");
      await chrome.send('Page.navigate', { url: `${host.base}${address}` });
      await settled(chrome, `${ready} && ${showing(pane, address)}`);
    }
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      const layout = await readRoadmap(chrome);
      assert.ok(layout.document <= layout.client && layout.body <= layout.client, `${width}: no sideways scroll in the snapshot: ${JSON.stringify(layout)}`);
      await proofShot(chrome, 'snapshot-roadmap', width);
    }
    assert.deepEqual(host.requests.filter((request) => !request.path.startsWith('/demo/') || request.status !== 200), [], 'every request stays in the folder and finds its file');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught page exceptions');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await host.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('the board reads at a glance from the status bar [N26]', { timeout: 180_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for status bar checks.');

  const box = machine();
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, api: { owns: ['api/'], specs: ['G'] } };
  const spec = `${SPEC}- G3 [approved, must] The page has a footer. | gate: web test\n- G4 [approved, must] The page has a header. | gate: web test\n`;
  const alpha = project(box, 'glance', spec, { lanes });
  const add = (lane, title, ...more) => box.run(alpha.repo, 'add', lane, title, '--specs', 'G1', '--criterion', 'renders', ...more);
  add('web', 'Free', '--specs', 'G1,G2,G3,G4');
  add('web', 'Base');
  add('web', 'Depends', '--after', '2');
  add('api', 'Api work');
  add('web', 'Shipped');
  add('web', 'Bounced');
  add('web', 'Done');
  build(box, alpha, 5, 'shipped.html');
  build(box, alpha, 6, 'bounced.html');
  build(box, alpha, 7, 'done.html');
  sendBack(box, alpha, 6, 'the footer is missing\nand more on the next line');
  accept(box, alpha, 7);
  box.run(alpha.web, 'claim', '2');
  box.run(alpha.repo, 'hold', 'api', '--reason', 'API freeze');
  box.run(alpha.repo, 'milestone', 'add', '1.0: first cut', '--note', 'The first pages', '--items', '1,5,7');
  box.run(alpha.repo, 'milestone', 'add', '2.0: the rest', '--note', 'After the first cut', '--items', '2,3,4');
  const second = join(box.dir, 'glance-web-2');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/glance2');
  box.run(second, 'join', 'web');
  box.run(second, 'shout', 'coordinator', 'Free when you need me.');
  box.run(alpha.repo, 'shout', 'web', 'Pages first, then the footer.');
  box.run(alpha.web, 'shout', 'coordinator', 'Which colour for the button?', '--decision');

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-glance-chrome-'));
  let chrome;
  /** The page as it reads: the header, the bar's parts, the list's rows and the toolbar, measured where they stand. */
  const read = async () => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const rgb = (css) => { const n = (css.match(/[\\d.]+/g) || []).map(Number); return css.startsWith('color(srgb') ? [n[0] * 255, n[1] * 255, n[2] * 255, n[3] ?? 1] : [n[0], n[1], n[2], n[3] ?? 1]; };
    const words = (e) => [...e.children].map((child) => child.textContent.replace(/\\s+/g, ' ').trim()).join(' ');
    const probe = document.createElement('i');
    probe.style.color = 'var(--warn)';
    document.body.append(probe);
    const warn = getComputedStyle(probe).color;
    probe.remove();
    const rows = [...document.querySelectorAll('#chain .row')].map((row) => {
      const s = getComputedStyle(row), why = row.querySelector('.meta .why b');
      return { id: row.dataset.item, row: box(row), title: box(row.querySelector('.t')), age: box(row.querySelector('.row-age')),
        meta: words(row.querySelector('.meta')), chip: row.querySelector(':scope > .chip')?.textContent ?? null,
        why: why ? { text: why.textContent, color: getComputedStyle(why).color } : null, gated: row.classList.contains('gated'),
        border: rgb(s.borderTopColor), borderWidth: s.borderTopWidth, edges: [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor].every((c) => c === s.borderTopColor),
        tint: rgb(s.backgroundColor) };
    });
    const status = document.querySelector('.status');
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
      tabs: [...document.querySelectorAll('#tabs .tab')].map((tab) => tab.textContent),
      header: document.querySelector('.top').innerText.replace(/\\s+/g, ' ').trim(), live: document.querySelector('#live').textContent, liveInBar: !!document.querySelector('.status #live'),
      bar: [...document.querySelectorAll('.status [data-status]')].filter((part) => !part.hidden).map((part) => ({ to: part.dataset.status, text: part.textContent.replace(/\\s+/g, ' ').trim(), height: part.getBoundingClientRect().height })),
      barShown: getComputedStyle(status).display !== 'none', barBox: box(status), barTint: rgb(getComputedStyle(status).backgroundColor), barBlur: getComputedStyle(status).backdropFilter,
      rows, warn, state: view.state, lane: view.lane, tab: view.tab,
      chips: [...document.querySelectorAll('#state-chips button')].map((chip) => [chip.firstChild.textContent, chip.querySelector('b').textContent, chip.classList.contains('on')]),
      lanes: [...document.querySelectorAll('#lane-pick option')].map((option) => option.textContent), pick: box(document.querySelector('#lane-pick')),
      seg: box(document.querySelector('#state-chips')), go: box(document.querySelector('#new-item')), toolbar: box(document.querySelector('.toolbar')),
      waiting: (() => { const fold = document.querySelector('.asks-toggle[data-fold="waiting"]'); return fold && { text: fold.textContent.replace(/\\s+/g, ' ').trim(), open: fold.getAttribute('aria-expanded'), height: fold.getBoundingClientRect().height, offset: fold.getBoundingClientRect().top - fold.closest('.shouts-card').getBoundingClientRect().top, cards: document.querySelectorAll('#decisions .shout').length }; })(),
      idle: (() => { const fold = document.querySelector('#agents .fold-line[data-fold="idle"]'); return fold && { text: words(fold), open: fold.getAttribute('aria-expanded'), height: fold.getBoundingClientRect().height, pills: document.querySelectorAll('#agents .agent-pill').length }; })(),
      agentRows: [...document.querySelectorAll('#agents .agent-card')].filter((card) => card.getBoundingClientRect().height > 0).length,
    };
  })())`));
  const part = (r, to) => r.bar.find((p) => p.to === to);
  const number = (p) => Number(/^(\d+)/.exec(p?.text ?? '')?.[1] ?? NaN);
  const click = async (selector) => chrome.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const settle = () => chrome.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
  /** Pick a lane the way the picker does: its value, then its change event. */
  const lane = async (name) => { await chrome.evaluate(`(() => { const pick = document.querySelector('#lane-pick'); pick.value = ${JSON.stringify(name)}; pick.dispatchEvent(new Event('change')); })()`); await settle(); };
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.project?.items?.length === 7 && !!document.querySelector('.status [data-status=\"items\"]')");
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        await click('[data-tab=items]');
        await click('[data-state=active]');
        await settle();
        const at = `${width}px ${scheme}`;
        const r = await read();
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll: ${JSON.stringify(r.page)}`);
        // The header carries the tabs and nothing else: no counts, no clock.
        assert.deepEqual(r.tabs, ['Items', 'Shouts', 'Spec', 'Doctrine', 'Activity', 'Roadmap'], `${at}: the tabs carry no counts`);
        assert.ok(r.live === '' && r.liveInBar && !/live|\d\d:\d\d/.test(r.header), `${at}: a live board says nothing in the header: ${r.header}`);
        // On a phone the bar stays out of the way while the board is live.
        if (width === 375) assert.equal(r.barShown, false, `${at}: no status bar on a phone while live`);
        // The bar: a frosted strip along the foot, the counts the tabs used to carry, and a part only where there is one.
        if (width === 1280) {
          assert.ok(Math.abs(r.barBox.bottom - 900) <= 1 && r.barBox.left === 0 && Math.abs(r.barBox.width - r.page.width) <= 1, `${at}: the bar runs along the foot: ${JSON.stringify(r.barBox)}`);
          assert.ok(r.barTint[3] > 0 && r.barTint[3] < 1 && /blur/.test(r.barBlur), `${at}: the bar is see-through and frosted: ${JSON.stringify([r.barTint, r.barBlur])}`);
          assert.deepEqual(r.bar.map((p) => p.to).filter((to) => !to.startsWith('item:') && to !== 'activity'), ['items', 'agents', 'verify', 'gated', 'release'], `${at}: items, agents, to verify, gated and the release, then the last event: ${JSON.stringify(r.bar)}`);
          assert.deepEqual([part(r, 'items').text, part(r, 'verify').text, part(r, 'gated').text, part(r, 'release').text], ['6 items', '1 to verify', '2 gated', '1.0: first cut 1/3'], `${at}: what the parts say`);
        }
        // Rows: two lines, the age at the top right, the lane and up to three spec ids below, or the verdict instead.
        const row = Object.fromEntries(r.rows.map((x) => [x.id, x]));
        assert.deepEqual(r.rows.map((x) => x.id).sort(), ['1', '2', '3', '4', '5', '6'], `${at}: the active items`);
        const heights = r.rows.map((x) => Math.round(x.row.height));
        assert.ok(Math.max(...heights) - Math.min(...heights) <= 1 && Math.max(...heights) <= 64, `${at}: every row two lines and as tall as the next: ${heights}`);
        for (const x of r.rows) {
          assert.ok(x.row.right - x.age.right <= 14 && x.age.top < x.title.bottom && x.age.bottom > x.title.top, `${at}: #${x.id}'s age stands at the top right: ${JSON.stringify([x.row, x.title, x.age])}`);
        }
        assert.equal(row['1'].meta, 'web G1, G2, G3 +1', `${at}: the lane and the first three spec ids, then how many more`);
        assert.deepEqual([row['6'].why?.text, row['6'].why?.color === r.warn, /\bweb\b/.test(row['6'].meta.replace('BEHAVIOR_MISMATCH', '')), /next line/.test(row['6'].meta)], ['BEHAVIOR_MISMATCH', true, false, false],
          `${at}: a sent-back row says why in the warning colour, first line only, in place of its lane: ${row['6'].meta}`);
        // Blocked: a red outline on every side, and what it waits on beside the gated chip. Waiting on a verdict: shaded gold.
        for (const id of ['3', '4']) {
          const [red, green, blue] = row[id].border;
          assert.ok(row[id].gated && row[id].edges && row[id].borderWidth === '1px' && red > green + 30 && red > blue + 30, `${at}: #${id} has a red outline: ${JSON.stringify(row[id])}`);
        }
        assert.match(row['3'].meta, /waits on #2$/, `${at}: #3 says what it waits on`);
        assert.equal(row['3'].chip, 'gated');
        const [tr, tg, tb] = row['5'].tint;
        assert.ok(tr >= tg && tg > tb && row['5'].tint.join() !== row['1'].tint.join(), `${at}: a row waiting on a verdict is shaded gold: ${JSON.stringify([row['5'].tint, row['1'].tint])}`);
        if (scheme === 'dark') {
          const [gr, gg, gb] = row['5'].border;
          assert.ok(row['5'].edges && gr > gb + 30 && gg > gb + 20, `${at}: in dark it has a gold outline too: ${row['5'].border}`);
        }
        // The toolbar is the states, the lane picker and New item on one line; on a phone, as the person chose (#368), the
        // states and New item, with the lane picker dropped.
        assert.deepEqual(r.lanes, ['All lanes', 'web · 5', 'api · 1'], `${at}: each lane with its count under Active`);
        const centre = (b) => b.top + b.height / 2;
        if (width === 1280) assert.ok(Math.abs(centre(r.seg) - centre(r.pick)) <= 4 && Math.abs(centre(r.pick) - centre(r.go)) <= 4, `${at}: one line: ${JSON.stringify([r.seg, r.pick, r.go])}`);
        else assert.ok(r.pick.width === 0 && Math.abs(centre(r.seg) - centre(r.go)) <= 4, `${at}: the states and New item on one line, no lane picker: ${JSON.stringify([r.seg, r.pick, r.go, r.toolbar])}`);
      }
    }

    // Each part opens exactly what it counts: its number is the length of the list it opens.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.waitFor('innerWidth === 1280');
    await click('[data-state=all]');
    let r = await read();
    for (const [to, state, label] of [['verify', 'verify', 'To verify'], ['gated', 'gated', 'Gated'], ['items', 'active', 'Active']]) {
      const n = number(part(r, to));
      await click(`.status [data-status="${to}"]`);
      await chrome.waitFor(`view.tab === 'items' && view.state === '${state}'`);
      await settle();
      r = await read();
      const on = r.chips.find(([, , isOn]) => isOn);
      assert.deepEqual([on?.[0], Number(on?.[1]), r.rows.length], [label, n, n], `${to}: the bar's ${n} opens ${label}, which counts and lists the same ${n}: ${JSON.stringify(r.chips)}`);
      if (to === 'gated') assert.ok(r.rows.every((x) => x.gated), 'every row it opens is a gated row');
    }
    await click('[data-state=active]');
    await click('.status [data-status="agents"]');
    await chrome.waitFor("view.tab === 'shouts' && !document.querySelector('[data-pane=shouts]').hidden");
    r = await read();
    assert.ok(r.agentRows > 0 && number(part(r, 'agents')) === r.agentRows, `the agents part counts the ${r.agentRows} rows of the agents panel it opens`);
    // Hidden by the person, the panel comes back when the part that counts its rows is opened.
    await click('.panel-head [data-agents-toggle]');
    await chrome.waitFor('view.agentsHidden === true');
    await click('[data-tab=items]');
    await click('.status [data-status="agents"]');
    await chrome.waitFor("view.tab === 'shouts' && view.agentsHidden === false");
    r = await read();
    assert.ok(r.agentRows > 0 && number(part(r, 'agents')) === r.agentRows, `hidden, the panel comes back with the ${r.agentRows} agents the part counts`);
    // The release part opens the Roadmap on that release alone: its rows are the ones it counts.
    await click('.status [data-status="release"]');
    await chrome.waitFor("view.tab === 'roadmap'");
    const roadmapRows = () => chrome.evaluate("document.querySelectorAll('#roadmap .milestone-item').length");
    assert.deepEqual([await chrome.evaluate("[...document.querySelectorAll('#roadmap .milestone h2')].map((h) => h.textContent).join()"), await roadmapRows()], ['1.0: first cut', 3],
      'the release the part counts, and only its three items');
    await click('#roadmap [data-roadmap-all]');
    assert.equal(await roadmapRows(), 6, 'show all brings back every release');
    const last = r.bar.find((p) => p.to.startsWith('item:'));
    if (last) {
      await click(`.status [data-status="${last.to}"]`);
      await chrome.waitFor(`view.tab === 'items' && view.item === ${Number(last.to.slice(5))}`);
    }

    // Lanes narrow the list as states do, each counting within the other's choice.
    await click('[data-state=active]');
    await lane('api');
    r = await read();
    assert.deepEqual([r.lane, r.rows.map((x) => x.id), r.chips.find(([name]) => name === 'Active')[1], r.chips.find(([name]) => name === 'Verified')[1]], ['api', ['4'], '1', '0'], 'api narrows the list and the state counts');
    await lane('');
    await click('[data-state=verified]');
    await lane('web');
    r = await read();
    assert.deepEqual([r.lane, r.rows.map((x) => x.id), r.lanes], ['web', ['7'], ['All lanes', 'web · 1']], 'under Verified the lanes count what is verified');
    await lane('');
    await click('[data-state=active]');

    // Shouts: asks waiting on others and idle agents each fold to one line, closed until opened.
    await click('[data-tab=shouts]');
    await chrome.waitFor("!document.querySelector('[data-pane=shouts]').hidden && !!document.querySelector('.asks-toggle[data-fold=\"waiting\"]')");
    r = await read();
    const shut = r.waiting.offset;
    assert.deepEqual([r.waiting.text, r.waiting.open, r.waiting.cards], ['1 ask waiting ▾', 'false', 0], `the ask waiting on others folds to a toggle on the composer line: ${JSON.stringify(r.waiting)}`);
    assert.ok(/^\d+ idle show$/.test(r.idle.text) && r.idle.open === 'false' && r.idle.pills === 0, `the idle agents fold to a line: ${JSON.stringify(r.idle)}`);
    await click('.asks-toggle[data-fold="waiting"]');
    await click('#agents .fold-line[data-fold="idle"]');
    r = await read();
    assert.deepEqual([r.waiting.open, r.waiting.cards, r.idle.open, r.idle.pills > 0], ['true', 1, 'true', true], 'each opens on a click');
    assert.equal(r.waiting.offset, shut, 'and the line stays where it was as its cards open under it');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375');
    r = await read();
    assert.ok(r.waiting.height >= 44 && r.idle.height >= 44, 'each fold line is a 44px target');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1280');

    // A shout that lands while Items is open counts as unread in the bar. The part opens exactly that shout, not the ones
    // already read beside it, and opening it reads it; show all brings the rest back.
    await click('[data-tab=items]');
    const alreadyRead = await chrome.evaluate('data.project.shouts.length');
    assert.ok(alreadyRead >= 2, `shouts the person has already read: ${alreadyRead}`);
    box.run(alpha.web, 'shout', 'coordinator', 'web-1 is on it');
    await chrome.waitFor("!document.querySelector('#status-unread')?.hidden && document.querySelector('#status-unread')?.textContent === '1 unread'", 15_000);
    await click('#status-unread');
    await chrome.waitFor("view.tab === 'shouts' && document.querySelector('#status-unread')?.hidden === true");
    const feed = async () => JSON.parse(await chrome.evaluate("JSON.stringify([...document.querySelectorAll('#feed .shout .text')].map((text) => text.textContent))"));
    assert.deepEqual([await feed(), await chrome.evaluate("document.querySelector('#feed .feed-bar span').textContent")], [['web-1 is on it'], '1 unread show all'],
      `1 unread opens that one shout, not the ${alreadyRead} already read`);
    await click('#feed [data-unread]');
    assert.equal((await feed()).length, alreadyRead + 1, 'show all brings back the shouts already read');

    // Cut off from the board, the bar turns red and says why.
    await chrome.evaluate("globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'))");
    await chrome.waitFor("document.querySelector('#live').textContent.startsWith('offline')", 15_000);
    r = await read();
    const [red, green, blue] = r.barTint;
    assert.ok(red > green + 10 && red > blue + 10 && r.bar.length > 0, `the bar turns red and keeps its parts: ${JSON.stringify(r.barTint)}`);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375');
    r = await read();
    assert.ok(r.barShown && r.live.startsWith('offline'), 'on a phone too, a view cut off from the board says so');
    assert.ok(r.bar.every((p) => p.height >= 44), `and its parts are 44px targets there: ${JSON.stringify(r.bar)}`);
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the project corner and the theme read the same everywhere [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for project corner checks.');
  const box = machine();
  const alpha = project(box, 'corner-alpha', `${SPEC}- G3 [pending] Should the greeting name the visitor? | gate: review\n- G4 [draft, must] The footer links home. | gate: web test\n`);
  project(box, 'corner-beta');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.web, 'claim', '1');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-corner-chrome-'));
  let chrome;
  /** The corner, the project list and the theme button as they read. */
  const read = async () => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const shown = (e) => !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
    const rgb = (css) => (css.match(/[\\d.]+/g) || []).map(Number);
    const probe = document.createElement('i'); probe.style.color = 'var(--warn)'; document.body.append(probe); const warn = getComputedStyle(probe).color; probe.remove();
    const theme = document.querySelector('#theme'), bar = document.querySelector('header.top'), side = document.querySelector('#side');
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth },
      mode: document.documentElement.dataset.side || 'docked', logo: box(document.querySelector('#side-toggle svg')), name: box(document.querySelector('#proj-name')),
      wordmark: shown(document.querySelector('#side-toggle span')), arrow: shown(document.querySelector('#proj-switch small')),
      rows: [...document.querySelectorAll('#proj-list .proj.repo')].filter(shown).map((row) => {
        const s = getComputedStyle(row), asks = row.querySelector('small .asks');
        return { name: row.querySelector('.pname').textContent, line: row.querySelector('small').textContent, pill: !!row.querySelector('.need'), on: row.classList.contains('on'),
          asks: asks ? { text: asks.textContent, first: row.querySelector('small').firstElementChild === asks, warn: getComputedStyle(asks).color === warn } : null,
          tint: rgb(s.backgroundColor), edge: rgb(s.borderTopColor) };
      }),
      theme: { scheme: document.documentElement.dataset.scheme || null, title: theme.title, box: box(theme), bar: box(bar), picked: document.documentElement.dataset.theme || null, side: box(side) },
    };
  })())`));
  const click = (selector) => chrome.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  /** A drawn frame: the page hears of a colour-scheme change at its next one. */
  const frame = () => chrome.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
  const middle = (b) => b.top + b.height / 2;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.projects?.length === 2 && !!document.querySelector('#proj-list .proj.repo')");
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        const at = `${width}px ${scheme}`;
        const r = await read();
        assert.ok(r.page.scroll <= r.page.width, `${at}: no sideways scroll`);
        assert.equal(r.wordmark, false, `${at}: the corner is the logo mark, never a wordmark`);
        // The theme button sits centred in the top bar. On a wide screen that is the tab bar; on a phone it is the
        // project bar, the page's first row (the logo, the project, the theme), with the tabs under it.
        const top = width === 375 ? r.theme.side : r.theme.bar;
        assert.ok(Math.abs(middle(r.theme.box) - middle(top)) <= 2 && r.theme.box.left >= top.left && r.theme.box.right <= top.right, `${at}: the theme button sits centred in the top bar: ${JSON.stringify(r.theme)}`);
        if (width === 375) assert.ok(top.top <= 0.5 && r.theme.bar.top >= top.bottom - 1, `${at}: on a phone the top bar is the project bar, the tabs under it: ${JSON.stringify(r.theme)}`);
        if (width === 375) continue;
        // In the project list: a project is its name and what it holds, what needs the person first in the warning
        // colour; no count pills; the project shown a quiet neutral tint, no coloured edge.
        const [shownRow, other] = [r.rows.find((row) => row.on), r.rows.find((row) => !row.on)];
        assert.ok(r.rows.length === 2 && r.rows.every((row) => !row.pill), `${at}: two projects, no count pills: ${JSON.stringify(r.rows)}`);
        assert.deepEqual([shownRow.name, shownRow.asks?.text, shownRow.asks?.first, shownRow.asks?.warn], ['corner-alpha', '1 question · 1 draft row', true, true], `${at}: what needs the person comes first, in the warning colour: ${JSON.stringify(shownRow)}`);
        assert.equal(other.asks, null, `${at}: a project needing nothing says only what it holds`);
        const [tr, tg, tb] = shownRow.tint, [er, eg, eb] = shownRow.edge;
        assert.ok(Math.max(tr, tg, tb) - Math.min(tr, tg, tb) <= 14 && Math.max(er, eg, eb) - Math.min(er, eg, eb) <= 14, `${at}: the project shown is a neutral tint with no coloured edge: ${JSON.stringify(shownRow)}`);
      }
    }

    // The corner is the same docked and collapsed: the logo, then the name, in the same place; collapsed, the name opens
    // the list, so only then does it carry its arrow.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.waitFor('innerWidth === 1280');
    await frame();
    const docked = await read();
    await click('#side-toggle');
    await chrome.waitFor('document.documentElement.dataset.side === "collapsed"');
    const collapsed = await read();
    for (const part of ['logo', 'name']) {
      assert.ok(Math.abs(docked[part].left - collapsed[part].left) <= 1 && Math.abs(docked[part].top - collapsed[part].top) <= 1 && Math.abs(docked[part].height - collapsed[part].height) <= 1,
        `the ${part} keeps its place and size: ${JSON.stringify([docked[part], collapsed[part]])}`);
    }
    assert.deepEqual([docked.mode, docked.arrow, collapsed.mode, collapsed.arrow], ['docked', false, 'collapsed', true], 'the arrow only where the name opens a list');

    // The theme is light or dark: it starts from the system's, each press switches, the title says which, a reload keeps
    // it; collapsed, the button still sits centred in the top bar.
    assert.deepEqual([collapsed.theme.scheme, collapsed.theme.title, collapsed.theme.picked], ['light', 'Light theme: switch to dark', null], 'none picked yet: the system\'s, light here');
    // With none picked the page follows the system as it changes.
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await frame();
    await chrome.waitFor("document.documentElement.dataset.scheme === 'dark'");
    assert.equal((await read()).theme.title, 'Dark theme: switch to light', 'and the button says so');
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await frame();
    await chrome.waitFor("document.documentElement.dataset.scheme === 'light'");
    assert.ok(Math.abs(middle(collapsed.theme.box) - middle(collapsed.theme.bar)) <= 2, `the button sits centred in the top bar: ${JSON.stringify(collapsed.theme)}`);
    await click('#theme');
    assert.deepEqual(Object.values((await read()).theme).slice(0, 2), ['dark', 'Dark theme: switch to light'], 'a press switches to dark');
    await click('#theme');
    assert.deepEqual([...Object.values((await read()).theme).slice(0, 2), await chrome.evaluate("localStorage.getItem('pb.theme')")], ['light', 'Light theme: switch to dark', 'light'], 'the next press is light again, never back to following the system');
    await click('#theme');
    await chrome.send('Page.reload');
    await chrome.waitFor("document.readyState === 'complete' && !!document.querySelector('#theme')");
    assert.deepEqual(Object.values((await read()).theme).slice(0, 2), ['dark', 'Dark theme: switch to light'], 'presses switch between the two, and a reload keeps the last');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('targets are 44px for touch and compact under a mouse [N26]', { timeout: 150_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for target size checks.');
  const box = machine();
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, api: { owns: ['api/'], specs: ['G'] } };
  const alpha = project(box, 'targets', SPEC, { lanes });
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'api', 'Endpoint', '--specs', 'G1', '--criterion', 'answers');
  box.run(alpha.web, 'claim', '1');
  box.run(alpha.web, 'shout', 'coordinator', 'Greeting is under way; see #2 after.');
  // A shout that is only a reference: nothing shares its line, so it is a target like any button.
  box.run(alpha.web, 'shout', 'coordinator', '#2');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-targets-chrome-'));
  let chrome;
  /** Every visible enabled action with its height, which references sit in running text, and the named compact ones. */
  const audit = async () => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    const visible = (e) => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return !e.disabled && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0 && !e.closest('[hidden]'); };
    const height = (s) => { const e = document.querySelector(s); return e && visible(e) ? Math.round(e.getBoundingClientRect().height) : null; };
    const selector = 'button,a[href],input:not([type=hidden]),select,textarea,[role=button],[data-tab],[data-go],[data-item],[data-state],[data-row],[data-new]';
    // A reference inside running text is exempt from 44px, as WCAG 2.5.8 exempts inline targets: only the elements named
    // here, and only where text that is not another control's shares their line in the same block.
    const named = (e) => e.matches('.feed button.ref, .shout button.ref, .shout .band a, .detail button.ref, .t button.ref') || !!e.closest('#chain .meta .gate, #detail .kv dd.waits-on');
    const inLine = (e) => {
      let block = e.parentElement;
      while (block.parentElement && getComputedStyle(block).display.startsWith('inline')) block = block.parentElement;
      const r = e.getBoundingClientRect(), walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walk.nextNode(); node; node = walk.nextNode()) {
        const owner = node.parentElement.closest(selector);
        if (e.contains(node) || !node.textContent.trim() || (owner && owner !== block && block.contains(owner))) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if ([...range.getClientRects()].some((line) => line.width > 0 && line.top < r.bottom && line.bottom > r.top)) return true;
      }
      return false;
    };
    const controls = [...new Set(document.querySelectorAll(selector))].filter(visible).map((e) => ({ text: (e.innerText || e.getAttribute('aria-label') || e.id || e.className).trim().slice(0, 40), height: e.getBoundingClientRect().height,
      inline: named(e) && inLine(e), named: named(e), inLine: inLine(e) }));
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth },
      tap: getComputedStyle(document.documentElement).getPropertyValue('--tap').trim(), coarse: matchMedia('(pointer: coarse)').matches,
      short: controls.filter((c) => c.height < 44 && !c.inline), count: controls.length,
      exempt: controls.filter((c) => c.named).map((c) => ({ text: c.text, height: Math.round(c.height), inLine: c.inLine })), standalone: inLine(document.querySelector('#new-item')),
      toolbar: { states: [...document.querySelectorAll('#state-chips button')].filter(visible).map((b) => Math.round(b.getBoundingClientRect().height)), lane: height('#lane-pick'), go: height('#new-item') },
      composer: { text: height('#shout-text'), send: height('#shout-send') }, status: [...document.querySelectorAll('.status [data-status]')].filter(visible).map((b) => Math.round(b.getBoundingClientRect().height)),
    };
  })())`));
  const tab = async (name) => { await chrome.evaluate(`document.querySelector('[data-tab=${name}]').click()`); await chrome.waitFor(`!document.querySelector('[data-pane=${name}]').hidden`); };
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.project?.items?.length === 2 && data.project.shouts.length >= 2");
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        const at = `${width}px ${scheme}`;
        await tab('items');
        const items = await audit();
        await tab('shouts');
        const shouts = await audit();
        for (const r of [items, shouts]) assert.ok(r.page.scroll <= r.page.width, `${at}: no sideways scroll`);
        if (width === 375) {
          // In a narrow window every action is a 44px target, as a finger needs.
          assert.equal(items.tap, '44px', `${at}: the target is 44px`);
          for (const [name, r] of [['Items', items], ['Shouts', shouts]]) assert.deepEqual(r.short, [], `${at} ${name}: every action at least 44px high: ${JSON.stringify(r.short)}`);
          // The named references: the #2 standing alone is a 44px target; only the #2 inside the shout's sentence, in a
          // line of its words, is exempt. The same check refuses a standalone button.
          assert.deepEqual([items.exempt, shouts.exempt.map((e) => [e.text, e.inLine, e.height >= 44])], [[], [['#2', false, true], ['#2', true, false]]], `${at}: #2 alone is a target, #2 in its sentence the only exemption: ${JSON.stringify([items.exempt, shouts.exempt])}`);
          assert.equal(items.standalone, false, `${at}: a standalone button is never inside a line of text`);
        } else {
          // Under a mouse on a wide screen controls size to their words: the Items toolbar at 32px, the composer one line.
          assert.equal(items.tap, '32px', `${at}: the target is 32px under a mouse`);
          assert.ok(items.toolbar.states.length === 3 && [...items.toolbar.states, items.toolbar.lane, items.toolbar.go].every((h) => Math.abs(h - 32) <= 1), `${at}: the Items toolbar's controls are 32px: ${JSON.stringify(items.toolbar)}`);
          assert.ok(shouts.composer.text <= 34 && Math.abs(shouts.composer.send - 32) <= 1, `${at}: the composer is one line of text: ${JSON.stringify(shouts.composer)}`);
          assert.ok(items.status.length > 0 && items.status.every((h) => h <= 30), `${at}: the status bar keeps its thin strip, no exception needed: ${JSON.stringify(items.status)}`);
          assert.ok(items.short.length > 0, `${at}: there is no blanket 44px minimum under a mouse`);
        }
      }
    }

    // Under touch on the same wide screen, every action is a 44px target again, the status bar's parts included.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await chrome.waitFor("innerWidth === 1280 && matchMedia('(pointer: coarse)').matches");
    await tab('items');
    const touchItems = await audit();
    await tab('shouts');
    const touchShouts = await audit();
    assert.equal(touchItems.tap, '44px', 'under touch the target is 44px');
    for (const [name, r] of [['Items', touchItems], ['Shouts', touchShouts]]) assert.deepEqual(r.short, [], `touch ${name}: every action at least 44px high: ${JSON.stringify(r.short)}`);
    assert.ok(touchItems.status.every((h) => h >= 44), `touch: the status bar's parts are 44px: ${JSON.stringify(touchItems.status)}`);
    // The named references: the #2 standing alone is a 44px target; only the #2 inside the shout's sentence, in a
    // line of its words, is exempt. The same check refuses a standalone button.
    assert.deepEqual([touchItems.exempt, touchShouts.exempt.map((e) => [e.text, e.inLine, e.height >= 44])], [[], [['#2', false, true], ['#2', true, false]]], `touch: #2 alone is a target, #2 in its sentence the only exemption: ${JSON.stringify([touchItems.exempt, touchShouts.exempt])}`);
    assert.equal(touchItems.standalone, false, `touch: a standalone button is never inside a line of text`);
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('needs you and the asks sit in their lists [N26]', { timeout: 180_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for Needs you and Shouts checks.');
  const box = machine();
  const spec = `${SPEC}- G3 [pending] Should the greeting name the visitor? | gate: review\n- G4 [draft, must] The footer links home. | gate: web test\n- G5 [draft, aim] The header stays put. | gate: web test\n`;
  const alpha = project(box, 'asks', spec);
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  box.run(alpha.web, 'claim', '1');
  const second = join(box.dir, 'asks-web-2');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/asks2');
  box.run(second, 'join', 'web');
  // The person's calls: a decision passed up to them, the spec's open question, a held lane and two draft rows. And an
  // agent's ask that waits on its coordinator, not on the person.
  box.run(alpha.web, 'shout', 'coordinator', 'Which colour for the button?', '--decision');
  box.run(alpha.repo, 'pass', '1', 'over to you');
  box.run(second, 'shout', 'coordinator', 'Ship the footer first?', '--decision');
  box.run(alpha.repo, 'hold', 'web', '--reason', 'Freeze for the demo');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-asks-chrome-'));
  let chrome;
  /** Items' head and Shouts' card as they read. */
  const read = async () => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const shown = (e) => !!e && !e.closest('[hidden]') && e.getBoundingClientRect().height > 0;
    const probe = document.createElement('i'); probe.style.color = 'var(--warn)'; document.body.append(probe); const warn = getComputedStyle(probe).color; probe.remove();
    const needs = document.querySelector('#needs');
    const card = document.querySelector('.shouts-card'), decisions = document.querySelector('#decisions');
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
      needsShown: shown(needs), inList: needs.parentElement === document.querySelector('#chain').parentElement, separateCard: !!document.querySelector('section.needs-you#needs'),
      needs: [...needs.querySelectorAll(':scope > .row')].map((row) => ({ go: row.dataset.go ?? null, words: row.querySelector('.t').textContent, ref: row.querySelector('.t > span')?.textContent ?? null,
        kind: row.querySelector('.meta .why').textContent, label: getComputedStyle(row.querySelector('.meta .why b')).color === warn && getComputedStyle(row.querySelector('.meta .why')).color === warn, chip: row.querySelector(':scope > .chip').textContent, age: !!row.querySelector('.row-age') })),
      card: card ? [...card.children].map((e) => e.id || e.className) : null,
      composer: box(document.querySelector('.shout-form .composer')), asks: box(document.querySelector('.asks-toggle[data-fold="waiting"]')),
      asksOpen: document.querySelector('.asks-toggle[data-fold="waiting"]')?.getAttribute('aria-expanded') ?? null, showAgents: box(document.querySelector('.asks-slot [data-agents-toggle]')),
      decisions: shown(decisions) ? [...decisions.querySelectorAll('.shout .text')].map((text) => text.textContent) : [], groupTint: getComputedStyle(decisions).backgroundColor, cardTint: card ? getComputedStyle(card).backgroundColor : null,
      firstRule: decisions.querySelector('.shout') ? getComputedStyle(decisions.querySelector('.shout')).borderTopWidth : null,
      feedBar: !!document.querySelector('#feed .feed-bar'), panelShown: shown(document.querySelector('#agents')), hide: !!document.querySelector('.panel-head [data-agents-toggle]'),
      agents: [...document.querySelectorAll('#agents .agent-card')].filter(shown).map((row) => ({ who: [...row.querySelector('.agent-who').children].map((part) => part.textContent.trim()).join(' '), what: row.querySelector('.agent-doing').textContent.trim(), chipInDoing: !!row.querySelector('.agent-doing .chip'), whatWidth: box(row.querySelector('.agent-what')).width, doingWidth: box(row.querySelector('.agent-doing')).width })),
      okNote: (() => { const c = document.querySelector('#console'); return !!c && !c.hidden && getComputedStyle(c).display !== 'none' && c.classList.contains('ok'); })(),
    };
  })())`));
  const click = (selector) => chrome.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.project?.decisions?.length === 1 && data.project.asked.length === 1 && data.project.holds.length === 1");
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        const at = `${width}px ${scheme}`;
        await click('[data-tab=items]');
        await click('[data-state=active]');
        let r = await read();
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll on Items`);
        // Needs you heads the list: each call a row shaped like an item, NEEDS YOU and its kind (for a decision, who
        // asked) in the warning colour below.
        assert.deepEqual([r.needsShown, r.inList, r.separateCard], [true, true, false], `${at}: Needs you is the head of the Items list, not a card of its own`);
        assert.deepEqual(r.needs.map(({ go, ref, words, kind, chip }) => [go.split(':')[0], ref, words.includes('Which colour for the button?') ? 'Which colour…' : words, kind, chip]), [
          ['decide', null, 'Which colour…', 'NEEDS YOU a decision, asked by coordinator', 'decide'],
          ['spec', 'G3', 'G3Should the greeting name the visitor?', 'NEEDS YOU an open question in SPEC.md', 'answer'],
          ['tab', 'web', 'webFreeze for the demo', 'NEEDS YOU lane held by coordinator', 'release'],
          ['tab', '2', '2draft spec rows to approve or drop', 'NEEDS YOU Spec rows waiting on you', 'review'],
        ], `${at}: the person's calls, each a row, the drafts one row with their count`);
        assert.ok(r.needs.every((need) => need.label), `${at}: NEEDS YOU and its kind in the warning colour`);
        assert.deepEqual(r.needs.map((need) => need.age), [true, false, true, false], `${at}: a call that has an age shows it at the right`);

        await click('[data-tab=shouts]');
        await chrome.waitFor("!document.querySelector('[data-pane=shouts]').hidden && !!document.querySelector('#feed .shout')");
        r = await read();
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll on Shouts`);
        // One card: the composer's line, the asks, the feed.
        assert.deepEqual(r.card, ['shout-form', 'decisions', 'feed'], `${at}: Shouts is one card`);
        if (width === 1280) assert.ok(Math.abs((r.composer.top + r.composer.height / 2) - (r.asks.top + r.asks.height / 2)) <= 4 && r.asks.left >= r.composer.right, `${at}: the asks waiting sit at the end of the composer's line: ${JSON.stringify([r.composer, r.asks])}`);
        assert.deepEqual([r.asksOpen, r.decisions.length, /Which colour for the button\?/.test(r.decisions[0] ?? '')], ['false', 1, true], `${at}: the asks waiting on others stay folded; the person's own decision shows`);
        assert.equal(r.feedBar, false, `${at}: no bar above the feed while it shows every shout`);
        assert.ok(r.hide && r.panelShown, `${at}: the agents panel carries its own hide`);
        // An agent's row: its name and state in words, then what it holds at the full width.
        const holder = r.agents.find((agent) => agent.who.startsWith('web-1'));
        assert.ok(holder && /^web-1 building (?:now|\d+[mhd])$/.test(holder.who) && holder.what === '#1 Greeting' && !holder.chipInDoing, `${at}: web-1's row reads as an item's: ${JSON.stringify(holder)}`);
      }
    }

    // Opened, the asks waiting on others are a group set apart from the feed, with no rule above the first.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.waitFor('innerWidth === 1280');
    await click('.asks-toggle[data-fold="waiting"]');
    let r = await read();
    assert.deepEqual([r.asksOpen, r.decisions.length, r.decisions[1]], ['true', 2, 'Ship the footer first?'], 'the toggle opens the ask waiting on others');
    assert.ok(r.groupTint !== r.cardTint && r.firstRule === '0px', `a tinted group with no rule above its first card: ${JSON.stringify([r.groupTint, r.cardTint, r.firstRule])}`);
    // Hidden, the agents come back from the composer's line, after the asks.
    await click('.panel-head [data-agents-toggle]');
    r = await read();
    assert.ok(!r.panelShown && r.showAgents && r.showAgents.left >= r.asks.right, `hidden, Show agents sits on the composer's line after the asks: ${JSON.stringify([r.asks, r.showAgents])}`);
    await click('.asks-slot [data-agents-toggle]');
    assert.ok((await read()).panelShown, 'and brings the panel back');
    // A sent shout shows as its card; no note pushes into the composer's line.
    await chrome.evaluate("document.querySelector('#shout-text').focus()");
    await chrome.send('Input.insertText', { text: 'Footer after the greeting.' });
    await click('#shout-send');
    await chrome.waitFor("[...document.querySelectorAll('#feed .shout .text')].some((text) => text.textContent === 'Footer after the greeting.')", 15_000);
    r = await read();
    assert.equal(r.okNote, false, 'a sent shout is its card, with no note beside the composer');
    // However many calls there are, each is a row: six more decisions make ten rows, none folded into a count.
    for (const n of [1, 2, 3, 4, 5, 6]) box.run(alpha.repo, 'shout', 'person', `Ship part ${n} today?`, '--decision');
    await click('[data-tab=items]');
    await chrome.waitFor("document.querySelectorAll('#needs > .row').length >= 10", 15_000);
    r = await read();
    assert.deepEqual([r.needs.length, r.needs.filter((need) => /^Ship part [1-6] today\?$/.test(need.words)).length, r.needs.every((need) => need.label)], [10, 6, true],
      `ten calls, ten rows, each with its kind in the warning colour: ${JSON.stringify(r.needs)}`);
    assert.equal(await chrome.evaluate("document.querySelector('#needs').textContent.includes('more need you')"), false, 'no call is folded into a count');
    // Narrowed to the unread shouts from the status bar, the feed carries its bar with show all; show all clears it.
    box.run(alpha.web, 'shout', 'coordinator', 'Greeting is half done.');
    await chrome.waitFor("!document.querySelector('#status-unread')?.hidden", 15_000);
    await click('#status-unread');
    await chrome.waitFor("view.tab === 'shouts' && !!document.querySelector('#feed .feed-bar')");
    assert.match(await chrome.evaluate("document.querySelector('#feed .feed-bar').textContent"), /^\d+ unread\s*show all$/, 'narrowed to the unread shouts, the feed carries its bar with show all');
    await click('#feed [data-unread]');
    assert.equal((await read()).feedBar, false, 'show all brings back every shout and clears the bar');
    // Under Verified, or a lane, the list is narrowed and Needs you steps aside.
    await click('[data-state=verified]');
    assert.equal((await read()).needsShown, false, 'under Verified, Needs you steps aside');
    await click('[data-state=active]');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('search in the top bar finds anything on the board [N26]', { timeout: 150_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for search checks.');
  const box = machine();
  const spec = `${SPEC}- G3 [approved, must] The greeting names the visitor. | gate: web test\n`;
  const alpha = project(box, 'finder', spec, { practice: 'ways.md' });
  writeFileSync(join(alpha.repo, 'ways.md'), '# Local rules\n\n## Team\n- R1 [approved, must] Every greeting is read by a person. | gate: review\n');
  box.run(alpha.repo, 'add', 'web', 'Farewell page', '--specs', 'G1', '--criterion', 'renders');
  // Seven items match, so the Items group shows five of them and says how many there are.
  for (let n = 1; n <= 7; n += 1) box.run(alpha.repo, 'add', 'web', `Greeting variant ${n}`, '--specs', 'G1', '--criterion', 'renders');
  box.run(alpha.web, 'shout', 'coordinator', 'The greeting is ready for review.');
  box.run(alpha.web, 'shout', 'coordinator', 'Should the greeting wave?', '--decision');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-finder-chrome-'));
  let chrome;
  /** The top bar's search and its results as they read. */
  const read = async () => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const results = document.querySelector('#find-results');
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
      inTop: !!document.querySelector('.top .top-find #q'), toolbar: [...document.querySelector('.toolbar').children].filter((e) => e.offsetParent !== null || e.tagName === 'SELECT').map((e) => e.id || e.className),
      field: box(document.querySelector('#q')), tabs: box(document.querySelector('#tabs')), top: box(document.querySelector('header.top')), theme: box(document.querySelector('#theme')),
      bar: [...document.querySelectorAll('.toolbar #state-chips button, .toolbar #lane-pick, .toolbar #new-item')].filter((e) => e.getClientRects().length > 0)
        .map((e) => ({ name: e.dataset.state || e.id, middle: Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2) })),
      shoutIds: data.project.shouts.map((x) => '#' + x.shout_id), focused: document.activeElement?.id ?? null, value: document.querySelector('#q').value,
      shown: !results.hidden, groups: [...results.querySelectorAll('h4')].map((h) => [h.firstChild.textContent, h.querySelector('span').textContent]),
      hits: [...results.querySelectorAll('.find-hit')].map((hit) => ({ go: hit.dataset.find, id: hit.querySelector('code').textContent, note: hit.querySelector('small').textContent, on: hit.classList.contains('on') })),
      tab: view.tab, item: view.item, spec: view.row.spec, doctrine: view.row.doctrine,
    };
  })())`));
  const key = async (name, code, keyCode, text) => {
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: name, code, windowsVirtualKeyCode: keyCode, ...(type === 'keyDown' && text ? { text, unmodifiedText: text } : {}) });
  };
  const tap = async (selector) => {
    const point = JSON.parse(await chrome.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
    for (const type of ['mousePressed', 'mouseReleased']) await chrome.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  };
  /** Type the words into the search as a keyboard does, from an empty field. */
  const search = async (words) => {
    await chrome.evaluate("document.querySelector('#q').focus(); document.querySelector('#q').select()");
    await chrome.send('Input.insertText', { text: words });
    await chrome.waitFor(`document.querySelector('#q').value === ${JSON.stringify(words)} && !document.querySelector('#find-results').hidden`);
  };
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.project?.items?.length === 8 && data.project.shouts.length >= 2");
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        await chrome.evaluate("document.querySelector('[data-tab=items]').click()");
        const at = `${width}px ${scheme}`;
        // The Items toolbar is one row: Active, Verified and All, the lane picker, New item at its end; on a phone Active
        // and Verified with New item, All and the lane picker dropped.
        const bar = (await read()).bar, names = bar.map((part) => part.name);
        if (width === 375) assert.deepEqual(names, ['active', 'verified', 'new-item'], `${at}: on a phone the toolbar is Active, Verified and New item`);
        else assert.deepEqual([names.slice(0, 3), names.at(-1)], [['active', 'verified', 'all'], 'new-item'], `${at}: the toolbar's states, then New item at its end`);
        assert.ok(bar.every((part) => Math.abs(part.middle - bar[0].middle) <= 2), `${at}: the toolbar is one row: ${JSON.stringify(bar)}`);
        await search('greeting');
        const r = await read();
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll`);
        // The search is the top bar's; the Items toolbar keeps the states, the lane picker and New item.
        assert.ok(r.inTop, `${at}: the search sits in the top bar`);
        assert.deepEqual(r.toolbar, ['state-chips', 'lane-pick', 'new-item'], `${at}: the Items toolbar has no search field`);
        if (width === 375) assert.ok(r.field.top >= r.tabs.bottom - 1 && r.field.width >= r.page.width - 40, `${at}: on a phone the search is its own row under the tabs: ${JSON.stringify([r.field, r.tabs])}`);
        else assert.ok(Math.abs((r.field.top + r.field.height / 2) - (r.top.top + r.top.height / 2)) <= 2 && r.field.left >= r.tabs.right && r.field.right <= r.theme.left, `${at}: the search sits in the top bar between the tabs and the theme button: ${JSON.stringify([r.tabs, r.field, r.theme, r.top])}`);
        // Results group by kind, five a group with how many there are, the first ready for Enter.
        assert.deepEqual(r.groups, [['Items', '5 of 7'], ['Spec', '1'], ['Doctrine', '1'], ['Shouts', '2']], `${at}: grouped, newest first, five a group`);
        assert.deepEqual([r.hits.length, r.hits.findIndex((hit) => hit.on), r.hits.slice(5).map((hit) => hit.id)], [9, 0, ['G3', 'R1', ...r.shoutIds]], `${at}: every group's results, the first highlighted`);
        // A shout's result is its own id, its words and its kind, newest first.
        assert.deepEqual(r.hits.slice(7).map((hit) => hit.note), ['decision', 'shout'], `${at}: a shout's result names its kind: ${JSON.stringify(r.hits.slice(7))}`);
        await key('Escape', 'Escape', 27);
        const cleared = await read();
        assert.deepEqual([cleared.value, cleared.shown], ['', false], `${at}: Esc clears the search and closes its results`);
      }
    }

    // The arrows move the highlight and Enter opens it: here the third item, the third newest.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.waitFor('innerWidth === 1280');
    await search('greeting');
    let r = await read();
    const third = r.hits[2].go;
    await key('ArrowDown', 'ArrowDown', 40);
    await key('ArrowDown', 'ArrowDown', 40);
    assert.equal((await read()).hits.findIndex((hit) => hit.on), 2, 'down twice highlights the third');
    await key('ArrowUp', 'ArrowUp', 38);
    await key('ArrowDown', 'ArrowDown', 40);
    await key('Enter', 'Enter', 13, '\r');
    await chrome.waitFor(`view.tab === 'items' && view.item === ${Number(third.slice(5))} && document.querySelector('#find-results').hidden`);

    // A click opens a Spec row, a Doctrine rule or a shout where it lives.
    await search('greeting');
    await tap('#find-results [data-find="spec:G3"]');
    await chrome.waitFor("view.tab === 'spec' && view.row.spec === 'G3' && document.querySelector('#spec-detail h2 span')?.textContent === 'G3'");
    await search('greeting');
    await tap('#find-results [data-find="doctrine:R1"]');
    await chrome.waitFor("view.tab === 'doctrine' && view.row.doctrine === 'R1' && document.querySelector('#doctrine-detail h2 span')?.textContent === 'R1'");
    await search('greeting');
    const shout = (await read()).hits.find((hit) => hit.go.startsWith('shout:')).go;
    await tap(`#find-results [data-find="${shout}"]`);
    await chrome.waitFor(`view.tab === 'shouts' && document.getElementById('shout-${shout.slice(6)}')?.classList.contains('found')`);

    // "/" goes to the search from the page, never from a field.
    await chrome.evaluate("document.activeElement.blur(); document.body.focus()");
    await key('/', 'Slash', 191, '/');
    r = await read();
    const selected = await chrome.evaluate("(() => { const q = document.querySelector('#q'); return q.selectionStart === 0 && q.selectionEnd === q.value.length; })()");
    assert.deepEqual([r.focused, selected], ['q', true], '"/" puts the cursor in the search, its last words selected to type over');
    await chrome.evaluate("document.querySelector('#shout-text').focus()");
    await key('/', 'Slash', 191, '/');
    assert.equal(await chrome.evaluate("document.querySelector('#shout-text').value"), '/', 'and in a field it is only a slash');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
