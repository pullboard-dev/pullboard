/**
 * `pullboard view` (N26, N27): the person's micro site. One page on this machine shows every
 * registered project: items by state, what needs the person, shouts, doctrine, agents and activity,
 * refreshing itself. Reads and actions use the shared local API v1 handler (A3); actions run the
 * real CLI in the project, so every rule and refusal applies exactly as at a terminal.
 *
 * By default it listens on loopback only; explicit LAN mode binds one assigned private IPv4 interface [H19].
 * It answers nothing without its own Host, and no board without the
 * session's secret, so another site in the browser cannot reach it. Besides its own page, it answers one other origin,
 * the hosted page at https://app.pullboard.dev, which gets the secret by a round trip that only ever returns there.
 * Idle reads open no outbound connection (P5); an explicit person sign-in reuses the existing relay linking flow.
 */
import { spawnSync } from 'node:child_process';
import {
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import * as store from './board.js';
import { cockpitPage } from './cockpit.js';
import { releaseHeadlinesBetween } from './changelog.js';
import { VERSION } from './help.js';
import { displayAgentName } from './agent-names.js';
import {
  COORDINATOR,
  loadConfig,
} from './config.js';
import {
  doctrineHistory,
  loadDoctrine,
  standardDoctrine,
} from './doctrine.js';
import {
  codeIsFromMain,
  repoInfo,
  resolveCommit,
} from './git.js';
import { committedIds } from './history.js';
import { productSummaries } from './products.js';
import {
  forgetProject,
  listApiProjects,
  registryFile,
} from './projects.js';
import { fetchLocal } from './local-fetch.js';
import { Refused } from './refused.js';
import { refusalDocument } from './json.js';
import { relayLinkAvailability } from './relay.js';
import { personNeeds } from './needs.js';
import { rigorDraftNeeds } from './rigor-notices.js';
import { sentinelDraftNeeds } from './sentinels.js';
import { sentinels } from './sentinels.js';
import { projectRowDecisions } from './row-decisions.js';
import { projectSpecRevisions } from './spec-revisions.js';
import { loadSpec } from './spec.js';
import { viewLanAddress } from './view/lan-address.js';

/** The page's styles (N26), read once: the page links them, so it needs no inline style. */
const VIEW_CSS = readFileSync(new URL('./view.css', import.meta.url), 'utf8');
export const LOOPBACK = '127.0.0.1';
/**
 * The hosted page's origin (N26, A2): the one origin besides the view's own page that may call the view, and the only
 * place the view's round trip ever sends its secret.
 */
export const HOSTED_ORIGIN = 'https://app.pullboard.dev';
/** The request headers the hosted page may send across origins: the secret, a JSON body's type, and a stream's cursor. */
const HOSTED_HEADERS = ['x-pullboard-key', 'content-type', 'last-event-id'];

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
 * Its API reads go through fetchApi, fetchLocal unless a caller passes another; a test passes one
 * that records each address and then reads through fetchLocal, so it sees the requests the export sends.
 *
 * @param {string} root
 * @param {string} directory
 * @param {{ fetchApi?: typeof fetchLocal }} [options]
 * @returns {Promise<{path: string}>}
 */
export async function exportView(root, directory, { fetchApi = fetchLocal } = {}) {
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
      let reply;
      try {
        reply = await fetchApi(address.origin + path, { headers: { 'x-pullboard-key': address.searchParams.get('k') } });
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw new Refused('VIEW_UNAVAILABLE', `could not read view at ${address.origin} while exporting; retry when the local view is available`);
      }
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
    // Ask for every item's thread, verdicts and criterion: the snapshot has no API to fetch them from later.
    state = await read(path + '/state?detail=full');
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
 * Open a project's board using running-source migration authority, or borrow a staged connection.
 *
 * @template T
 * @param {string} root
 * @param {(board: any, info: any, config: any) => T} read
 * @param {any | null} [providedBoard] Borrow a staged connection without closing it.
 * @returns {T}
 */
function withProject(root, read, providedBoard = null) {
  const info = repoInfo(root);
  const config = loadConfig(info.root);
  const board = providedBoard ?? store.openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'), undefined, { isMain: codeIsFromMain() });
  try {
    return read(board, info, config);
  } finally {
    if (!providedBoard) store.closeBoard(board);
  }
}

/**
 * How new each row of a spec or doctrine file is, by the commit that added it: 1 for a row the newest commit to touch
 * the file added, 2 for the commit before, and so on. A row on disk but not yet committed is missing here, and the
 * state counts it 0, newer than any. Walking a file's history is the slowest read behind a state, so each file's ages
 * are kept until HEAD moves, one entry a file.
 *
 * @param {string} root
 * @param {string} file
 * @param {string | null} head The one commit captured for this project's state.
 * @param {(root: string, file: string, revs: string[]) => { ids: Map<string, string> }} [history]
 * @returns {Map<string, number>}
 */
function rowAges(root, file, head, history = committedIds) {
  const key = root + '\0' + file, kept = agesKept.get(key);
  if (kept && kept.head === head) return kept.ages;
  const log = head ? spawnSync('git', ['log', '--follow', '--format=%H', head, '--', file], { cwd: root, encoding: 'utf8' }) : null;
  const place = new Map((log?.status === 0 ? log.stdout : '').split('\n').filter(Boolean).map((commit, n) => [commit, n + 1]));
  const ages = new Map([...(head ? history(root, file, [head]).ids : new Map())].map(([id, commit]) => [id, place.get(commit) ?? place.size + 1]));
  agesKept.set(key, { head, ages });
  return ages;
}
/** @type {Map<string, { head: string | null, ages: Map<string, number> }>} */
const agesKept = new Map();

let keptViewReleaseNotes;
/** Lazily read the immutable release note summary once for this view process. */
function viewReleaseNotes() {
  if (!keptViewReleaseNotes) {
    keptViewReleaseNotes = {
      version: VERSION,
      releases: releaseHeadlinesBetween('0.0.0', VERSION),
      notes: 'https://github.com/pullboard-dev/pullboard/blob/main/CHANGELOG.md',
    };
  }
  return { ...keptViewReleaseNotes, releases: keptViewReleaseNotes.releases.map((release) => ({ ...release })) };
}

/**
 * One verdict as the page shows it.
 *
 * @param {any} row A verdict row from store.verdictsFor.
 * @returns {{ decision: any, reason: any, note: any, by: any, at: any, commit: any }}
 */
function verdictOf(row) {
  return { decision: row.verdict_decision, reason: row.verdict_reason, note: row.verdict_note, by: row.verdict_by, at: row.verdict_at, commit: row.verdict_commit };
}

/**
 * One item as the page and the API show it (A2, N26): its fields, its verdicts, the items it waits on that are not yet
 * verified, and its full history. The API projects one item's detail with it, without building the whole state, so
 * the page and the API never word an item two ways. It only reads: it returns a fresh object and changes neither the
 * row nor the map.
 *
 * @param {any} board
 * @param {any} item The item's current row, as store.listItems reads it.
 * @param {Map<number, string>} status Every current item's status by its id.
 * @returns {any}
 */
export function projectItemState(board, item, status) {
  const verdicts = store.verdictsFor(board, item.item_id).map(verdictOf);
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
}

/**
 * Everything the page shows for one project. Given the newest shout the person has seen there,
 * it also counts every shout since, which the forty it sends cannot always show. An itemProjector
 * lets a caller that keeps its own item projections reuse them: it is called once per item, in
 * order, and returns that item's projection, calling project() for a fresh one only when it has none.
 *
 * @param {string} root
 * @param {{ seen?: number | null, board?: any, itemProjector?: ((item: any, context: { board: any, status: Map<number, string>, project: () => any }) => any) | null }} [options]
 *   A supplied board stays owned by its caller.
 * @returns {any}
 */
export function projectState(root, { seen = null, board: providedBoard = null, itemProjector = null } = {}) {
  return withProject(root, (board, info, config) => {
    const all = store.listItems(board, { all: true });
    const status = new Map(all.map((item) => [item.item_id, item.item_status]));
    // Both row lists and their cached ages name this commit even if HEAD moves between Git reads.
    const head = resolveCommit(info.root, 'HEAD');
    const rows = (file) => {
      const ages = rowAges(info.root, file, head);
      return loadSpec(info.root, { ...config, spec: file }).rows.map(({ id, status: state, tier, text, gate, serves, section }) => ({ id, status: state, tier, text, gate, serves, section, added: ages.get(id) ?? 0 }));
    };
    const doctrine = loadDoctrine(info.root, config);
    // A standard rule was never added to this repo, so it has no age here; the repo's own rows have.
    const doctrineAges = rowAges(info.root, doctrine.name, head, doctrineHistory);
    // A decline's text is its reason. Keep the inherited rule available so the page strikes the
    // rule itself, while showing the repo's reason beside it.
    const inherited = new Map(standardDoctrine().rows.map((row) => [row.id, row.text]));
    const log = store.recentEvents(board, 80);
    const lastMove = store.lastMoves(board);
    const state = projectRowDecisions(store.rowDecisions(board), {
      root: info.root,
      releaseNotes: viewReleaseNotes(),
      rowAgesAt: { [config.spec]: head, [doctrine.name]: head },
      lanes: [COORDINATOR, ...Object.keys(config.lanes)],
      // The lanes that own folders, where builders work; review lanes own none.
      owning: Object.keys(config.lanes).filter((lane) => (config.lanes[lane].owns ?? []).length > 0),
      // A caller with its own copy of an item returns it; project() builds the item only when asked.
      items: all.map((item) => (itemProjector
        ? itemProjector(item, { board, status, project: () => projectItemState(board, item, status) })
        : projectItemState(board, item, status))),
      shouts: store.recentShouts(board, 40),
      // Every ask still waiting for an answer, however far back the forty shouts reach (B21): the
      // person's to answer here, and the rest with who holds them (B26).
      decisions: store.openDecisions(board, store.PERSON),
      decisionQueue: store.openDecisions(board, COORDINATOR),
      asked: store.openDecisions(board).filter((ask) => ask.shout_to !== store.PERSON),
      events: log,
      agents: store.listAgents(board).map((agent) => ({ ...agent, model: agent.agent_model ?? 'unknown', displayName: displayAgentName(agent, config.agents.names), lastMoveAt: lastMove.get(agent.agent_id) ?? null })),
      holds: store.laneHolds(board),
      // Each item held on its own, with its reason, so every list can say why it is not moving (#1256).
      itemHolds: all.filter((item) => item.item_hold_reason).map((item) => ({ item: item.item_id, reason: item.item_hold_reason, by: item.item_hold_by, at: item.item_hold_at })),
      spec: rows(config.spec),
      practice: doctrine.rows.map(({ id, status: state, tier, text, gate, serves, section, origin, version, reason }) => ({
        id, status: state, tier, text, gate, serves, section, origin, version, reason,
        standardVersion: inherited.has(id) ? doctrine.version : null, overrides: origin === 'repo' && inherited.has(id), added: origin === 'standard' ? null : doctrineAges.get(id) ?? 0,
        ...(state === 'wont' && inherited.has(id) ? { standardText: inherited.get(id) } : {}),
      })),
      unseen: seen === null ? null : { since: seen, count: board.db.prepare('SELECT COUNT(*) AS n FROM shout WHERE shout_id > ?').get(seen).n },
      // Each product's progress, counted as pullboard status counts it (N28).
      products: productSummaries(config, loadSpec(info.root, config), all),
    });
    // Pending person decisions govern the calls on the API, sealed relay and exported page alike.
    const rigorRows = projectRowDecisions(store.rowDecisions(board), { root: info.root, spec: loadSpec(info.root, config).rows, practice: doctrine.rows });
    const projected = projectSpecRevisions({ ...state, rigorDrafts: rigorDraftNeeds(rigorRows, store.rowDrafts(board), store.rowDecisions(board)), sentinelDrafts: sentinelDraftNeeds(sentinels(board)) }, store.rowDrafts(board), store.rowDecisions(board));
    return { ...projected, needs: personNeeds(projected) };
  }, providedBoard);
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
 * True when the OS refused the view's listen as an agent sandbox does: EPERM, or EACCES on a port
 * anyone may open. EACCES on a port below 1024 is the ordinary privileged-port rule, so it stays as it is.
 */
function sandboxRefusedListen(error, port) {
  return error.code === 'EPERM' || (error.code === 'EACCES' && (port === 0 || port >= 1024));
}

/**
 * The step that lets a sandboxed view listen, for the agent tool this command runs under. Each
 * named step is one that tool documents; any other tool gets the general step and the terminal.
 */
function sandboxListenStep(env = process.env) {
  const terminal = 'or start pullboard view from a normal terminal';
  if (env.CLAUDECODE) return `allow local network for Claude Code: set sandbox.network.allowLocalBinding to true in .claude/settings.json, ${terminal}`;
  if (env.CODEX_SANDBOX !== undefined || env.CODEX_SANDBOX_NETWORK_DISABLED !== undefined) {
    return `allow local network for Codex in its sandbox settings in ~/.codex/config.toml, ${terminal}`;
  }
  return `allow local network in your agent tool's sandbox settings, ${terminal}`;
}

/**
 * Serve the view until stopped, optionally giving its API access to only one registered project.
 *
 * @param {{ port?: number, secret?: string, projectRoot?: string, lan?: boolean }} [options]
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function serveView({ port = 0, secret = randomBytes(18).toString('base64url'), projectRoot, lan = false } = {}) {
  const address = lan ? viewLanAddress() : LOOPBACK;
  const key = Buffer.from(secret);
  let bound = 0;
  // The API reads projectState and codeAt from this module. Load its factory after our exports
  // initialize, and use the real CLI entry point without adding a second move implementation.
  const { apiBoardListing, createLocalApiHandler } = await import('./api.js');
  const { main } = await import('./cli.js');
  const { startViewSignIn, viewSignInStatus, viewSignInPairingNavigation, cancelViewSignIn } = await import('./relay-setup.js');
  const signIns = new Set();
  const signInLifetime = new AbortController();
  const apiHandler = createLocalApiHandler({ secret, getPort: () => bound, runCommand: main, stateDetail: 'summary',
    allowedOrigins: lan ? [] : [HOSTED_ORIGIN], allowedHosts: lan ? [address] : [],
    ...(projectRoot === undefined ? {} : { scope: { projectRoot } }) });
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
  // A page that only sends the browser on, and only when it is the top page: framed, it never runs and never shows.
  const onward = (res, destination) => {
    res.setHeader('x-frame-options', 'DENY');
    return reply(res, 200, 'text/html; charset=utf-8', '<!doctype html><meta charset="utf-8"><title>Opening Pullboard</title><script>if (window.top === window.self) location.replace(' + JSON.stringify(destination).replace(/</g, '\\u003c') + ');</script>');
  };
  /** The invitation is a local read: it neither signs in nor opens a relay connection. */
  function sharingAvailable() {
    if (projectRoot !== undefined) return false;
    const projects = listApiProjects();
    return projects.length > 0 && projects.every(project => {
      const state = relayLinkAvailability(project.root);
      return !state.linked && !state.unlinking;
    });
  }

  /** Read one bounded JSON object; no arbitrary CLI words or relay address enter this route. */
  async function sharingBody(req) {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(String(req.headers['content-type'] ?? ''))) {
      throw new Refused('VIEW_SIGN_IN_JSON', 'send a JSON object to this view');
    }
    let length = 0;
    const chunks = [];
    for await (const chunk of req) {
      length += chunk.length;
      if (length <= 4096) chunks.push(chunk);
    }
    if (length > 4096) throw new Refused('VIEW_SIGN_IN_JSON', 'send only the sign-in action and its intent id');
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Refuse below. */ }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Refused('VIEW_SIGN_IN_JSON', 'send a JSON object to this view');
    return body;
  }

  /** Read the single explicit confirmation for the machine-local unreadable-project action. */
  async function forgetUnreadableBody(req) {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(String(req.headers['content-type'] ?? ''))) {
      throw new Refused('BAD_REQUEST', 'send the confirmation as a JSON object');
    }
    let length = 0;
    const chunks = [];
    for await (const chunk of req) {
      length += chunk.length;
      if (length <= 4096) chunks.push(chunk);
    }
    if (length > 4096) throw new Refused('BAD_REQUEST', 'send only the confirmation');
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Refuse below. */ }
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || body.confirm !== true || Object.keys(body).length !== 1) {
      throw new Refused('BAD_REQUEST', 'confirm forgetting the boards that are unreadable now');
    }
    return body;
  }

  /** Forget only roots that the same current registry snapshot cannot open as boards. */
  async function forgetUnreadableRequest(req, res, url) {
    const given = Buffer.from(String(req.headers['x-pullboard-key'] ?? ''));
    if (given.length !== key.length || !timingSafeEqual(given, key) || url.search || req.headers.authorization !== undefined) {
      return json(res, 403, refusalDocument(new Refused('VIEW_SIGN_IN_AUTH', 'open this view and send its session key in the x-pullboard-key header only')));
    }
    if (req.method !== 'POST') return json(res, 405, refusalDocument(new Refused('BAD_REQUEST', 'use a confirmed JSON POST to forget unreadable boards')));
    try {
      await forgetUnreadableBody(req);
      const registered = listApiProjects();
      const listing = apiBoardListing(() => registered);
      const unreadable = listing.warnings
        .filter((warning) => warning.error?.error?.code === 'BOARD_UNAVAILABLE');
      const forgotten = unreadable.filter((project) => forgetProject(project.root)).length;
      return json(res, 200, { version: 1, forgotten });
    } catch (error) {
      const refusal = error instanceof Refused ? error : new Refused('SERVICE_ERROR', 'the unreadable boards could not be forgotten; refresh this view and try again');
      return json(res, 400, refusalDocument(refusal));
    }
  }

  /** Run only the existing person-channel adapter, with per-view intent ownership and header authentication. */
  async function sharingRequest(req, res, url) {
    const given = Buffer.from(String(req.headers['x-pullboard-key'] ?? ''));
    if (given.length !== key.length || !timingSafeEqual(given, key) || url.search || req.headers.authorization !== undefined) {
      return json(res, 403, refusalDocument(new Refused('VIEW_SIGN_IN_AUTH', 'open the view link and send its session key in the x-pullboard-key header only')));
    }
    try {
      if (req.method === 'GET') return json(res, 200, { version: 1, available: sharingAvailable() });
      if (req.method !== 'POST') return json(res, 405, refusalDocument(new Refused('VIEW_SIGN_IN_METHOD', 'use GET for the invitation or a JSON POST for sign-in')));
      if (projectRoot !== undefined) throw new Refused('VIEW_SIGN_IN_SCOPE', 'open the full machine view to link every registered board');
      const body = await sharingBody(req);
      if (body.action === 'start' && Object.keys(body).length === 1) {
        const instructions = await startViewSignIn({ signal: signInLifetime.signal });
        signIns.add(instructions.intentId);
        return json(res, 200, { version: 1, ...instructions });
      }
      if (!['status', 'cancel', 'pairing'].includes(body.action) || Object.keys(body).some(name => !['action', 'intentId'].includes(name))
        || !signIns.has(body.intentId)) throw new Refused('VIEW_SIGN_IN_UNKNOWN', 'start sign-in in this view before reading or stopping it');
      if (body.action === 'pairing') {
        const destination = viewSignInPairingNavigation(body.intentId).url.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
        return reply(res, 200, 'text/html; charset=utf-8', '<!doctype html><meta charset="utf-8"><a href="' + destination + '">Continue device pairing</a>');
      }
      const status = body.action === 'cancel' ? await cancelViewSignIn(body.intentId) : viewSignInStatus(body.intentId);
      // Names and reasons are public progress; machine paths remain on this computer.
      const boards = status.boards.map(({ root, ...board }) => board);
      return json(res, 200, { version: 1, ...status, boards });
    } catch (error) {
      const refusal = error instanceof Refused ? error : new Refused('VIEW_SIGN_IN_FAILED', 'sign-in could not finish; check this view and try again');
      return json(res, 400, refusalDocument(refusal));
    }
  }

  const server = createServer(async (req, res) => {
    // A request line no URL parser accepts cannot carry the secret, so it gets the same 403, and it
    // must not be able to stop the server.
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${LOOPBACK}`);
    } catch {
      return json(res, 403, { error: 'this view needs its own address and secret: open the link pullboard view printed' });
    }
    // Only the view's own address reaches it: a site that points a name of its own at 127.0.0.1 sends that name. The
    // API refuses another Host in its own words.
    const isOwnHost = req.headers.host === `${address}:${bound}` || !lan && req.headers.host === `localhost:${bound}`;
    if (!isOwnHost) {
      if (url.pathname.startsWith('/api/') && url.pathname !== '/api/v1/view-link' && req.method !== 'OPTIONS') return apiHandler(req, res);
      return json(res, 403, { error: lan ? 'this view answers only at its own LAN address and port: open the private link pullboard view --lan printed'
        : 'this view answers only at 127.0.0.1 or localhost on its own port: open the link pullboard view printed' });
    }
    // A browser names the page a request comes from; the view answers its own page and the hosted one, nothing else.
    const origin = req.headers.origin;
    const hosted = !lan && origin === HOSTED_ORIGIN;
    if (origin !== undefined && !hosted && origin !== `http://${address}:${bound}` && (lan || origin !== `http://localhost:${bound}`)) {
      return json(res, 403, { error: lan ? 'this LAN view answers its own page only'
        : 'this view answers its own page and https://app.pullboard.dev only' });
    }
    res.setHeader('vary', 'Origin');
    if (hosted) {
      res.setHeader('access-control-allow-origin', HOSTED_ORIGIN);
      res.setHeader('access-control-expose-headers', 'x-pullboard-report-validator');
    }
    if (req.method === 'OPTIONS') {
      const asked = String(req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map((name) => name.trim()).filter(Boolean);
      const route = url.pathname.startsWith('/api/') || url.pathname === '/local/protocol';
      if (!hosted || !route || !['GET', 'POST'].includes(req.headers['access-control-request-method']) || asked.some((name) => !HOSTED_HEADERS.includes(name))) {
        return json(res, 403, { error: 'from https://app.pullboard.dev, ask for a GET or a JSON POST to /api/, sending only x-pullboard-key, content-type and last-event-id' });
      }
      res.setHeader('access-control-allow-methods', 'GET, POST');
      res.setHeader('access-control-allow-headers', HOSTED_HEADERS.join(', '));
      res.setHeader('access-control-allow-private-network', 'true');
      res.setHeader('access-control-max-age', '600');
      return reply(res, 204, 'text/plain; charset=utf-8', '');
    }
    // The round trip (N26): any page may send the browser here, and the secret goes back to the hosted page only, in
    // the address's fragment, which no request carries. /local/view opens this view itself, as its printed link does.
    // Each is a page of its own: a script's read or a frame gets nothing.
    if (lan && (url.pathname === '/local/connect' || url.pathname === '/local/view')) {
      return json(res, 403, { error: 'open the private LAN link printed by pullboard view --lan' });
    }
    if (req.method === 'GET' && (url.pathname === '/local/connect' || url.pathname === '/local/view')) {
      const destination = req.headers['sec-fetch-dest'];
      if (origin !== undefined || (destination !== undefined && destination !== 'document')) return json(res, 403, { error: 'open this address as a page of its own, never from a script or inside a frame' });
      if (url.pathname === '/local/view') return onward(res, `http://${LOOPBACK}:${bound}/?k=${secret}`);
      return onward(res, HOSTED_ORIGIN + '/#' + new URLSearchParams({ 'pullboard-local': JSON.stringify({ version: 1, origin: `http://${LOOPBACK}:${bound}`, key: secret }) }));
    }
    // What the hosted page needs to know this view can take it: no secret, and no board data.
    if (req.method === 'GET' && url.pathname === '/local/protocol') return json(res, 200, { version: 1, apiVersion: 1, hostedOrigin: HOSTED_ORIGIN, connect: '/local/connect', view: '/local/view' });
    if (url.pathname.startsWith('/api/')) {
      // The hosted page sends the secret in its header only, never in an address a history or a log could keep.
      if (hosted && (url.searchParams.has('k') || req.headers.authorization !== undefined || req.headers['x-pullboard-key'] === undefined)) {
        return json(res, 403, { error: 'from https://app.pullboard.dev, send the session secret in the x-pullboard-key header only' });
      }
      if (url.pathname === '/api/v1/view-link') return sharingRequest(req, res, url);
      if (projectRoot === undefined && url.pathname === '/api/v1/projects/forget-unreadable') return forgetUnreadableRequest(req, res, url);
      return apiHandler(req, res);
    }
    const given = Buffer.from(String(req.headers['x-pullboard-key'] ?? url.searchParams.get('k') ?? ''));
    if (given.length !== key.length || !timingSafeEqual(given, key)) {
      const destination = req.headers['sec-fetch-dest'];
      const browserPage = req.method === 'GET' && url.pathname === '/' && !url.searchParams.has('k') && req.headers['x-pullboard-key'] === undefined
        && /(?:^|,)\s*text\/html(?:\s*;|\s*,|\s*$)/iu.test(String(req.headers.accept ?? ''))
        && (destination === undefined || destination === 'document');
      if (browserPage) return reply(res, 401, 'text/html; charset=utf-8', '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Open your board</title><h1>Open your board</h1><p>The board opens at <a href="' + HOSTED_ORIGIN + '">app.pullboard.dev</a>.</p></html>');
      return json(res, 403, { error: 'this view needs its own address and secret: open the link pullboard view printed' });
    }
    try {
      // The board, and the Roadmap at its own address (N38), are the one page.
      if (req.method === 'GET' && (url.pathname === '/' || /^\/(?:[^/]+\/)?(?:home|items|shouts|spec|doctrine|activity|roadmap|settings)(?:\/[^/]+)?$/.test(url.pathname))) return reply(res, 200, 'text/html; charset=utf-8', cockpitPage(secret, { paths: true }));
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
  const last = asked === 0 && !lan ? lastPort() : 0;
  return new Promise((ready, fail) => {
    const listen = (port) => {
      const failed = (error) => {
        if (sandboxRefusedListen(error, port)) {
          return fail(new Refused('SANDBOX_BLOCKED', `the sandbox around this command refused to let pullboard view listen on ${port ? `${address}:${port}` : address} (${error.code})\nnext: ${sandboxListenStep()}`));
        }
        if (error.code !== 'EADDRINUSE') return fail(error);
        if (port !== 0 && port === last) return listen(0);
        return fail(asked === 0 ? error : new Refused('PORT_BUSY', `port ${asked} is in use: name another with --port, or leave --port out to take any free one`));
      };
      server.once('error', failed);
      server.listen(port, address, () => {
        server.off('error', failed);
        bound = /** @type {any} */ (server.address()).port;
        if (asked === 0 && projectRoot === undefined && !lan) rememberPort(bound);
        ready({
          url: `http://${address}:${bound}/?k=${secret}`,
          port: bound,
          ...(lan ? { lan: true } : {}),
          close: async () => {
            signInLifetime.abort();
            await Promise.all([...signIns].map(async intentId => {
              // An in-flight linking batch cannot be rolled back. Wait until core can cleanly stop its pairing stage.
              try {
                while (viewSignInStatus(intentId).state === 'linking') await new Promise(done => setTimeout(done, 100));
                await cancelViewSignIn(intentId);
              } catch (error) { if (!(error instanceof Refused) || error.code !== 'VIEW_SIGN_IN_UNKNOWN') throw error; }
            }));
            await new Promise((closed) => { apiHandler.close(); server.close(() => closed()); server.closeIdleConnections(); });
          },
        });
      });
    };
    listen(last || asked);
  });
}
