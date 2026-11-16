/**
 * The hosted-shapes matrix [H5,H17,N26]: every way a person can open a board through pullboard.dev, built with the
 * real CLI, a real local relay, a real `pullboard view` and real browsers. This module owns the cells, the screen each
 * cell must reach, the board states (each a real relay account), the browsers' stored states, and the reader that
 * says what a page shows. apps/cli/journeys/relay/hosted/shapes.test.js runs it.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { request } from 'node:http';
import {
  dirname,
  join,
} from 'node:path';
import { randomUUID } from 'node:crypto';
import { runFixtureGit } from '../child.js';
import { startView } from '../cockpit/harness.js';

/** The hosted page's real origin; every browser request to it is routed to the owned relay. */
export const HOSTED = 'https://app.pullboard.dev';
/** Where the hosted page looks for this computer's own view. */
export const LOCAL = 'http://127.0.0.1:4890';
/** The bar every cell is held to: the board within this long, or its blocker named. */
export const BOARD_MS = 3_000;
/** How long a blocker screen may take to settle before the matrix reads it: a hang ceiling, not a speed claim. */
const SETTLE_MS = 8_000;

export const WHERE = ['board-view', 'board-no-view', 'other-computer', 'phone'];
export const ACCOUNT = ['signed-out', 'signed-in'];
export const BROWSER = ['paired', 'unpaired', 'revoked'];
export const BOARDS = ['none', 'excluded', 'healthy', 'oversize', 'approval', 'mixed'];
export const STORED = ['fresh', 'stale-pairing', 'stale-key'];

/** The board item every linked fixture board carries, so a shown board is the board itself, not a row label. */
export const BOARD_ITEM = 'private cleanup fixture item';

/** Words for each place, browser and board state, used in the header and in failure messages. */
const WORDS = {
  'board-view': 'the computer with the boards, its view running',
  'board-no-view': 'the computer with the boards, no view running',
  'other-computer': 'another computer',
  phone: 'a phone',
  none: 'no board linked',
  excluded: 'its board excluded from relay on --all',
  healthy: 'one linked, healthy board',
  oversize: 'one linked board over the relay size limit',
  approval: 'one healthy board and one waiting for a phone approval',
  mixed: 'a healthy board, one over the size limit and one excluded',
};

/**
 * Every cell of the matrix, in a fixed order: where x account x browser x boards x stored.
 *
 * @returns {{ id: string, where: string, account: string, browser: string, boards: string, stored: string }[]}
 */
export function cells() {
  const out = [];
  for (const boards of BOARDS) for (const where of WHERE) for (const account of ACCOUNT) for (const browser of BROWSER) for (const stored of STORED) {
    out.push({ id: [where, account, browser, boards, stored].join('/'), where, account, browser, boards, stored });
  }
  return out;
}

/**
 * Why a cell cannot exist with real moves, or null when it can. Such a cell still runs, as the nearest state that
 * does exist (`runsAs`), and its landing screen is still checked.
 *
 * @param {{ browser: string, boards: string }} cell
 * @returns {{ reason: string, runsAs: { browser: string } } | null}
 */
export function impossibility(cell) {
  if (!['none', 'excluded'].includes(cell.boards)) return null;
  if (cell.browser === 'paired') return { reason: 'pairing hands a browser the key of a linked board; with no board linked there is no key to hold', runsAs: { browser: 'unpaired' } };
  if (cell.browser === 'revoked') return { reason: 'only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board', runsAs: { browser: 'unpaired' } };
  return null;
}

/** The setup steps the person has already taken in each board state, which no screen may offer again as the fix. */
export function stepsTaken(boards) {
  return boards === 'none' ? [] : ['pullboard relay on --all'];
}

/**
 * The screen a cell must reach. `board` means the board itself within BOARD_MS; otherwise `blocker` names what stands
 * in the way, `words` must appear on screen, and `step` says whether a command or control that clears it must show.
 *
 * @param {{ where: string, account: string, browser: string, boards: string, stored: string }} cell
 * @returns {{ board: boolean, blocker: string | null, words: RegExp | null, also: string | null }}
 */
