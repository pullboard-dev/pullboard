/**
 * `pullboard view` (N26, N27): the person's micro site. One page on this machine shows every
 * registered project: items by state, what needs the person, shouts, doctrine, agents and activity,
 * refreshing itself. Reads and actions use the shared local API v1 handler (A3); actions run the
 * real CLI in the project, so every rule and refusal applies exactly as at a terminal.
 *
 * It listens on the loopback address only and answers nothing without the session's secret and its
 * own Host, so another site in the browser cannot reach it. It opens no outbound connection (P5).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import * as store from './board.js';
import { cockpitPage } from './cockpit.js';
import { COORDINATOR, loadConfig } from './config.js';
import { loadDoctrine, standardDoctrine } from './doctrine.js';
import { repoInfo, resolveCommit } from './git.js';
import { productSummaries } from './products.js';
import { listApiProjects, registryFile } from './projects.js';
import { Refused } from './refused.js';
import { loadSpec } from './spec.js';

/** The page's styles (N26), read once: the page links them, so it needs no inline style. */
const VIEW_CSS = readFileSync(new URL('./view.css', import.meta.url), 'utf8');
export const LOOPBACK = '127.0.0.1';

/**
 * Replace only board-recorded filesystem fields in exported API documents. Event details are
 * JSON records too; free text such as shouts, criteria, briefs and verdict notes stays verbatim.
 *
 * @param {any} value
 * @param {string} root
 * @param {string} [field]
 * @returns {any}
 */
export function portableSnapshot(value, root, field = '') {
  if (Array.isArray(value)) return value.map((entry) => portableSnapshot(entry, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, portableSnapshot(entry, root, key)]));
  if (typeof value !== 'string') return value;
  if (field === 'event_detail') {
    try { return JSON.stringify(portableSnapshot(JSON.parse(value), root)); }
    catch { return value; }
  }
  if (['root', 'path', 'agent_path', 'git_dir', 'gitDir', 'commonDir', 'worktree'].includes(field) && isAbsolute(value)) {
    return resolve(value) === resolve(root) ? basename(root) : relative(root, value);
  }
  return value;
}

/**
 * Export one board through the same API v1 used by the live page, closing its temporary local
 * transport before returning. The static page needs neither that transport nor its session key.
 *
 * @param {string} root
 * @param {string} directory
 * @returns {Promise<{path: string}>}
 */
export async function exportView(root, directory) {
  const output = resolve(directory);
  if (existsSync(output) && (!statSync(output).isDirectory() || readdirSync(output).length)) {
    throw new Refused('EXPORT_EXISTS', `snapshot folder ${output} is not empty; use an empty folder`);
  }
  const info = repoInfo(root);
  const config = loadConfig(info.root);
  const registered = listApiProjects().find((entry) => {
    try { return repoInfo(entry.root).commonDir === info.commonDir; } catch { return false; }
  }) ?? { root: info.root, name: config.name || basename(info.root), project: config.project || '', added: new Date().toISOString() };
  const { serveApi } = await import('./api.js');
  const { main } = await import('./cli.js');
  const api = await serveApi({ port: 0, projects: () => [registered], runCommand: main });
  let listing;
  let state;
  let events;
  try {
    const address = new URL(api.url);
    /** Read an authenticated API document without putting its private key in the snapshot. */
    const read = async (path) => {
      const reply = await fetch(address.origin + path, { headers: { 'x-pullboard-key': address.searchParams.get('k') } });
      const document = await reply.json();
      if (!reply.ok) throw new Refused(document.error.code, document.error.message);
      return document;
    };
    listing = await read('/api/v1/boards');
    const board = listing.boards[0];
    if (!board) {
      const version = listing.warnings?.map((warning) => warning.error?.error).find((error) => error?.code === 'EVENT_LOG_VERSION');
      if (version) throw new Refused(version.code, version.message);
      throw new Refused('NO_BOARD', 'no readable board to export; run pullboard init in this repo');
    }
    const path = '/api/v1/boards/' + encodeURIComponent(board.id);
    state = await read(path + '/state');
    events = await read(path + '/events');
    const last = state.state.events[0]?.event_id ?? 0;
    events.events = events.events.filter((event) => event.event_id <= last);
  } finally {
    await api.close();
  }
  listing = portableSnapshot(listing, info.root);
  state = portableSnapshot(state, info.root);
  events = portableSnapshot(events, info.root);
  const boardPath = join(output, 'api', 'v1', 'boards', listing.boards[0].id);
  mkdirSync(boardPath, { recursive: true });
  writeFileSync(join(output, 'index.html'), cockpitPage('', { snapshot: true }));
  writeFileSync(join(output, 'view.css'), VIEW_CSS);
  writeFileSync(join(output, 'api', 'v1', 'boards.json'), JSON.stringify(listing) + '\n');
  writeFileSync(join(boardPath, 'state.json'), JSON.stringify(state) + '\n');
  writeFileSync(join(boardPath, 'events.json'), JSON.stringify(events) + '\n');
  return { path: output };
}

