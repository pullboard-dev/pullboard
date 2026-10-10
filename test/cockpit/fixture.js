/** Shared real-board, VM and Chrome fixtures for the cockpit checks [N26]. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import vm from 'node:vm';
import { closeBoard, openBoard } from '../../src/board.js';
import { fetchFresh } from '../http-fixture.js';


const BIN = resolve(import.meta.dirname, '../../bin/pullboard.js');
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
  return [...html.matchAll(/<li class="([^"]*)"[^>]*><time>([^<]*)<\/time><span><b>([^<]*)<\/b> ([^<]*)<\/span>(?:<small>(.*?)<\/small>)?<\/li>/g)].map((match) => ({
    dot: match[1],
    time: match[2],
    event: `${match[3]} ${match[4]}`,
    stay: (match[5] ?? '').replace(/<time data-ago="[^"]+">([^<]*)<\/time>/, '$1'),
  }));
}
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
      path: /title="Shouts with [^"]* \(([^"]*)\)"/.exec(entry)?.[1],
      age: /<time[^>]*>([^<]*)<\/time>/.exec(entry)?.[1],
      holds: opened.length ? opened : first ? [`${first[1]} ${first[2]}: ${first[3]}`] : [],
      more: Number(/<span class="agent-more">\+(\d+)<\/span>/.exec(entry)?.[1] ?? 0),
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

/** Unwrap only the name layout spans so full-card assertions keep checking their text and structure. */
function shoutNameText(html) {
  return html.replace(/<span class="agent-label(?: prefix)?" title="[^"]*" role="group" aria-label="[^"]*"><span class="agent-(?:id|model)">([^]*?)<\/span><span class="agent-(?:id|model)">([^]*?)<\/span><\/span>/g, '$1$2');
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

/**
 * Type words into the view's top-bar search as a keyboard does, from an empty field, and wait for their results. On a
 * timeout it names the stage it stopped at: the field's value, what has focus, whether the page has window focus, and
 * whether the results are hidden and what closed them (#394).
 */
async function searchFor(chrome, words, timeoutMs) {
  await chrome.evaluate("document.querySelector('#q').focus(); document.querySelector('#q').select()");
  await chrome.send('Input.insertText', { text: words });
  try {
    await chrome.waitFor(`document.querySelector('#q').value === ${JSON.stringify(words)} && !document.querySelector('#find-results').hidden`, timeoutMs);
  } catch (error) {
    const state = await chrome.evaluate(`JSON.stringify((() => {
      const q = document.querySelector('#q'), results = document.querySelector('#find-results'), at = document.activeElement;
      return { value: q.value, focused: at ? (at.id ? '#' + at.id : at.tagName.toLowerCase()) : null, windowFocus: document.hasFocus(), resultsHidden: results.hidden, closedBy: results.dataset.why || null };
    })())`);
    throw new Error(`the search for ${JSON.stringify(words)} did not show its results: ${state}`, { cause: error });
  }
}

export { BIN, scratch, tapTarget, SPEC, machine, project, build, sendBack, fetchReason, fetchView, fetchLive, startView, styleOf, element, ageNodes, target, settle, storage, daysOn, openPage, projectRows, productEntries, timelineRows, agentEntries, drawing, textBoxes, meet, accept, needEntries, itemRow, boardId, boardOf, assertObservationAges, withoutObservationAges, assertObservationsEqual, shoutNameText, chromeExecutable, browserPause, startSnapshotChrome, openSnapshotChrome, stopOwnedChrome, closeSnapshotChrome, watchSpecDecisionWait, earlier, shoutsAt, press, travel, pressedInto, settled, roadmapRow, showing, readRoadmap, tabBar, serveFolder, proofShot, searchFor };
