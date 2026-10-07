/**
 * The view's page as the person sees it (N26, N27). Each test sets up real projects with the real
 * CLI, starts `pullboard view` over them, and runs the page it serves in a vm with just enough of a
 * document for its script: every element the page names by id records what the script writes into
 * it, and the script's requests go to that view. Nothing is stood in for but the browser.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import vm from 'node:vm';
import { loadDoctrine } from '../src/doctrine.js';
import { MACHINE } from '../src/machine.js';
import { portableSnapshot } from '../src/serve.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const scratch = [];

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

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
  return { repo, web, branch };
}

/**
 * web-1 builds an item: claims it, commits a file in its lane through the hooks, and submits it.
 */
function build(box, p, id, file) {
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
  box.git(p.repo, 'switch', '-q', '--detach', p.branch);
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

/** Start the real view and wait for a complete HTTP answer, rather than just its printed link. */
async function startView(box) {
  const child = spawn(process.execPath, [BIN, 'view', '--no-open'], { cwd: box.dir, env: box.env });
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
    const ready = await fetchView(link);
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
  return (await fetch(`${view.base}/view.css`, { headers: { 'x-pullboard-key': view.key } })).text();
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
    querySelectorAll: () => [],
  };
}

/**
 * The ages an element holds, as the nodes a browser would hand the page for [data-ago]: each knows
 * the moment it counts from, and setting its text changes that node alone.
 */
