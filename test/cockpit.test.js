/**
 * The view's page as the person sees it (N26, N27). Each test sets up real projects with the real
 * CLI, starts `pullboard view` over them, and runs the page it serves in a vm with just enough of a
 * document for its script: every element the page names by id records what the script writes into
 * it, and the script's requests go to that view. Nothing is stood in for but the browser.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import vm from 'node:vm';

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
 * worktree joined to it as web-1.
 */
function project(box, name, spec = SPEC) {
  const repo = join(box.dir, name);
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  box.run(repo, 'init');
  const config = { gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h', lanes: { web: { owns: ['web/'], specs: ['G'] } }, shared: [] };
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

/**
 * Start `pullboard view` on the machine and read the link it prints; stop() ends it.
 */
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
  return { link, key: link.searchParams.get('k'), base: `http://127.0.0.1:${link.port}`, stop };
}

/**
 * An element as the page's script uses one: what it writes, its classes and attributes, the
 * listeners it adds, and how often it was scrolled into view.
 */
function element(id) {
  const classes = new Set();
  let html = '';
  let text = '';
  return {
    id,
    // A browser keeps both as strings, whatever the script assigns.
    get innerHTML() { return html; },
    set innerHTML(value) { html = String(value ?? ''); },
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
 * Open the page a view serves, at a window width, and wait for its first board. show(id) is what
 * that region holds; click() and type() act as the person would.
 */
async function openPage(view, { width = 1280 } = {}) {
  const html = await (await fetch(view.link)).text();
  const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const known = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const elements = new Map();
  const node = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const clicks = [];
  const inflight = new Set();
  const document = {
    body: element('body'),
    hidden: false,
    getElementById: (id) => (known.has(id) ? node(id) : null),
    querySelectorAll: () => [],
    addEventListener: (type, listener) => { if (type === 'click') clicks.push(listener); },
  };
  const context = vm.createContext({
    document,
    location: { search: `?k=${view.key}` },
    URLSearchParams,
    innerWidth: width,
    innerHeight: 800,
    matchMedia: (query) => ({ matches: width <= Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? Infinity) }),
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
    fetch: (path, init) => {
      const answer = fetch(`${view.base}${path}`, init).then(async (res) => {
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
  await settle(inflight);
  return {
    html,
    show: (id) => node(id).innerHTML,
    element: node,
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
    assert.match(page.html, /\.shell \{ display: grid; grid-template-columns: var\(--side-w\) minmax\(0, 1fr\);/, 'a sidebar column beside the main one');
    assert.match(page.html, /@media \(max-width: 900px\) \{[^@]*\.side-body \{ display: none;[^@]*\.side\.open \.side-body \{ display: grid; \}/, 'under 900px the list folds behind the project button');

    assert.deepEqual(projectRows(page.show('proj-list')), [
      { root: alpha.repo, name: 'alpha', needs: '2', line: '1 sent back · 1 to verify', current: true },
      { root: beta.repo, name: 'beta', needs: '2', line: '1 question · 1 lane held', current: false },
      { root: gamma.repo.replace('<', '&lt;').replace('>', '&gt;'), name: 'gam&lt;i&gt;ma', needs: '', line: '1 item open', current: false },
    ]);
    assert.match(page.show('chain'), /Greeting/);

    await page.click({ root: gamma.repo, classes: 'proj side' });
    assert.deepEqual(projectRows(page.show('proj-list')).map((row) => [row.name, row.current]), [['alpha', false], ['beta', false], ['gam&lt;i&gt;ma', true]]);
    assert.match(page.show('chain'), /Gamma page/, 'the main column shows the project picked');
    assert.doesNotMatch(page.show('chain'), /Greeting/);
    assert.equal(page.element('proj-name').textContent, 'gam<i>ma');
    assert.equal(page.element('proj-elsewhere').textContent, '4 elsewhere', 'the folded button counts what needs the person elsewhere');

    await page.click({ id: 'proj-switch', classes: 'switch-btn side' });
    assert.ok(page.element('side').classList.contains('open'), 'the project button opens the list');
    assert.equal(page.element('proj-switch').getAttribute('aria-expanded'), 'true');
    await page.click({ classes: 'row' });
    assert.ok(!page.element('side').classList.contains('open'), 'a click outside the sidebar folds it again');
  } finally {
    await view.stop();
  }
});