/** Where the view keeps the port it last served from, beside the machine's list of projects. */
const lastPortFile = () => join(dirname(registryFile()), 'view.json');

/**
 * The port the view last served from, or 0 when it has none to offer. A browser keeps what the page
 * stores per address, port included, so serving from the same port again is what lets the person's
 * choices, such as a hidden figure or a theme, outlive a restart.
 *
 * @returns {number}
 */
export function lastPort() {
  try {
    const port = JSON.parse(readFileSync(lastPortFile(), 'utf8')).port;
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 0;
  } catch {
    return 0;
  }
}

/**
 * Remember the port the view serves from. Failing to is no reason to stop serving, so it never throws.
 *
 * @param {number} port
 */
function rememberPort(port) {
  try {
    mkdirSync(dirname(lastPortFile()), { recursive: true });
    writeFileSync(lastPortFile(), `${JSON.stringify({ port })}\n`);
  } catch {
    // The next start picks a free port instead.
  }
}

/**
 * Open a project's board, read from it, and always close it.
 *
 * @template T
 * @param {string} root
 * @param {(board: any, info: any, config: any) => T} read
 * @returns {T}
 */
function withProject(root, read) {
  const info = repoInfo(root);
  const config = loadConfig(info.root);
  const board = store.openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'));
  try {
    return read(board, info, config);
  } finally {
    store.closeBoard(board);
  }
}

/**
 * Everything the page shows for one project. Given the newest shout the person has seen there,
 * it also counts every shout since, which the forty it sends cannot always show.
 *
 * @param {string} root
 * @param {{ seen?: number | null }} [options]
 * @returns {any}
 */