export function expected(cell) {
  const browser = impossibility(cell)?.runsAs.browser ?? cell.browser;
  // The computer with the boards opens them from its own running view, whatever the relay holds.
  if (cell.where === 'board-view') return { board: true, blocker: null, words: null, also: null };
  if (cell.account === 'signed-out') return { board: false, blocker: 'sign-in', words: /sign in/iu, also: null };
  if (browser === 'revoked') return { board: false, blocker: 'removed', words: /removed/iu, also: null };
  if (cell.boards === 'none') return { board: false, blocker: 'not-linked', words: /no linked boards|one step/iu, also: null };
  if (cell.boards === 'excluded') return { board: false, blocker: 'excluded', words: /excluded|skipped/iu, also: null };
  if (browser === 'unpaired') return { board: false, blocker: 'unpaired', words: /not paired|pair this browser/iu, also: null };
  if (cell.stored === 'stale-key') return { board: false, blocker: 'stale-key', words: /saved key/iu, also: null };
  if (cell.boards === 'oversize') return { board: false, blocker: 'too-big', words: /size|too (?:big|large)|\bMB\b/iu, also: null };
  if (cell.boards === 'approval') return { board: true, blocker: null, words: null, also: 'approval' };
  if (cell.boards === 'mixed') return { board: true, blocker: null, words: null, also: 'too-big' };
  return { board: true, blocker: null, words: null, also: null };
}

/** One header line for a cell: its id and the screen it must reach. */
export function headerLine(cell) {
  const want = expected(cell);
  const screen = want.board ? `the board within ${BOARD_MS / 1000} s${want.also ? `, and names ${want.also}` : ''}` : `names ${want.blocker} and the one step that clears it`;
  const impossible = impossibility(cell);
  return ` * ${cell.id}: ${screen}${impossible ? ` (cannot exist: ${impossible.reason}; runs as ${impossible.runsAs.browser})` : ''}`;
}

/** Describe a board state in words. */
export function boardWords(boards) { return WORDS[boards]; }

/**
 * Sign a separate person session in through the stand-in's real OAuth, so each browser identity has its own.
 *
 * @param {{ origin: string }} box
 * @returns {Promise<string>} the pb_session token
 */
export async function freshSession(box) {
  const start = await fetch(box.origin + '/auth/github/start', { redirect: 'manual' });
  const binding = start.headers.getSetCookie().find((value) => value.startsWith('pb_oauth_binding=')).split(';')[0];
  const approved = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const callback = await fetch(approved.headers.get('location'), { redirect: 'manual', headers: { cookie: binding } });
  assert.equal(callback.status, 303, 'the stand-in GitHub sign-in completes');
  return callback.headers.getSetCookie().find((value) => value.startsWith('pb_session=')).split(';')[0].slice('pb_session='.length);
}

/**
 * The owned front for one relay: it answers every hosted request a browser makes, as pullboard.dev does, with the
 * session of the cell that asked. A route sends a request here as /__cell/<id>/<path>; the front forwards it to the
 * relay with that cell's cookie, and answers for the hosted origin, like the production edge.
 *
 * @param {string} relayOrigin
 */