function ageNodes(element) {
  const AGE = /<time data-ago="([^"]*)"([^>]*)>([^<]*)<\/time>/g;
  return [...element.innerHTML.matchAll(AGE)].map((match, n) => ({
    dataset: { ago: match[1] },
    set textContent(text) {
      let k = 0;
      element.patch((html) => html.replace(AGE, (whole, at, rest) => (k++ === n ? `<time data-ago="${at}"${rest}>${text}</time>` : whole)));
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
  const html = await (await fetchView(view.link)).text();
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
    innerWidth: width,
    innerHeight: 800,
    matchMedia: (query) => ({ matches: width <= Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? Infinity) }),
    setInterval: () => 0,
    ...(later ? { Date: daysOn(later) } : {}),
    ...(store ? { localStorage: store } : {}),
    setTimeout,
    clearTimeout,
    fetch: (path, init) => {
      requests.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
      const answer = held.then(() => fetchView(`${view.base}${path}`, init)).then(async (res) => {
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
  return html.split('<button').slice(1).map((row) => ({
    root: /data-root="([^"]*)"/.exec(row)?.[1],
    name: /class="pname">([^<]*)</.exec(row)?.[1],
    needs: /class="need"[^>]*>([^<]*)</.exec(row)?.[1] ?? '',
    line: /<small[^>]*>([^<]*)</.exec(row)?.[1],
    current: /aria-current="true"/.test(row),
  }));
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
      const response = await fetch(`${view.base}${path}`, { headers });
      assert.equal(response.status, 404, `${path} remains unavailable`);
      const refused = await response.json();
      assert.equal(refused.version, 1);
      assert.equal(refused.error.code, 'NO_ENDPOINT');
    }
    assert.equal((await fetch(`${view.base}/api/v1/boards`)).status, 401);
    assert.equal((await fetch(`${view.base}/api/v1/boards`, { headers: { ...headers, origin: 'http://other.invalid' } })).status, 403);
    const events = await fetch(`${view.base}/api/v1/boards/${id}/events`, { headers });
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
    assert.equal(page.element('proj-elsewhere').textContent, '2 elsewhere', 'the folded button counts what needs the person elsewhere: beta\'s question and held lane, not alpha\'s agents\' work');

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
  const core = project(box, 'core', `${SPEC}- G3 [pending] Should the API greet in French?\n`, { name: 'Core API', project: 'Atlas' });
  box.run(core.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, core, 1, 'greeting.html');
  sendBack(box, core, 1, 'the page needs a greeting');
  const web = project(box, 'web', SPEC, { name: 'Web UI', project: 'Atlas' });
  box.run(web.repo, 'add', 'web', 'Header', '--specs', 'G1', '--criterion', 'has a header');
  build(box, web, 1, 'header.html');
  box.run(web.repo, 'shout', 'person', 'Ship the header today?', '--decision');
  const standalone = project(box, 'standalone', SPEC, { name: 'Scratchpad' });
  const broken = project(box, 'broken', SPEC, { name: 'Broken repo', project: 'Atlas' });
  const view = await startView(box);
  try {
    const headers = { 'x-pullboard-key': view.key };
    let response = await fetch(`${view.base}/api/v1/boards`, { headers });
    let state = await response.json();
    assert.deepEqual(state.boards.filter((repo) => repo.project === 'Atlas').map((repo) => repo.name), ['Core API', 'Web UI', 'Broken repo']);
    writeFileSync(join(broken.repo, 'pullboard.json'), '{not valid json');
    response = await fetch(`${view.base}/api/v1/boards`, { headers });
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
    assert.match(page.show('group-needs'), /<b>Core API<\/b><code>G3<\/code><span>Should the API greet in French\?<\/span><em>answer in SPEC\.md →<\/em>/, "a question in one repo's spec");
    assert.match(page.show('group-needs'), /<b>Web UI<\/b><code>coordinator<\/code><span>Ship the header today\?<\/span><em>decision, /, "and a decision in another's");
    assert.doesNotMatch(page.show('group-needs'), /sent back|to verify|Greeting|Header/, "work sent back or waiting for a verdict is the agents', not the person's");
    assert.match(page.show('group-activity'), /Core API/);
    assert.match(page.show('group-activity'), /Web UI/);
    assert.match(page.show('group-activity'), /Greeting|Header/);

    await page.click({ root: core.repo });
    assert.equal(page.element('group-view').hidden, true);
    assert.equal(page.element('tabs').hidden, false);
    assert.match(page.show('chain'), /Greeting/);
    assert.doesNotMatch(page.show('chain'), /Header/);
    assert.ok(side.includes(`data-root="${standalone.repo}"`), 'the repo without a project stands alone');
  } finally {
    await view.stop();
  }
});

test('the tabs fit one row on a phone [N26]', async () => {
  const view = await startView(machine());
  try {
    const html = await (await fetch(view.link)).text();
    const style = await styleOf(view);
    const phone = /@media \(width < 480px\) \{\n([^@]*?)\n\}/.exec(style)?.[1] ?? '';
    assert.doesNotMatch(style, /max-width: 480px/, 'at 480px itself the tabs keep their row');
    assert.match(phone, /\.tabs \{ flex: 1; display: grid; grid-auto-flow: column; grid-auto-columns: minmax\(0, 1fr\);/, 'under 480px the tabs share the bar in equal columns');
    assert.match(phone, /\.tab \{ display: grid; grid-template-rows: auto 13px; justify-items: center;/, 'each tab stacks its label over its count');
    assert.match(phone, /\.tab b \{ margin: 0;/);
    assert.match(style, /\n\.tabs \{ display: flex; flex-wrap: wrap; gap: 2px; \}\n/, 'wider, the tabs keep the row they have');
    const tabs = [...html.matchAll(/<button class="tab" data-tab="([a-z]+)" type="button">([A-Za-z]+)(<b id="count-([a-z]+)"><\/b>)?<\/button>/g)];
    assert.deepEqual(tabs.map((match) => [match[2], match[4] === match[1]]), [['Items', true], ['Shouts', true], ['Spec', true], ['Doctrine', true], ['Activity', false]], 'five tabs: a label, then its count where it has one');
  } finally {
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

    const theme = (on) => [on.run('document.documentElement.dataset.theme') ?? 'system', on.element('theme').title];
    assert.deepEqual(theme(page), ['system', 'Theme: system'], 'it starts with the system\'s theme');
    const presses = [];
    for (let press = 0; press < 3; press += 1) {
      await page.fire('theme', 'click');
      presses.push(theme(page));
    }
    assert.deepEqual(presses, [['light', 'Theme: light'], ['dark', 'Theme: dark'], ['system', 'Theme: system']], 'each press moves on one, and the title says which is on');

    await page.fire('theme', 'click');
    await page.fire('theme', 'click');
    assert.deepEqual(theme(await openPage(view, { store })), ['dark', 'Theme: dark'], 'a reload keeps the pick');
    assert.deepEqual(theme(await openPage(view)), ['system', 'Theme: system'], 'a browser that keeps nothing follows the system');
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
  return [...html.matchAll(/<li class="([^"]*)"><time>([^<]*)<\/time><span><b>([^<]*)<\/b> ([^<]*)<\/span>(?:<small>(.*?)<\/small>)?<\/li>/g)].map((match) => ({
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
  box.run(alpha.repo, 'merged', '1', box.git(alpha.repo, 'rev-parse', alpha.branch));
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
 * The agents the panel shows: id, the path on hover, its last move, what it holds and whether it
 * reads idle, and its entry's text with the tags taken out.
 */
function agentEntries(html) {
  return html.split('<div class="agent">').slice(1).map((entry) => ({
    id: /<b[^>]*>([^<]*)<\/b>/.exec(entry)?.[1],
    path: /<b title="([^"]*)"/.exec(entry)?.[1],
    age: /<time[^>]*>([^<]*)<\/time>/.exec(entry)?.[1],
    holds: [...entry.matchAll(/data-go="item:(\d+)"[^>]*><span>([^]*?)<\/span><span class="chip[^"]*">([^<]*)</g)].map((match) => `${match[2]}: ${match[3]}`),
    idle: entry.includes('<small>idle</small>'),
    text: entry.replace(/<[^>]*>/g, ' '),
  }));
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
  const two = { ...alpha, web: second, branch: 'web/two' };
  build(box, two, 2, 'farewell.html');
  sendBack(box, two, 2, 'no farewell on the page');
  build(box, two, 4, 'footer.html');
  box.run(alpha.web, 'claim', '1');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const agents = agentEntries(page.show('agents'));
    assert.deepEqual(agents.map((agent) => [agent.id, agent.holds, agent.idle]), [
      ['coordinator', [], true],
      // The claim first, then work sent back, then work waiting for a verdict.
      ['web-1', ['#1 Header: building', '#3 Greeting &lt;b&gt;bold&lt;/b&gt;: to verify'], false],
      ['web-2', ['#2 Farewell: sent back', '#4 Footer: to verify'], false],
    ]);
    for (const agent of agents) assert.match(agent.age, /^(now|\d+[mhd])$/, `${agent.id} shows when it last moved`);
    assert.deepEqual(agents.map((agent) => agent.path), [alpha.repo, alpha.web, second], 'each path is on hover');
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
    assert.equal(page.element('proj-elsewhere').textContent, '1 elsewhere', 'and on a phone');

    box.run(beta.repo, 'shout', 'person', 'And the docs?', '--decision');
    await page.run('refresh()');
    assert.deepEqual(rows()[1], ['beta', '2', '2 decisions'], 'a coordinator asks the person straight out too');
    box.run(beta.repo, 'answer', '2', 'yes', '--as', 'person');
    box.run(beta.repo, 'answer', '3', 'after', '--as', 'person');
    await page.run('refresh()');
    assert.deepEqual(rows(), [['alpha', '', 'nothing open'], ['beta', '', 'nothing open']], 'answered, they need no one');
    assert.match(box.run(beta.web, 'inbox'), /person -> web-1: answers \\?#1: Person answered \\?#2: yes/, "the person's answer reaches the agent that asked");
    assert.equal(page.run('document.title'), 'alpha · Pullboard');
    assert.equal(page.element('proj-elsewhere').hidden, true);
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
    assert.deepEqual(rows['3'], { chip: 'gate: gated', edge: true, waits: ['waits on <button class="ref" data-go="item:2" type="button">#2</button>'] }, 'gated on #2, which is still being built');
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
test('a named port that is busy is refused with the way out, not a stack trace [N26]', async () => {
  const box = machine();
  const held = await new Promise((done) => { const server = createServer(); server.listen(0, '127.0.0.1', () => done(server)); });
  try {
    const port = held.address().port;
    const result = spawnSync(process.execPath, [BIN, 'view', '--no-open', '--port', String(port)], { cwd: box.dir, env: box.env, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 1, `a refusal, not a crash or a hang: ${result.stderr}`);
    assert.equal(result.stderr.trim(), `pullboard: [PORT_BUSY] port ${port} is in use: name another with --port, or leave --port out to take any free one`);
  } finally {
    await new Promise((done) => held.close(done));
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
      needs: /decide, <time data-ago="[^"]+">([^<]*)<\/time>/.exec(page.show('needs'))?.[1],
      agent: agentEntries(page.show('agents')).find((agent) => agent.id === 'web-1')?.age,
    });
    assert.deepEqual(ages(), { row: 'now', needs: 'now', agent: 'now' });
    const rebuilds = () => ['chain', 'needs', 'agents'].map((id) => page.element(id).writes);
    const before = rebuilds();

    // Three hours pass, nothing on the board changes, and the minute timer fires.
    page.run('const D = Date; globalThis.Date = class extends D { constructor(...a) { super(...(a.length ? a : [D.now() + 3 * 3600e3])); } static now() { return D.now() + 3 * 3600e3; } };');
    page.run('tickAges()');
    assert.deepEqual(ages(), { row: '3h', needs: '3h', agent: '3h' });
    assert.deepEqual(rebuilds(), before, 'each age moved where it stands; nothing was rebuilt');
  } finally {
    await view.stop();
  }
});
/**
 * The coordinator accepts an item from a checkout of its submitted commit.
 */
function accept(box, p, id) {
  box.git(p.repo, 'switch', '-q', '--detach', p.branch);
  box.run(p.repo, 'verify', String(id), 'accept', '--note', 'the page shows it', '--as', 'coordinator');
  box.git(p.repo, 'switch', '-q', 'main');
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
  const response = await fetch(`${view.base}/api/v1/boards`, { headers: { 'x-pullboard-key': view.key } });
  assert.equal(response.status, 200);
  return (await response.json()).boards.find((board) => board.root === root)?.id ?? 'not-registered';
}

/** The board as the shared API serves it for one project. */
async function boardOf(view, root) {
  const id = await boardId(view, root);
  const res = await fetch(`${view.base}/api/v1/boards/${id}/state`, { headers: { 'x-pullboard-key': view.key } });
  assert.equal(res.status, 200);
  return (await res.json()).state;
}

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
    const css = await fetch(`${view.base}/view.css?k=${view.key}`);
    assert.equal(css.status, 200);
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal(await css.text(), readFileSync(new URL('../src/view.css', import.meta.url), 'utf8'), 'src/view.css, as it is');
    assert.equal((await fetch(`${view.base}/view.css`)).status, 403, 'nothing without the secret');
    const stranger = await new Promise((done, fail) => {
      request({ host: '127.0.0.1', port: view.link.port, path: `/view.css?k=${view.key}`, headers: { host: 'pullboard.example' } }, (res) => done(res.statusCode)).on('error', fail).end();
    });
    assert.equal(stranger, 403, 'nor under another Host');
    const policy = (await fetch(view.link)).headers.get('content-security-policy');
    assert.equal(/(?:^|; )style-src ([^;]*)/.exec(policy)?.[1], "'self'", 'styles come from the view alone, never inline');

    // Nothing the script draws carries a style either: products, the list, a picked item, a spec row.
    await page.click({ go: 'item:1' });
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
    assert.ok(row.includes('BEHAVIOR_MISMATCH: no &lt;b&gt;greeting&lt;/b&gt; on the page'), row);
    assert.ok(!row.includes('second line'), 'the row shows the first line of the note only');
    assert.ok(itemRow(page.show('chain'), 2).includes('BEHAVIOR_MISMATCH: the farewell is missing'));

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

    assert.ok(itemRow(page.show('chain'), 5).includes('BEHAVIOR_MISMATCH: the footer is empty'), 'a row being reworked still says why');
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
    assert.match(page.html, /<div class="card-panel toolbar"><div class="seg" id="state-chips" role="group" aria-label="Show"><\/div><input id="q" type="search"/, 'the control sits in the toolbar beside the search');
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
    assert.equal(page.element('decisions').hidden, false);
    assert.match(page.show('decisions'), new RegExp(`^<div class="head quiet">Waiting on others</div><div class="ask other"><p><small><b>web-1</b> asks <b>coordinator</b>, <time data-ago="[^"]+">now</time></small></p><p>${question}</p></div>$`), 'above the shouts, saying who holds it, with no Answer button');
    assert.doesNotMatch(page.show('feed'), /Greet in/, 'though the feed no longer reaches it');

    // The coordinator passes it up with its note (B27): now it is the person's call.
    box.run(alpha.repo, 'pass', '1', 'over to you');
    await page.run('refresh()');
    const passed = `Passed up from web-1: ${question}\nCoordinator note: over to you`;
    assert.match(page.show('needs'), new RegExp(`^<div class="head"><i></i>Needs you</div><button class="ny" data-go="decide:42" type="button"><code>coordinator</code><span>${passed}</span><em>decide, <time data-ago="[^"]+">now</time> →</em></button>`), 'first in Needs-you: who passed it, what, and since when');
    assert.match(page.show('decisions'), new RegExp(`^<div class="head"><i></i>Decision needed</div><div class="ask"><p><small><b>coordinator</b> asks, <time data-ago="[^"]+">now</time></small></p><p>${passed}</p><button class="ghost" data-go="decide:42" type="button">Answer</button></div>$`), 'and above the shouts, with an Answer button');

    const form = () => ({
      answering: !page.element('answering').hidden,
      who: page.element('answering-who').textContent,
      question: page.element('answering-q').textContent,
      to: page.element('shout-to').value,
      locked: Boolean(page.element('shout-to').disabled),
      button: page.element('shout-send').textContent,
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
    assert.match(box.run(alpha.web, 'inbox'), /person -> web-1: answers \\?#1: Person answered \\?#42: French, then English/, 'the answer reaches the agent that asked');
    assert.deepEqual(form(), { answering: false, who: '', question: '', to: 'web', locked: false, button: 'Shout' }, 'the form is a plain shout again');
    assert.equal(page.element('shout-text').value, '');
    assert.doesNotMatch(page.show('needs'), /decide:/, 'an answered decision leaves Needs-you');
    assert.equal(page.element('decisions').hidden, true, 'and the banner');

    box.run(alpha.web, 'shout', 'coordinator', 'Ship today?', '--decision');
    box.run(alpha.repo, 'pass', '45', 'yours');
    await page.run('refresh()');
    const feed = page.show('feed');
    assert.match(feed, /<b>web-1 → coordinator<\/b> <span class="mark ask">decision<\/span> Ship today\?/, 'the feed marks an ask');
    assert.match(feed, /<b>person → coordinator<\/b> <span class="mark">answer<\/span> French, then English/, 'and an answer');
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
    assert.match(box.run(beta.repo, 'decisions', '--as', 'person'), /^#2 {2}coordinator -> person, [^:]+: Passed up from web-1: Beta asks too\?/m, "beta's ask still waits");
    assert.match(box.run(alpha.repo, 'decisions', '--as', 'person'), /^#46 {2}coordinator -> person, [^:]+: Passed up from web-1: Ship today\?/m, "and so does alpha's");
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
    assert.deepEqual([...needs.matchAll(/<button class="ny" data-go="([^:"]+):[^"]*" type="button"><code>([^<]*)<\/code><span>([^<]*)<\/span>/g)].map((line) => [line[1], line[2], line[3]]), [
      ['decide', 'coordinator', 'Launch on Friday?'],
      ['spec', 'G3', 'Greet in French?'],
      ['tab', 'web', 'G3 is open'],
      ['tab', '1', 'draft spec rows to approve or drop'],
    ], "the person's calls, and only those: the decision asked of them, the spec's question, the held lane, the draft row");
    assert.doesNotMatch(needs, /Which colour|Greeting|Farewell/, "an agent's ask, work waiting for a verdict and work sent back are not the person's");
    assert.match(needs, /<code>web<\/code><span>G3 is open<\/span><em>lane held by coordinator →<\/em>/, 'a held lane says who set it');

    // Each of the rest is on the board, with who holds it.
    assert.match(page.show('decisions'), /<div class="head quiet">Waiting on others<\/div><div class="ask other"><p><small><b>web-1<\/b> asks <b>coordinator<\/b>, /, "the agent's ask waits on its coordinator");
    assert.match(itemRow(page.show('chain'), 1), /<span class="chip [^"]*">to verify<\/span><\/li>$/, 'work waiting for a verdict');
    assert.ok(itemRow(page.show('chain'), 2).includes('BEHAVIOR_MISMATCH: no farewell yet'), 'and work sent back, with why');
    assert.deepEqual(agentEntries(page.show('agents')).find((agent) => agent.id === 'web-1').holds, ['#2 Farewell: sent back', '#1 Greeting: to verify'], 'the agent that built them holds both');
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
    const count = (page) => page.element('count-shouts').textContent;
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
    const rows = () => [...page.show('chain').matchAll(/<li class="row( on)?" data-item="(\d+)"/g)].map((match) => match[2] + (match[1] ? '*' : ''));
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
      const res = await fetch(`${view.base}/api/v1/boards/${id}/moves`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pullboard-key': view.key }, body: JSON.stringify(body) });
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
    const state = await (await fetch(`${view.base}/api/v1/boards`, { headers: { 'x-pullboard-key': view.key } })).json();
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
    const days = (html) => [...html.matchAll(/<h4 class="day">([^<]*)<\/h4>/g)].map((match) => match[1]);
    const times = (html) => [...html.matchAll(/<time>([^<]*)<\/time>/g)].map((match) => match[1]);
    const bare = (list) => list.length > 0 && list.every((time) => /^\d\d:\d\d$/.test(time));

    const now = await openPage(view);
    assert.deepEqual([days(now.show('feed')), days(now.show('activity'))], [['Today'], ['Today']]);
    assert.ok(bare(times(now.show('detail'))), 'a history from today shows bare times');

    const tomorrow = await openPage(view, { later: 1 });
    assert.deepEqual([days(tomorrow.show('feed')), days(tomorrow.show('activity'))], [['Yesterday'], ['Yesterday']]);

    const weekday = new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const date = new Date().toLocaleDateString([], { month: 'short', day: 'numeric' });
    const later = await openPage(view, { later: 2 });
    assert.deepEqual([days(later.show('feed')), days(later.show('activity'))], [[weekday], [weekday]], 'two days on, the feeds name the day');
    assert.ok(bare(times(later.show('feed'))) && bare(times(later.show('activity'))), 'their rows keep the clock time');
    const history = times(later.show('detail'));
    assert.ok(history.length === 3 && history.every((time) => new RegExp(`^${date} \\d\\d:\\d\\d$`).test(time)), `the history dates each move: ${history}`);

    // A heading wherever the day changes, and only there.
    const at = (day, hour) => new Date(2026, 9, day, hour).toISOString();
    const rows = JSON.stringify([at(6, 15), at(6, 9), at(5, 20), at(3, 12)].map((iso) => ({ iso })));
    const html = now.run(`byDay(${rows}, (x) => x.iso, () => '<div></div>')`);
    assert.equal(html.replace(/<h4 class="day">[^<]*<\/h4>/g, 'H').replaceAll('<div></div>', 'r'), 'HrrHrHr');
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
    assert.match(list, /data-row="doctrine:PB1"[^]*?<small class="rule-source">standard 1<\/small>/);
    assert.match(list, /data-row="doctrine:R1"[^]*?<small class="rule-source">repo<\/small>[^]*?Keep &lt;b&gt;local&lt;\/b&gt; evidence\./);
    assert.match(list, /data-row="doctrine:PB2"[^]*?<small class="rule-source">repo<\/small>[^]*?Deletion needs &lt;i&gt;two&lt;\/i&gt; approvals\./);
    assert.doesNotMatch(list, /Destructive or irreversible actions wait/);
    assert.match(list, /data-row="doctrine:PB8"[^]*?<small class="rule-source">repo<\/small>[^]*?<s>No secrets or sensitive info in the repo; test data is synthetic\.<\/s><small class="rule-reason">Reason: No &lt;script&gt;persistent&lt;\/script&gt; data is stored\.<\/small>/);
    assert.doesNotMatch(list, /<script>|<i>two<\/i>|<b>local<\/b>/, 'all repo text stays text');
    const style = await styleOf(view);
    assert.match(style, /\.rule-source, \.rule-reason \{ display: block; color: var\(--ink-muted\);/, 'labels and reasons remain separate readable lines');

    await page.click({ row: 'doctrine:PB1' });
    assert.match(page.show('doctrine-detail'), /<span class="chip">standard 1<\/span>/);
    await page.click({ row: 'doctrine:PB2' });
    assert.match(page.show('doctrine-detail'), /<span class="chip">repo<\/span>/);
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

test('spec rows read across a phone [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  // Its own house rules: a fresh init may write PRACTICE.md with none.
  writeFileSync(join(alpha.repo, 'PRACTICE.md'), '# Practice\n\n## W · Writing\n- W1 [approved, must] Numbers over adjectives. No hedges, no filler. | gate: review\n- W2 [draft, aim] One record per decision. | gate: review\n');
  const view = await startView(box);
  try {
    const page = await openPage(view, { width: 375 });
    const style = await styleOf(view);
    assert.match(style, /\n\.srow \{ display: grid; grid-template-columns: 4\.4em 6\.2em minmax\(0, 1fr\);/, 'wider, a row keeps its three columns');
    const phone = /\n@media ([^{]+) \{ \.srow \{ grid-template-columns: auto minmax\(0, 1fr\); \} \.srow > span:last-child \{ grid-column: 1 \/ -1; \} \}\n/.exec(style);
    assert.ok(phone, 'on a phone the text takes the full width below the id and status');
    assert.equal(phone[1], '(width < 480px)', 'under 480px only: at 480px itself the three columns stay');

    // The rule holds because every row is the id, then the status, then the text.
    await page.click({ rows: 'spec:all' });
    const rows = (html) => html.split('<div class="srow').slice(1);
    const shape = /^[^>]*><code>[^<]+<\/code><span><span class="chip[^"]*">[^<]+<\/span><\/span><span>[^<]+<\/span><\/div>/;
    assert.deepEqual(rows(page.show('spec-list')).map((row) => /data-row="spec:([^"]+)"/.exec(row)[1]), ['G1', 'G2']);
    for (const row of rows(page.show('spec-list'))) assert.match(row, shape);
    const doctrineShape = /^[^>]*><code>[^<]+<\/code><span><span class="chip[^"]*">[^<]+<\/span><small class="rule-source">(?:standard 1|repo)<\/small><\/span><span>[^<]+<\/span><\/div>/;
    for (const row of rows(page.show('doctrine-list'))) assert.match(row, doctrineShape, 'the source fits inside the status column, keeping the same three-column structure');
    assert.ok(rows(page.show('doctrine-list')).length > 0, 'doctrine rows are drawn the same way');
  } finally {
    await view.stop();
  }
});

test("a shout's code reference opens that code as it was at that commit [B23]", async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
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
    const button = (ref, open, before = '') => `<button class="ref" data-code="${ref}"${before ? ` data-before="${before}"` : ''} type="button" aria-expanded="${open}">${ref}</button>`;
    const prior = (text, ref) => text.slice(0, text.indexOf(ref));
    const [b1, b2, b3] = [was, now, long].map((ref) => prior(first_, ref));
    assert.ok(page.show('feed').includes(`#1</button> was ${button(was, false, b1)}, is ${button(now, false, b2)}; see ${button(long, false, b3)}.`), 'each reference is a button in the text');

    await page.click({ code: was, before: b1 });
    await page.click({ code: now, before: b2 });
    let feed = page.show('feed');
    assert.ok(feed.includes(button(was, true, b1) + '<span class="code"><span><i>1</i>greeting.html</span></span>'), 'the code as it was at that commit');
    assert.ok(feed.includes(button(now, true, b2) + '<span class="code"><span><i>1</i>  hello &lt;b&gt;there&lt;/b&gt;</span><span><i>2</i>    second line</span></span>'), 'escaped, every indent kept');

    await page.click({ code: long, before: b3 });
    feed = page.show('feed');
    const shown = feed.slice(feed.indexOf(button(long, true, b3)));
    assert.equal([...shown.matchAll(/<span><i>(\d+)<\/i>line \1<\/span>/g)].length, 60, 'at most sixty lines');
    assert.match(shown, /<i>60<\/i>line 60<\/span><span class="more">the first 60 lines<\/span><\/span>/);

    await page.run('seen = ""; refresh()');
    assert.ok(page.show('feed').includes(button(was, true, b1) + '<span class="code">'), 'a refresh keeps it open');
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
    assert.ok(feed.includes(button('/' + was, true, 'absolute ') + '<span class="code no">[BAD_REF] name a file inside the repo by its path from the top, such as src/serve.js (saw &quot;/web/greeting.html&quot;)</span>'), 'escaped, as every refusal');
    assert.ok(feed.includes(button('x+' + spaced, true, 'plus ') + '<span class="code no">[BAD_REF] name a file inside the repo by its path from the top, such as src/serve.js (saw &quot;x+web/note.txt&quot;)</span>'));
    assert.ok(feed.includes(button(spaced, true, b4) + '<span class="code no">[AMBIGUOUS] the text before it may make it &quot;web/my web/note.txt&quot;, which a reference cannot name</span>'));
    assert.ok(feed.includes(button(spaced, true, b5) + '<span class="code no">[AMBIGUOUS] the text before it may make it &quot;web/one two three four five web/note.txt&quot;, which a reference cannot name</span>'), 'however many words the path has');
    assert.ok(feed.includes(button(spaced, true) + '<span class="code"><span><i>1</i>plain note</span></span>'), 'a reference standing alone opens, whatever other files there are');

    const ask = async (ref, { root = alpha.repo, key = view.key, before = '' } = {}) => {
      const id = await boardId(view, root);
      const res = await fetch(`${view.base}/api/v1/boards/${id}/code?ref=${encodeURIComponent(ref)}&before=${encodeURIComponent(before)}`, { headers: { 'x-pullboard-key': key } });
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
    assert.ok(page.show('feed').includes(`<span class="code no">[NO_LINES] web/greeting.html has 1 lines at ${sha}</span>`));
  } finally {
    await view.stop();
  }
});
test('an empty feed says so on one line [N26]', async () => {
  const box = machine();
  project(box, 'alpha');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.equal(page.show('feed'), '<div class="empty">No shouts yet.</div>');
    assert.match(page.html, /<div class="card-panel feed" id="feed"><\/div>/, 'the shouts feed');
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
    const card = (kind, outcome) => `<span class="ev"><b>${kind}</b> ${outcome} · <button class="ref" data-go="item:1" title="Greeting" type="button">#1</button> · web-1 · <code title="${head}">${head.slice(0, 12)}</code></span>`;
    assert.ok(feed.includes('the page loads in 80ms' + card('receipt', 'measured &lt;fast&gt;')), 'what was measured, for which item, by whom, at which commit');
    assert.ok(feed.includes('tried a cache' + card('attempt', 'failed')), 'and what was tried');
    assert.ok(feed.includes('nothing to show</div>'), 'a shout with no evidence has no card');
  } finally {
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
    assert.match(await styleOf(view), /\.feed \.act \.what \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/, 'a long title keeps to one line');
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
    assert.match(style, /\n\.ny \{ display: grid; grid-template-columns: auto minmax\(5em, 1fr\) minmax\(0, max-content\);/, 'wider, a line keeps its single row');
    assert.match(style, /\n@media \(width < 480px\) \{ \.ny \{ grid-template-columns: auto minmax\(0, 1fr\); row-gap: 1px; \} \.ny em \{ grid-column: 2; \} \}\n/, 'under 480px, what it needs moves under the title');
    // The rule works because each line is the ref, then the title, then what it needs.
    assert.match(page.show('needs'), /<button class="ny" data-go="spec:G3" type="button"><code>G3<\/code><span>Should a greeting with a title long enough to need the room wrap\?<\/span><em>answer in SPEC\.md →<\/em><\/button>/);
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

/** Start one isolated headless Chrome and expose its page through a small CDP client. */
async function openSnapshotChrome(executable, url, profile) {
  const child = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-extensions', '--no-proxy-server',
    '--use-mock-keychain', '--password-store=basic', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  const stopped = new Promise((resolve) => child.once('close', resolve));
  let socket;
  let id = 0;
  const pending = new Map();
  const requests = [];
  const exceptions = [];
  try {
    let port;
    for (let attempt = 0; attempt < 100 && !port; attempt++) {
      try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; }
      catch { await browserPause(100); }
    }
    assert.ok(port, 'isolated Chrome publishes its DevTools port');
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
    /** Poll a page expression with a fixed deadline, without leaving a live interval behind. */
    const waitFor = async (expression, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await browserPause(50);
      }
      throw new Error(`Browser condition did not arrive: ${expression}`);
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Page.navigate', { url });
    return { child, stopped, socket, send, evaluate, waitFor, requests, exceptions };
  } catch (error) {
    socket?.close();
    await stopOwnedChrome(child, stopped);
    throw error;
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

  // Capture the live API state before export; the exported replay must finish at exactly this state.
  const live = await startView(box);
  let expected;
  try { expected = portableSnapshot(await boardOf(live, alpha.repo), alpha.repo); }
  finally { await live.stop(); }

  const exportDir = join(box.dir, 'snapshot-export');
  box.run(alpha.repo, 'view', '--export', exportDir);
  assert.ok(existsSync(join(exportDir, 'index.html')));
  assert.ok(existsSync(join(exportDir, 'view.css')));

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
    assert.deepEqual(initial.project, expected, 'the initial snapshot is the final live API state');
    assert.deepEqual(initial.speedOptions, ['1', '4', '16']);
    assert.ok(initial.total >= 6, 'the exported board contains the complete claim/submit/reject/claim/submit/accept history');
    assert.ok(initial.index >= initial.total - 1, 'the initial replay position is the exported final state');

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
    assert.deepEqual(JSON.parse(finalProject), expected, 'replay ends at the same state served live before export');

    for (const [width, theme] of [[1280, 'light'], [375, 'dark']]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await evaluate(`document.documentElement.dataset.theme = '${theme}'`);
      assert.equal(await evaluate('document.documentElement.scrollWidth'), width, 'snapshot controls fit the viewport');
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

test('static export redacts structured checkout paths but preserves paths people wrote [A10]', async () => {
  const box = machine();
  const alpha = project(box, 'private-project');
  box.run(alpha.repo, 'add', 'web', 'Private checkout item', '--specs', 'G1', '--criterion', 'exports without checkout paths');
  const projectRoot = alpha.repo;
  const worktreeRoot = alpha.web;
  const commonGitDir = box.git(alpha.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const live = await startView(box);
  try {
    const listingResponse = await fetch(`${live.base}/api/v1/boards`, { headers: { 'x-pullboard-key': live.key } });
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
    const boardEvents = await fetch(`${live.base}/api/v1/boards/${board.id}/events`, { headers: { 'x-pullboard-key': live.key } });
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