export function projectState(root, { seen = null } = {}) {
  return withProject(root, (board, info, config) => {
    const all = store.listItems(board, { all: true });
    const status = new Map(all.map((item) => [item.item_id, item.item_status]));
    const rows = (file) => loadSpec(info.root, { ...config, spec: file }).rows.map(({ id, status: state, tier, text, gate, serves, section }) => ({ id, status: state, tier, text, gate, serves, section }));
    const doctrine = loadDoctrine(info.root, config);
    // A decline's text is its reason. Keep the inherited rule available so the page strikes the
    // rule itself, while showing the repo's reason beside it.
    const inherited = new Map(standardDoctrine().rows.map((row) => [row.id, row.text]));
    const verdict = (row) => ({ decision: row.verdict_decision, reason: row.verdict_reason, note: row.verdict_note, by: row.verdict_by, at: row.verdict_at, commit: row.verdict_commit });
    const log = store.events(board);
    // When each agent last moved on the board: the log is in order, so the last write wins.
    const lastMove = new Map(log.map((event) => [event.event_by, event.event_at]));
    return {
      root: info.root,
      lanes: [COORDINATOR, ...Object.keys(config.lanes)],
      // The lanes that own folders, where builders work; review lanes own none.
      owning: Object.keys(config.lanes).filter((lane) => (config.lanes[lane].owns ?? []).length > 0),
      items: all.map((item) => {
        const verdicts = store.verdictsFor(board, item.item_id).map(verdict);
        const after = item.item_after ? item.item_after.split(',').map(Number) : [];
        return {
          id: item.item_id,
          title: item.item_title,
          lane: item.item_lane,
          status: item.item_status,
          route: item.item_route,
          owner: item.item_owner,
          // Who holds the review under a live lease (V15), by the board's own rule.
          reviewer: store.reviewHolder(board, item),
          reviewUntil: item.item_review_until ?? null,
          builtBy: item.item_built_by,
          verifiedBy: item.item_verified_by,
          specs: item.item_spec_ids ? item.item_spec_ids.split(',') : [],
          criterion: item.item_criterion,
          brief: item.item_brief,
          commit: item.item_commit,
          merged: item.item_merged_commit,
          blockedBy: after.filter((id) => status.get(id) !== 'verified'),
          updatedAt: item.item_updated_at,
          verdict: verdicts.at(-1) ?? null,
          verdicts,
          history: store.events(board, { itemId: item.item_id }).map((event) => ({ kind: event.event_kind, by: event.event_by, at: event.event_at })),
        };
      }),
      shouts: store.recentShouts(board, 40),
      // Every ask still waiting for an answer, however far back the forty shouts reach (B21): the
      // person's to answer here, and the rest with who holds them (B26).
      decisions: store.openDecisions(board, store.PERSON),
      asked: store.openDecisions(board).filter((ask) => ask.shout_to !== store.PERSON),
      events: log.slice(-80).reverse(),
      agents: store.listAgents(board).map((agent) => ({ ...agent, lastMoveAt: lastMove.get(agent.agent_id) ?? null })),
      holds: store.laneHolds(board),
      spec: rows(config.spec),
      practice: doctrine.rows.map(({ id, status: state, tier, text, gate, serves, section, origin, version, reason }) => ({
        id, status: state, tier, text, gate, serves, section, origin, version, reason,
        ...(state === 'wont' && inherited.has(id) ? { standardText: inherited.get(id) } : {}),
      })),
      unseen: seen === null ? null : { since: seen, count: board.db.prepare('SELECT COUNT(*) AS n FROM shout WHERE shout_id > ?').get(seen).n },
      // Each product's progress, counted as pullboard status counts it (N28).
      products: productSummaries(config, loadSpec(info.root, config), all),
    };
  });
}

/** The most lines one code reference shows (B23). */
export const CODE_LINES = 60;
/** The largest file a code reference reads, in bytes. */
const CODE_BYTES = 2_000_000;

/**
 * The lines a shout's path:lines@commit reference names, as they were at that commit (B23). Git
 * alone reads them, from the commit's own tree: never the working tree, never a path outside the
 * repo, never a revision that is not a plain SHA, never lines past the file's end, and never more
 * than CODE_LINES lines. A reference is one word, so the text written before it on its line may be
 * the start of a longer path that ends in this one: when the commit holds such a file, the reference
 * may mean it, and it is refused rather than opened as a different file.
 *
 * @param {string} root
 * @param {{ path: string, from: number, to: number, commit: string, before?: string }} ref
 * @returns {{ path: string, commit: string, from: number, to: number, lines: string[], more: boolean }}
 */
export function codeAt(root, { path, from, to, commit, before = '' }) {
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Refused('BAD_REF', `name the commit by its SHA, 7 to 40 hex digits (saw "${commit}")`);
  if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(path) || path.split('/').some((part) => part === '.' || part === '..')) {
    throw new Refused('BAD_REF', `name a file inside the repo by its path from the top, such as src/serve.js (saw "${path}")`);
  }
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to >= from)) throw new Refused('BAD_REF', 'name the lines as 12, or 12-30');
  const full = resolveCommit(root, commit);
  if (!full) throw new Refused('NO_COMMIT', `no commit ${commit} in this repo`);
  const object = `${full}:${path}`;
  const type = spawnSync('git', ['cat-file', '-t', object], { cwd: root, encoding: 'utf8' });
  if (type.status !== 0 || type.stdout.trim() !== 'blob') throw new Refused('NO_FILE', `no file ${path} at ${commit}`);
  const written = `${before}${path}`;
  const names = spawnSync('git', ['ls-tree', '-r', '-z', '--name-only', full], { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000 }).stdout.split('\0');
  const longer = names.find((name) => name.length > path.length && name.endsWith(path) && written.endsWith(name));
  if (longer) throw new Refused('AMBIGUOUS', `the text before it may make it "${longer}", which a reference cannot name`);
  const size = Number(spawnSync('git', ['cat-file', '-s', object], { cwd: root, encoding: 'utf8' }).stdout);
  if (!(size <= CODE_BYTES)) throw new Refused('TOO_LARGE', `${path} is over ${CODE_BYTES / 1_000_000} MB, too large to show`);
  const lines = spawnSync('git', ['cat-file', 'blob', object], { cwd: root, encoding: 'utf8', maxBuffer: CODE_BYTES + 1 }).stdout.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (to > lines.length) throw new Refused('NO_LINES', `${path} has ${lines.length} lines at ${commit}`);
  const last = Math.min(to, from + CODE_LINES - 1);
  return { path, commit: full, from, to: last, lines: lines.slice(from - 1, last), more: last < to };
}