export async function hostedFront(relayOrigin) {
  const sessions = new Map();
  const server = createServer((req, res) => {
    const match = /^\/__cell\/([^/]+)(\/.*)$/u.exec(req.url ?? '');
    if (!match) { res.writeHead(404); return res.end(); }
    const session = sessions.get(match[1]);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': HOSTED, 'access-control-allow-credentials': 'true',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': req.headers['access-control-request-headers'] || 'content-type', vary: 'Origin' });
      return res.end();
    }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !['host', 'connection', 'content-length', 'cookie'].includes(name.toLowerCase())));
    headers.origin = relayOrigin;
    if (session) headers.cookie = 'pb_session=' + session;
    const upstream = request(new URL(match[2], relayOrigin), { method: req.method, headers, agent: false }, (reply) => {
      const answer = Object.fromEntries(Object.entries(reply.headers).filter(([name]) => !['connection', 'transfer-encoding', 'keep-alive',
        'access-control-allow-origin', 'access-control-allow-credentials', 'set-cookie'].includes(name.toLowerCase())));
      answer['access-control-allow-origin'] = HOSTED;
      answer['access-control-allow-credentials'] = 'true';
      res.writeHead(reply.statusCode || 502, answer);
      reply.pipe(res);
    });
    res.once('close', () => upstream.destroy());
    upstream.once('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  await new Promise((ready, failed) => { server.once('error', failed); server.listen(0, '127.0.0.1', ready); });
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    /** Register one page's session (or none) and return its route. */
    route(session, viewBase) {
      const id = randomUUID();
      if (session) sessions.set(id, session);
      return async ({ url, headers }) => {
        const address = new URL(url);
        const owned = `${base}/__cell/${id}${address.pathname}${address.search}`;
        // API reads go on live, so event streams keep streaming; the page and its scripts are answered whole, as from
        // the hosted origin itself, since a browser loads a module only from its own origin.
        if (address.origin === HOSTED && address.pathname.startsWith('/api/')) return { kind: 'continue', url: owned, headers };
        if (address.origin === HOSTED) {
          const response = await fetch(owned, { headers: Object.fromEntries(Object.entries(headers).filter(([name]) => !['host', 'cookie'].includes(name.toLowerCase()))), redirect: 'manual' });
          const answer = Object.fromEntries([...response.headers].filter(([name]) => !['content-length', 'content-encoding', 'connection', 'transfer-encoding', 'keep-alive', 'date'].includes(name)));
          // The real view answers on 4890; this one has its own port, which it tells the page after connecting, so
          // the page may also reach that port, exactly as it may reach 4890.
          if (viewBase && answer['content-security-policy']) answer['content-security-policy'] = answer['content-security-policy'].replace(LOCAL, `${LOCAL} ${viewBase}`);
          return { kind: 'fulfill', status: response.status, headers: answer, body: Buffer.from(await response.arrayBuffer()) };
        }
        if (address.origin === LOCAL && viewBase) return { kind: 'continue', url: viewBase + address.pathname + address.search, headers };
        if (viewBase && address.origin === new URL(viewBase).origin) return { kind: 'continue', url, headers };
        // A view that is not running refuses the connection; nothing else is on the network.
        return { kind: 'fail' };
      };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

/**
 * The page script that puts a browser's stored state in place before the page runs: a stale pairing link left from
 * an earlier visit, or a saved board key that no longer opens the board.
 *
 * @param {string} stored
 * @param {{ keys?: Record<string, string>, boards?: string[] }} known - the identity's own saved keys, and the listed board ids
 */
export function storedScript(stored, { keys = null, boards = [] } = {}) {
  const lines = [];
  if (keys) lines.push(`localStorage.setItem('pullboard.relay.keys.v1', ${JSON.stringify(JSON.stringify(keys))});`);
  if (stored === 'stale-pairing') {
    lines.push(`sessionStorage.setItem('pullboard.relay.device-pair.v1', ${JSON.stringify(JSON.stringify({ code: 'A'.repeat(22) + '.' + 'B'.repeat(43), expires: 1 }))});`);
  }
  if (stored === 'stale-key') {
    const stale = Object.fromEntries(boards.map((board) => [board, 'A'.repeat(43)]));
    lines.push(`localStorage.setItem('pullboard.relay.keys.v1', ${JSON.stringify(JSON.stringify(stale))});`);
  }
  // Only the first document of a visit sets storage, so the page's own later writes stand.
  return lines.length ? `if (!sessionStorage.getItem('__shapes')) { sessionStorage.setItem('__shapes', '1'); ${lines.join(' ')} }` : '';
}

/**
 * What the page shows a person now: whether the board is drawn, and the words and commands on every visible screen
 * part. It reads only what is visible, so a screen hidden under another never counts.
 */
export const READ_SCREEN = `(() => {
  const seen = (node) => { if (!node) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
  const text = (node) => seen(node) ? (node.innerText || '').replace(/\\s+/g, ' ').trim() : '';
  const parts = ['#relay-screen', '#local-note', '#relay-notice', '#relay-removed', '#phone-approvals', '.first'].map((sel) => text(document.querySelector(sel))).filter(Boolean);
  const commands = [...document.querySelectorAll('code')].filter(seen).map((node) => node.textContent.replace(/^\\$\\s*/, '').trim()).filter((value) => value.startsWith('pullboard '));
  const signIn = [...document.querySelectorAll('a, button')].some((node) => seen(node) && /sign in with github/i.test(node.textContent));
  const chain = document.querySelector('#chain');
  return { board: seen(chain) && chain.textContent.includes(${JSON.stringify(BOARD_ITEM)}),
    approval: [...document.querySelectorAll('.phone-approval button')].some(seen),
    screen: document.documentElement.dataset.relayScreen || '', note: document.querySelector('#local-note')?.dataset.state || '',
    words: parts.join(' | ').slice(0, 1500), commands: [...new Set(commands)], signIn };
})()`;

/**
 * Open the genuine Items tab before witnessing the seeded board. Fresh pages now land on Dashboard;
 * a hidden item list is not a positive witness. Callers retain their original polling clocks. Once Items
 * is selected this never clicks again, so the forced missing-chain control cannot repair its own fault.
 */
export const OPEN_BOARD = `(() => {
  const tab = document.querySelector('.tab[data-tab="items"]');
  const shown = (node) => { if (!node) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
  if (tab && !tab.classList.contains('on')) {
    if (shown(tab)) tab.click();
    else {
      // Under 900 px the tabs live in the Menu drawer (dcf117ebc6): open it once, then press its Items row; never close it here.
      const drawer = document.querySelector('#mdrawer'), menu = document.querySelector('#menu-btn'), row = drawer?.querySelector('[data-tab="items"]');
      if (drawer && drawer.hidden && shown(menu) && !drawer.querySelector('[data-later]')) menu.click();
      else if (drawer && !drawer.hidden && shown(row)) row.click();
    }
  }
  return (${READ_SCREEN}).board;
})()`;

/** Read diagnostic-only state beside the final screen, without changing any ordinary poll or settle key. */
const READ_CAPTURE = `(() => {
  const screen = ${READ_SCREEN};
  const seen = node => { if (!node) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
  const chain = document.querySelector('#chain');
  const first = document.querySelector('.first');
  const visiblePanels = ['#relay-screen', '#local-note', '#relay-notice', '#relay-removed', '#phone-approvals', '.first']
    .filter(selector => seen(document.querySelector(selector)));
  const busyIndicators = { loading: document.body.classList.contains('loading'),
    projectLoading: seen(document.querySelector('#project-loading')),
    ariaBusy: [...document.querySelectorAll('[aria-busy="true"]')].some(seen),
    checkingText: /checking|finding your boards|connecting/iu.test(screen.words) };
  const pageState = { screen: document.documentElement.dataset.relayScreen || '',
    localNote: document.querySelector('#local-note')?.dataset.state || '', visiblePanels,
    busy: Object.values(busyIndicators).some(Boolean), busyIndicators,
    chain: { present: Boolean(chain), visible: seen(chain), hasExpectedItem: Boolean(chain?.textContent.includes(${JSON.stringify(BOARD_ITEM)})) },
    noBoardsYet: { present: Boolean(first), visible: seen(first), text: (first?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 1000) } };
  return { ...screen, pageState };
})()`;

/**
 * Judge what a page showed against the cell's screen. Returns null when it holds, else the reason it does not.
 *
 * @param {object} cell
 * @param {{ board: boolean, approval: boolean, words: string, commands: string[], signIn: boolean, ms: number }} seen
 * @param {string[]} [ineffective] - commands this run executed and found not to clear the cell's blocker
 */
export function judge(cell, seen, ineffective = []) {
  const want = expected(cell);
  const taken = stepsTaken(cell.boards);
  const repeated = seen.commands.filter((command) => taken.includes(command));
  const useless = seen.commands.filter((command) => ineffective.includes(command));
  if (want.board) {
    if (!seen.board) return `the board did not show within ${BOARD_MS} ms`;
    if (seen.ms > BOARD_MS) return `the board took ${seen.ms} ms`;
    if (want.also === 'approval' && !seen.approval && !/waiting for (?:a |your )?phone|approv/iu.test(seen.words)) return 'the board showed, but not the board waiting for a phone approval';
    if (want.also === 'too-big' && !/size|too (?:big|large)|\bMB\b/iu.test(seen.words)) return 'the board showed, but the board over the size limit is not named';
    return null;
  }
  if (seen.board) return `showed the board, but ${want.blocker} should stop it`;
  if (!want.words.test(seen.words)) return `does not name ${want.blocker}`;
  if (repeated.length) return `offers ${repeated.join(', ')}, a step already taken`;
  if (useless.length && useless.length === seen.commands.length) return `offers ${useless.join(', ')}, which was run and did not clear it`;
  if (want.blocker === 'sign-in' ? !seen.signIn : !seen.commands.length && !/sign in|pairing link/iu.test(seen.words)) return `names ${want.blocker} but no step that clears it`;
  return null;
}

/** Bind the final screen read to this visit's unchanged budget, before its browser page closes. */
function visitCapture(seen, started, wantsBoard) {
  return { ...(seen?.pageState ?? { unavailable: true }), capturedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started, budgetMs: wantsBoard ? BOARD_MS : SETTLE_MS };
}

/**
 * Open one cell's page, wait for its screen and read it.
 *
 * @param {{ newPage: Function }} context - the identity's browser context
 * @param {object} options - route, phone, bootstrap, and the owned local view's document route when this cell has one
 * @param {boolean} wantsBoard - wait for the board rather than a settled blocker
 */
export async function visit(context, { route, phone, bootstrap, localView = null }, wantsBoard) {
  const page = await context.newPage({ route, phone, bootstrap });
  const started = Date.now();
  try {
    await page.navigate(HOSTED + '/');
    if (wantsBoard) {
      let shown = await page.poll(`(${OPEN_BOARD}) || ${localView ? `((document.querySelector('#local-note')?.dataset.state === 'local-open' || document.querySelector('[data-part="local-command"]')?.hidden === false) && (${READ_SCREEN}).commands.includes('pullboard view'))` : 'false'}`, BOARD_MS + 2_000);
      if (shown && localView && !(await page.evaluate(READ_SCREEN)).board) {
        // The person follows the displayed pullboard view step. This fixture already owns that running view and its
        // printed address: open its authenticated document route, never inject a key or relax the board assertion.
        await page.navigate(localView);
        shown = await page.poll(OPEN_BOARD, BOARD_MS + 2_000);
      }
      const seen = await page.evaluate(READ_CAPTURE);
      const ms = shown ? Date.now() - started : null; // the board's own clock stops here, before the notices are read
      // Items opens on its list alone and hides the relay's notices (#6648, view/io/main.css); they stay on the
      // Dashboard. The board is witnessed above on Items; the notices are read here, from the tab that shows them.
      if (seen.board) {
        await page.evaluate(`document.querySelector('.tab[data-tab="dashboard"]')?.click()`);
        const notices = await page.poll(`document.querySelector('#relay-notice')?.getClientRects().length ? (${READ_SCREEN}).words : ''`, 500);
        if (notices) seen.words = notices;
      }
      return { ...seen, ms, exceptions: page.exceptions.length,
        capture: visitCapture(seen, started, wantsBoard) };
    }
    // A blocker screen settles when it has stopped changing for half a second and is not still checking.
    let last = '';
    let since = Date.now();
    let seen = null;
    while (Date.now() - started < SETTLE_MS) {
      try { seen = await page.evaluate(READ_SCREEN); } catch { seen = null; }
      const key = JSON.stringify(seen);
      if (key !== last) { last = key; since = Date.now(); }
      // A blank page has not settled: a person cannot act on nothing, so it is read again until the ceiling.
      else if (Date.now() - since >= 500 && seen && (seen.board || seen.words || seen.signIn) && !/checking|finding your boards|connecting/iu.test(seen.words)) break;
      await new Promise((later) => setTimeout(later, 50)); // budget: poll interval while the screen settles, no speed claim.
    }
    const ms = Date.now() - started;
    const final = await page.evaluate(READ_CAPTURE).catch(() => null);
    return { ...(seen ?? { board: false, approval: false, words: '', commands: [], signIn: false }), ms, exceptions: page.exceptions.length,
      capture: visitCapture(final, started, wantsBoard) };
  } catch (error) {
    const final = await page.evaluate(READ_CAPTURE).catch(() => null);
    error.pageState = visitCapture(final, started, wantsBoard);
    throw error;
  } finally { await page.close(); }
}

/**
 * Make another real project on the same computer, as a person would: a clone with an origin, then pullboard init.
 *
 * @param {object} box - the relay fixture
 * @param {string} name
 * @param {string} repository - owner/name on the stand-in GitHub
 */
export async function siblingProject(box, name, repository) {
  const root = join(dirname(box.root), name);
  mkdirSync(root);
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'fixture base'],
    ['remote', 'add', 'origin', `git@github.com:${repository}.git`]]) runFixtureGit(args, { cwd: root, env: box.env, encoding: 'utf8' });
  // The stand-in GitHub grants access by repository name, as the approval fixtures do.
  const granted = repository.split('/').at(-1);
  if (!box.providerState.repositories.includes(granted)) box.providerState.repositories.push(granted);
  assert.equal((await box.cliAt(root, 'init')).code, 0, `${name} initializes`);
  return root;
}

