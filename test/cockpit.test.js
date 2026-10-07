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
import { MACHINE } from '../src/machine.js';

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
 * page's clock that many days on. show(id) is what that region holds; click() and type() act as
 * the person would.
 */
async function openPage(view, { width = 1280, later = 0 } = {}) {
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
    querySelectorAll: (selector) => (selector === '[data-ago]' ? [...elements.values()].flatMap(ageNodes) : []),
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
    ...(later ? { Date: daysOn(later) } : {}),
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

test('the tabs fit one row on a phone [N26]', async () => {
  const view = await startView(machine());
  try {
    const html = await (await fetch(view.link)).text();
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
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
/**
 * The products the sidebar shows: name, rows met, how full the bar is, and the item counts with the
 * state each dot is coloured for.
 */
function productEntries(html) {
  return html.split('<div class="prod"').slice(1).map((entry) => ({
    name: /<b>([^<]*)<\/b>/.exec(entry)?.[1],
    met: /<span>([^<]*) rows met<\/span>/.exec(entry)?.[1],
    bar: Number(/<i style="width:(\d+)%">/.exec(entry)?.[1]),
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
    assert.equal(title(), '(3) alpha · Pullboard', 'one sent back and one to verify here, one lane held in beta');
    page.run(`switchTo(${JSON.stringify(calm.repo)})`);
    assert.equal(title(), '(3) calm · Pullboard', 'a switch names the project at once; the count still covers them all');
    await page.run('refresh()');
    assert.equal(title(), '(3) calm · Pullboard');

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
/**
 * The lifecycle drawing: each box's state, count and title; each arrow's title, the pair of states
 * its title starts with, and the label drawn with it, if any.
 */
function drawing(svg) {
  return {
    boxes: [...svg.matchAll(/<g class="s-([^"]+)"><title>([^<]*)<\/title>[^]*?<text class="n"[^>]*>(\d+)<\/text>/g)].map((match) => ({ state: match[1], title: match[2], count: Number(match[3]) })),
    arrows: [...svg.matchAll(/<g><title>([^<]*)<\/title><path class="edge[^"]*"[^>]*\/>(?:<text class="tag([^"]*)"[^>]*>([^<]*)<\/text>)?<\/g>/g)].map((match) => ({
      title: match[1],
      pair: /^\w+, (\w+) to (\w+),/.exec(match[1]).slice(1).join('>'),
      label: match[3] === undefined ? null : match[3] + (match[2].includes('idle') ? ' (none yet)' : ''),
    })),
    sentBack: /<text class="sub"[^>]*>([^<]*)<\/text>/.exec(svg)?.[1],
  };
}

test('the activity tab draws the lifecycle from the declaration, with live counts [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  for (const title of ['Greeting', 'Farewell', 'Header', 'Footer', 'Sidebar', 'Banner', 'Menu', 'Search']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 1, 'greeting.html');
  accept(box, alpha, 1);
  build(box, alpha, 2, 'farewell.html');
  sendBack(box, alpha, 2, 'no farewell');
  // Withdrawn from claimed twice, from submitted once and from open once, so each arrow has its count.
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
    const { boxes, arrows, sentBack } = drawing(page.show('flow'));

    const esc = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    assert.deepEqual(boxes.map((entry) => entry.state), MACHINE.states.map((state) => state.id), 'a box for every declared state');
    for (const state of MACHINE.states) assert.ok(boxes.find((entry) => entry.state === state.id).title.startsWith(esc(`${state.id}: ${state.means}`)), `${state.id} says what it means`);
    assert.match(boxes.find((entry) => entry.state === 'verified').title, /Every way in checks:\n {2}the caller&#39;s checkout contains the submitted commit\n {2}the caller did not build it/);
    assert.deepEqual(Object.fromEntries(boxes.map((entry) => [entry.state, entry.count])), { open: 2, claimed: 1, submitted: 0, verified: 1, withdrawn: 4 });
    assert.equal(sentBack, '1 sent back');

    const pairs = new Set(MACHINE.moves.flatMap((move) => move.from.map((from) => `${from}>${move.to}`)));
    assert.deepEqual(arrows.map((arrow) => arrow.pair).sort(), [...pairs].sort(), 'one arrow per pair of states a move joins');
    for (const move of MACHINE.moves) {
      for (const from of move.from) assert.ok(arrows.find((arrow) => arrow.pair === `${from}>${move.to}`).title.includes(`${move.verb}, ${from} to ${move.to}, by the ${move.by.join(' or ')}: `), `${move.verb} from ${from} is on its arrow`);
    }
    assert.ok(arrows.some((arrow) => arrow.title.includes('claim, open to claimed, by the agent or coordinator: pullboard claim &lt;id&gt;. Made 6 times.\nChecks, in order:\n  the caller is the main checkout, or a worktree that joined a lane (NOT_JOINED)\n  the item exists (NO_ITEM)\n  the item is open or claimed (NOT_CLAIMABLE)')), 'each check in order, escaped');
    // Every arrow carries its own label: the moves made along it and how often, or its moves when none was.
    assert.deepEqual(Object.fromEntries(arrows.map((arrow) => [arrow.pair, arrow.label])), {
      'open>claimed': 'claim 6',
      'claimed>claimed': 'claim 1',
      'claimed>open': 'release · lapse · escalate · refreeze (none yet)',
      'claimed>submitted': 'submit 3',
      'submitted>submitted': 'reserve (none yet)',
      'submitted>verified': 'accept 1',
      'submitted>open': 'reject 1',
      'open>open': 'escalate · refreeze (none yet)',
      'open>withdrawn': 'withdraw 1',
      'claimed>withdrawn': 'withdraw 2',
      'submitted>withdrawn': 'withdraw 1',
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
test('ages stay true while the board is quiet [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const ages = () => ({
      row: /<time data-ago="[^"]+">([^<]*)<\/time>/.exec(itemRow(page.show('chain'), 1))?.[1],
      needs: /to verify, <time data-ago="[^"]+">([^<]*)<\/time>/.exec(page.show('needs'))?.[1],
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
 * The board as the view serves it for one project.
 */
async function boardOf(view, root) {
  const res = await fetch(`${view.base}/api/state?root=${encodeURIComponent(root)}`, { headers: { 'x-pullboard-key': view.key } });
  return (await res.json()).project;
}

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
    assert.match(needs, /<code>#1<\/code><span>Greeting<\/span><em>sent back: BEHAVIOR_MISMATCH →<\/em>/);
    assert.match(needs, /<code>#2<\/code><span>Farewell<\/span><em>resubmitted after BEHAVIOR_MISMATCH, <time data-ago="[^"]+">\w+<\/time> →<\/em>/);
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

test('spec rows read across a phone [N26]', async () => {
  const box = machine();
  project(box, 'alpha');
  const view = await startView(box);
  try {
    const page = await openPage(view, { width: 375 });
    const style = page.html.slice(page.html.indexOf('<style>'), page.html.indexOf('</style>'));
    assert.match(style, /\n\.srow \{ display: grid; grid-template-columns: 4\.4em 6\.2em minmax\(0, 1fr\);/, 'wider, a row keeps its three columns');
    const phone = /\n@media ([^{]+) \{ \.srow \{ grid-template-columns: auto minmax\(0, 1fr\); \} \.srow > span:last-child \{ grid-column: 1 \/ -1; \} \}\n/.exec(style);
    assert.ok(phone, 'on a phone the text takes the full width below the id and status');
    assert.equal(phone[1], '(width < 480px)', 'under 480px only: at 480px itself the three columns stay');

    // The rule holds because every row is the id, then the status, then the text.
    await page.click({ rows: 'spec:all' });
    const rows = (html) => html.split('<div class="srow').slice(1);
    const shape = /^[^>]*><code>[^<]+<\/code><span><span class="chip[^"]*">[^<]+<\/span><\/span><span>[^<]+<\/span><\/div>/;
    assert.deepEqual(rows(page.show('spec-list')).map((row) => /data-row="spec:([^"]+)"/.exec(row)[1]), ['G1', 'G2']);
    for (const row of [...rows(page.show('spec-list')), ...rows(page.show('doctrine-list'))]) assert.match(row, shape);
    assert.ok(rows(page.show('doctrine-list')).length > 0, 'doctrine rows are drawn the same way');
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
    assert.match(page.html, /\.feed \.act \.what \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/, 'a long title keeps to one line');
  } finally {
    await view.stop();
  }
});