/**
 * Serve the view until stopped.
 *
 * @param {{ port?: number, secret?: string }} [options]
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function serveView({ port = 0, secret = randomBytes(18).toString('base64url') } = {}) {
  const key = Buffer.from(secret);
  let bound = 0;
  // The API reads projectState and codeAt from this module. Load its factory after our exports
  // initialize, and use the real CLI entry point without adding a second move implementation.
  const { createLocalApiHandler } = await import('./api.js');
  const { main } = await import('./cli.js');
  const apiHandler = createLocalApiHandler({ secret, getPort: () => bound, runCommand: main });
  const reply = (res, code, type, body) => {
    res.writeHead(code, {
      'content-type': type,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(body);
  };
  const json = (res, code, value) => reply(res, code, 'application/json; charset=utf-8', JSON.stringify(value));
  const server = createServer(async (req, res) => {
    // A request line no URL parser accepts cannot carry the secret, so it gets the same 403, and it
    // must not be able to stop the server.
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${LOOPBACK}`);
    } catch {
      return json(res, 403, { error: 'this view needs its own address and secret: open the link pullboard view printed' });
    }
    if (url.pathname.startsWith('/api/')) return apiHandler(req, res);
    const given = Buffer.from(String(req.headers['x-pullboard-key'] ?? url.searchParams.get('k') ?? ''));
    const isOwnHost = req.headers.host === `${LOOPBACK}:${bound}` || req.headers.host === `localhost:${bound}`;
    if (!isOwnHost || given.length !== key.length || !timingSafeEqual(given, key)) return json(res, 403, { error: 'this view needs its own address and secret: open the link pullboard view printed' });
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/roadmap')) return reply(res, 200, 'text/html; charset=utf-8', cockpitPage(secret));
      if (req.method === 'GET' && url.pathname === '/view.css') return reply(res, 200, 'text/css; charset=utf-8', VIEW_CSS);
      return json(res, 404, { error: 'no such page' });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  });
  server.requestTimeout = 15_000;
  // Asked for any port, the view tries the one it last served from first, and takes any free one
  // when that is busy; a port the person names is used as named, and a busy one is refused with the
  // way out rather than a stack trace.
  const asked = port;
  const last = asked === 0 ? lastPort() : 0;
  return new Promise((ready, fail) => {
    const listen = (port) => {
      const failed = (error) => {
        if (error.code !== 'EADDRINUSE') return fail(error);
        if (port !== 0 && port === last) return listen(0);
        return fail(asked === 0 ? error : new Refused('PORT_BUSY', `port ${asked} is in use: name another with --port, or leave --port out to take any free one`));
      };
      server.once('error', failed);
      server.listen(port, LOOPBACK, () => {
        server.off('error', failed);
        bound = /** @type {any} */ (server.address()).port;
        if (asked === 0) rememberPort(bound);
        ready({
          url: `http://${LOOPBACK}:${bound}/?k=${secret}`,
          port: bound,
          close: () => new Promise((closed) => { apiHandler.close(); server.close(() => closed()); server.closeIdleConnections(); }),
        });
      });
    };
    listen(last || asked);
  });
}