/**
 * Run the real foreground relay on --all and, when it offers a first-device pairing, pair the given browser page
 * through it: the same link a person opens from the terminal.
 *
 * @param {object} box
 * @param {(link: string) => Promise<void>} [openLink] - opens the printed pairing link in a browser
 * @returns {Promise<object>} the command's JSON result
 */
export async function relayOnAll(box, openLink) {
  const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  // A pairing an earlier run left behind is not this run's; only a new locator is.
  const earlier = existsSync(machineFile) ? JSON.parse(readFileSync(machineFile, 'utf8')).pending?.locator ?? null : null;
  const run = box.startCli(['relay', 'on', '--all', '--url', box.origin]);
  if (openLink) {
    const end = Date.now() + 60_000;
    let pending = null;
    while (!pending && Date.now() < end) {
      if (run.child.exitCode !== null) break;
      if (existsSync(machineFile)) {
        const offered = JSON.parse(readFileSync(machineFile, 'utf8')).pending;
        if (offered && offered.locator !== earlier) pending = offered;
      }
      if (!pending) await new Promise((later) => setTimeout(later, 50)); // budget: poll interval for the published pairing, under a 60 s hang ceiling.
    }
    assert.ok(pending, 'relay on --all offers this browser its pairing link');
    await openLink(`${HOSTED}/#device=${pending.locator}.${pending.secret}`);
  }
  const result = await run.closed;
  assert.equal(result.code, 0, `relay on --all completes: ${result.stderr.slice(-400)} ${result.stdout.slice(-600)}`);
  return JSON.parse(result.stdout);
}

/**
 * Revoke one enrolled browser the way a person does: pullboard relay revoke, through a fresh provider sign-in.
 *
 * @param {object} box
 * @param {string} deviceId
 */
export async function revokeDevice(box, deviceId) {
  const authorized = box.providerState.deviceAuthorized;
  box.providerState.deviceAuthorized = false;
  try {
    const revoke = box.startCli(['relay', 'revoke', deviceId]);
    await revoke.waitForOutput('Sign in with GitHub: open ');
    box.providerState.deviceAuthorized = true;
    const result = await revoke.closed;
    assert.equal(result.code, 0, 'relay revoke completes');
  } finally { box.providerState.deviceAuthorized = authorized; }
}

/** The devices this computer has enrolled. */
export function enrolledDevices(box) {
  return JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'relay-machine/state.json'), 'utf8')).devices.map((device) => device.deviceId);
}

/** Start this computer's real view, the one the hosted page finds on 127.0.0.1:4890. */
export function boardView(box) {
  return startView({ dir: box.root, env: box.env });
}

/**
 * Run the step an unpaired browser is offered, `pullboard relay pair`, and open the link it prints in a fresh signed-in
 * browser, as the page tells the person to: true when the board then opens, so the step really clears the blocker.
 *
 * @param {object} box
 * @param {{ newContext: Function }} engine
 * @param {object} front
 * @param {string} session
 */
export async function relayPairClears(box, engine, front, session) {
  const result = await box.cli('relay', 'pair');
  // A step that fails to run clears nothing.
  if (result.code !== 0) return false;
  const printed = new URL(result.document.link);
  const context = await engine.newContext();
  try {
    const page = await context.newPage({ route: front.route(session, null) });
    await page.navigate(HOSTED + '/' + printed.hash);
    return Boolean(await page.poll(OPEN_BOARD, 8_000));
  } finally { await context.close(); }
}
