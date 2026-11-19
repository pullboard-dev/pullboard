import { activeViewAgents } from "../logic/summary/state.js";
import { viewProofSummary } from "../logic/summary/state.js";
import { compactItemSummaries } from "../logic/summary/state.js";
import { viewFlowSummary } from "../logic/summary/state.js";
import { projectSummary } from "../logic/summary/project.js";
import { modelPresentation } from "./cost/tab.js";
import { noLinkPage } from "./no-link.js";
import { viewSessionCookie } from "./serve-session.js";
import { NO_LINK_CSS } from "./no-link.js";
import { NO_LINK_STYLESHEET } from "./no-link.js";
import { performanceCores } from "../../../../packages/gate/index.js";
import { milestoneForecast } from "../../../../packages/roadmap/index.js";
import { machineRead } from "./pipeline/machine.js";
/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/stage.css apps/view/src/io/dashboard.css apps/view/src/io/cost.css apps/view/src/io/doctrine.css apps/view/src/io/item/panel.css apps/view/src/io/item/rows.css */
/**
 * `pullboard view` (N26, N27): the person's micro site. One page on this machine shows every
 * registered project: items by state, what needs the person, shouts, doctrine, agents and activity,
 * refreshing itself. Reads and actions use the shared local API v1 handler (A3); actions run the
 * real CLI in the project, so every rule and refusal applies exactly as at a terminal.
 *
 * By default it listens on loopback only; explicit LAN mode binds one assigned private IPv4 interface [H19].
 * It answers nothing without its own Host, and no board without the session's secret or its HttpOnly session cookie,
 * so another site in the browser cannot reach it. Besides its own page, it answers one other origin,
 * the hosted page at https://app.pullboard.dev, which gets the secret by a round trip that only ever returns there.
 * Idle reads open no outbound connection (P5); an explicit person sign-in reuses the existing relay linking flow.
 */
import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { viewMachineName } from './projects-machine-name.js';
import { brotliCompressSync } from 'node:zlib';
import { gzipSync } from 'node:zlib';
import { constants as zlibConstants } from 'node:zlib';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import * as store from "../../../../packages/store/index.js";
import { DEFAULT_VIEW_PORT } from '../../../../packages/config/index.js';
import { defaultViewPort } from '../../../../packages/config/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { repoInfo } from '../../../../packages/git/index.js';
import {
  forgetProject,
  listApiProjects,
  registryFile,
} from "../../../../packages/seats/index.js";
import { fetchLocal } from "../../../../packages/sync/index.js";
import { Refused } from "../../../../packages/kernel/index.js";
import { relayLinkAvailability } from "../../../../packages/link/index.js";
import { relayMachineContext } from "../../../../packages/link/index.js";
import { sentinels } from "../../../../packages/sentinels/index.js";
import { viewLanAddress } from "./address.js";
import { publicSnapshot } from "../logic/public.js";
import { openBoardForRead } from "../../../../packages/store/index.js";
import { loadMachineSettings } from "../../../../packages/config/index.js";
import { machineSettingsFile } from "../../../../packages/config/index.js";
import { composeViewStyles } from "./styles.js";
import { machineResourcesFile } from './state.js';
import { projectState } from './state.js';
export { projectState, publicLiveSnapshot, runsJobs, FINISHED_JOBS_SQL, finishedRuns } from './state.js';

/** Shared Dashboard rules retain their cascade point before private-local styles are assembled. */
const SHARED_VIEW_CSS = composeViewStyles();
const PRIVATE_COST_CSS = readFileSync(new URL("./cost.css", import.meta.url), 'utf8');
const SHARED_DOCTRINE_CSS = readFileSync(new URL("./doctrine.css", import.meta.url), 'utf8');
const SHARED_ITEM_PANEL_CSS = readFileSync(new URL("./item/panel.css", import.meta.url), 'utf8');
const PRIVATE_VIEW_CSS_MARKER = '/* @private-view-css src/view/cost.css */';
const SHARED_DOCTRINE_CSS_MARKER = '/* @shared-view-css src/view/doctrine.css */';
const SHARED_ITEM_PANEL_CSS_MARKER = '/* @shared-view-css src/view/item-panel.css */';
const VIEW_CSS = SHARED_VIEW_CSS.replace(SHARED_DOCTRINE_CSS_MARKER, SHARED_DOCTRINE_CSS).replace(SHARED_ITEM_PANEL_CSS_MARKER, SHARED_ITEM_PANEL_CSS).replace(PRIVATE_VIEW_CSS_MARKER, PRIVATE_COST_CSS);
const SNAPSHOT_VIEW_CSS = SHARED_VIEW_CSS.replace(SHARED_DOCTRINE_CSS_MARKER, SHARED_DOCTRINE_CSS).replace(SHARED_ITEM_PANEL_CSS_MARKER, SHARED_ITEM_PANEL_CSS).replace(PRIVATE_VIEW_CSS_MARKER, '');
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

/** Refuse missing higher-level services before opening a transport or writing an export [N26]. */
function requireViewServices({ runCommand, renderPage, refusalDocument, boardOpeners }) {
  for (const [name, operation] of Object.entries({ runCommand, renderPage, refusalDocument, openBoard: boardOpeners?.openBoard, openBoardForRead: boardOpeners?.openBoardForRead })) {
    if (typeof operation !== 'function') throw new Refused('VIEW_SERVICE_REQUIRED', `the view needs its caller to provide ${name}; use the CLI view composition or pass the actual service`);
  }
}

/**
 * The most events one export read asks for. A large board's log (hundreds of thousands of events) is read, made
 * portable and written in pages of this size, so the export never holds the whole log at once and finishes under
 * Node's default heap.
 */
export const EXPORT_EVENT_BATCH = 5000;
/** How many item details one export reads at a time while it writes each item in full. */
const EXPORT_ITEM_READS = 16;

/**
 * Export one board through the same API v1 used by the live page, closing its temporary local
 * transport before returning. The static page needs neither that transport nor its session key.
 * Its API reads go through fetchApi, fetchLocal unless a caller passes another; a test passes one
 * that records each address and then reads through fetchLocal, so it sees the requests the export sends.
 * Nothing is read whole: the state comes as item summaries, and each item's detail (thread, history, verdicts,
 * criterion) is read from its own path and written into state.json in full, a few items at a time; events are
 * read in pages of at most eventBatch, each written to events.json before the next is read. On a big board the
 * one-document full state or event log is larger than a string Node can build (#6587).
 * A refused or failed export leaves no partial snapshot behind.
 *
 * @param {string} root
 * @param {string} directory
 * @returns {Promise<{path: string}>}
 */
export async function exportView(root, directory, { fetchApi = fetchLocal, public: publicMode = false, eventBatch = EXPORT_EVENT_BATCH, source, runCommand, renderPage, refusalDocument, boardOpeners } = {}) {
  // source: an optional stand-in board reader, (path) => document; it replaces the local API so a test drives the export alone.
  if (source) { if (typeof renderPage !== 'function') throw new Refused('VIEW_SERVICE_REQUIRED', 'the view needs its caller to provide renderPage'); } else requireViewServices({ runCommand, renderPage, refusalDocument, boardOpeners });
  if (!Number.isSafeInteger(eventBatch) || eventBatch < 1) throw new TypeError('exportView needs eventBatch as a positive integer');
  const output = resolve(directory);
  const existed = existsSync(output);
  if (existed && (!statSync(output).isDirectory() || readdirSync(output).length)) {
    throw new Refused('EXPORT_EXISTS', `snapshot folder ${output} is not empty; use an empty folder`);
  }
  const info = source ? { root: resolve(root), commonDir: '' } : repoInfo(root);
  const config = source ? {} : loadConfig(info.root);
  const registered = source ? null : listApiProjects().find((entry) => {
    try { return repoInfo(entry.root).commonDir === info.commonDir; } catch { return false; }
  }) ?? { root: info.root, name: config.name || basename(info.root), project: config.project || '', added: new Date().toISOString() };
  let privateBoard = false;
  if (publicMode && !source) {
    const board = openBoardForRead(join(info.commonDir, 'pullboard', 'board.sqlite'));
    if (!board) throw new Refused('NO_BOARD', 'no readable board to export; run pullboard init in this repo');
    try { privateBoard = Boolean(board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key = ?').get('private_repo_board_id')); } finally { store.closeBoard(board); }
  }
  const { serveApi } = source ? {} : await import("../../../../packages/api/index.js");
  const api = source ? { url: 'http://stand-in.invalid/?k=stand-in', close: async () => {} } : await serveApi({ viewPorts: { projectState, activeViewAgents, viewProofSummary, compactItemSummaries, viewFlowSummary, projectSummary }, port: 0, projects: () => [registered], runCommand, refusalDocument, boardOpeners });
  let wrote = false;
  try {
    const address = new URL(api.url);
    /** Read an authenticated API document without putting its private key in the snapshot. */
    const read = async (path) => {
      if (source) return source(path);
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
    let listing = await read('/api/v1/boards');
    const board = listing.boards[0];
    if (!board) {
      const version = listing.warnings?.map((warning) => warning.error?.error).find((error) => error?.code === 'EVENT_LOG_VERSION');
      if (version) throw new Refused(version.code, version.message);
      throw new Refused('NO_BOARD', 'no readable board to export; run pullboard init in this repo');
    }
    const path = '/api/v1/boards/' + encodeURIComponent(board.id);
    // The summary state, with every item's thread, verdicts and criterion added below: the snapshot has no API to fetch them from later.
    let state = await read(path + '/state?detail=summary');
    const last = state.state.events[0]?.event_id ?? 0;
    const summaries = state.state.items;
    // Items are written one by one where this marker sits in the rest of the state's text.
    const marker = '\u0000items-' + randomBytes(8).toString('hex');
    listing = portableSnapshot(listing, info.root);
    state = portableSnapshot({ ...state, state: { ...state.state, items: [] } }, info.root);
    // Public checks are per location, so the state, each item and each page of events are checked on their own; any block refuses the whole export.
    if (publicMode) ({ listing, state } = publicSnapshot({ listing, state }, { privateBoard }));
    const boardPath = join(output, 'api', 'v1', 'boards', listing.boards[0].id);
    mkdirSync(boardPath, { recursive: true });
    wrote = true;
    const [stateHead, stateTail] = JSON.stringify({ ...state, state: { ...state.state, items: marker } }).split(JSON.stringify(marker));
    const stateFile = openSync(join(boardPath, 'state.json'), 'w');
    try {
      writeSync(stateFile, stateHead + '[');
      for (let at = 0; at < summaries.length; at += EXPORT_ITEM_READS) {
        const part = summaries.slice(at, at + EXPORT_ITEM_READS);
        const details = await Promise.all(part.map((summary) => read(`${path}/items/${encodeURIComponent(String(summary.id))}`)));
        let items = part.map((summary, index) => portableSnapshot({ ...summary, ...details[index].item }, info.root));
        if (publicMode) items = publicSnapshot({ state: { state: { items } } }, { privateBoard }).state.state.items;
        writeSync(stateFile, (at ? ',' : '') + items.map((item) => JSON.stringify(item)).join(','));
      }
      writeSync(stateFile, ']' + stateTail + '\n');
    } finally { closeSync(stateFile); }
    const file = openSync(join(boardPath, 'events.json'), 'w');
    try {
      let after = 0;
      let eventsTail = null;
      let written = 0;
      let more = true;
      while (more) {
        const page = await read(`${path}/events?after=${after}&limit=${eventBatch}`);
        const records = page.events;
        if (eventsTail === null) {
          // The first page's other fields (version, warnings) frame the whole log, in the order the API sent them.
          let envelope = portableSnapshot({ ...page, events: [] }, info.root);
          if (publicMode) envelope = publicSnapshot({ events: envelope }, { privateBoard }).events;
          const [eventsHead, tail] = JSON.stringify({ ...envelope, events: marker }).split(JSON.stringify(marker));
          writeSync(file, eventsHead + '[');
          eventsTail = tail;
        }
        let kept = portableSnapshot(records.filter((event) => event.event_id <= last), info.root);
        if (publicMode) kept = publicSnapshot({ events: { events: kept } }, { privateBoard }).events.events;
        if (kept.length) writeSync(file, (written ? ',' : '') + kept.map((event) => JSON.stringify(event)).join(','));
        written += kept.length;
        // A short page is the log's end; events past the exported state are not part of this snapshot.
        more = records.length === eventBatch && records.at(-1).event_id < last;
        if (more) after = records.at(-1).event_id;
      }
      writeSync(file, ']' + eventsTail + '\n');
    } finally { closeSync(file); }
    writeFileSync(join(output, 'index.html'), renderPage('', { snapshot: true }));
    writeFileSync(join(output, 'view.css'), SNAPSHOT_VIEW_CSS);
    writeFileSync(join(output, 'api', 'v1', 'boards.json'), JSON.stringify(listing) + '\n');
  } catch (error) {
    // Never leave a partial snapshot that could be published: remove what this export wrote.
    if (wrote) {
      if (existed) for (const name of readdirSync(output)) rmSync(join(output, name), { recursive: true, force: true });
      else rmSync(output, { recursive: true, force: true });
    }
    throw error;
  } finally {
    await api.close();
  }
  return { path: output };
}

/** The CLI may offer --public only when this implementation checks every retained export value. */
exportView.supportsPublicExport = true;

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
 * The running view's project state: row ages come from what the view already has, refreshed off the request
 * path, so a state read never walks Git history while the person waits for the board.
 *
 * @param {string} root
 * @param {object} [options]
 * @returns {any}
 */
export function liveProjectState(root, options = {}) {
  return projectState(root, { ...options, rowAgesLater: true });
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
 * The one value a request's Cookie header gives the named cookie, or null when it gives none, names
 * it without a value, or gives it twice: another server on this host can set a cookie of the same
 * name, so a second copy makes both untrustworthy. It reads the view's cookie exactly as the local
 * API does (src/api.js), so the page and its API never disagree about who holds the session.
 *
 * @param {unknown} header
 * @param {string} name
 * @returns {string | null}
 */
function requestCookie(header, name) {
  if (typeof header !== 'string') return null;
  let found = null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) {
      if (part.trim() === name) return null;
      continue;
    }
    if (part.slice(0, separator).trim() !== name) continue;
    if (found !== null) return null;
    found = part.slice(separator + 1).trim();
  }
  return found;
}

/**
 * Whether a credential a request offers is the expected one, compared in constant time.
 *
 * @param {Buffer} given
 * @param {Buffer} expected
 * @returns {boolean}
 */
const credentialMatches = (given, expected) => given.length === expected.length && timingSafeEqual(given, expected);

/**
 * Serve the view until stopped, optionally giving its API access to only one registered project. With `statePorts`,
 * the URL of a module exporting boardStatePorts(), a worker keeps each board's state built and a read only serves it.
 *
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function serveView({ port = 0, secret = randomBytes(18).toString('base64url'), projectRoot, runCommand, renderPage, refusalDocument, boardOpeners, lan = false, statePorts, machineName = viewMachineName, projects } = {}) {
  requireViewServices({ runCommand, renderPage, refusalDocument, boardOpeners });
  const address = lan ? viewLanAddress() : LOOPBACK;
  const key = Buffer.from(secret);
  // Both derive from the secret, so a view restarted with the same secret accepts the cookie the first one set.
  const { name: cookieName, value: session } = viewSessionCookie(secret);
  const sessionKey = Buffer.from(session);
  /** Match this view's session cookie only in same-origin requests or a typed top-level page visit. */
  const cookieMatches = (req) => {
    if (!credentialMatches(Buffer.from(requestCookie(req.headers.cookie, cookieName) ?? ''), sessionKey)) return false;
    const site = req.headers['sec-fetch-site'];
    return site === undefined || site === 'same-origin'
      || (site === 'none' && req.method === 'GET' && req.headers.origin === undefined && req.headers['sec-fetch-dest'] === 'document');
  };
  let bound = 0;
  // Load the API transport factory when the view starts, after the shared projection exports
  // initialize, and use the real CLI entry point without adding a second move implementation.
  const { apiBoardListing, createLocalApiHandler } = await import("../../../../packages/api/index.js");
  const { startViewSignIn, viewSignInStatus, viewSignInPairingNavigation, cancelViewSignIn } = await import("../../../../packages/link/index.js");
  const signIns = new Set();
  const signInLifetime = new AbortController();
  const apiHandler = createLocalApiHandler({ viewPorts: { projectState: liveProjectState, activeViewAgents, viewProofSummary, compactItemSummaries, viewFlowSummary, projectSummary, machineName }, ...(projects === undefined ? {} : { projects }), statePorts, secret, getPort: () => bound, runCommand, stateDetail: 'summary', refusalDocument, costModelPresentation: modelPresentation, boardOpeners, settingsProviders: { performanceCores, defaultViewPort, DEFAULT_VIEW_PORT },
    allowedOrigins: lan ? [] : [HOSTED_ORIGIN], allowedHosts: lan ? [address] : [],
    sessionCookie: { name: cookieName, value: session }, ...(projectRoot === undefined ? {} : { scope: { projectRoot } }) });
  const reply = (res, code, type, body, headers = {}) => {
    res.writeHead(code, {
      'content-type': type,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      ...headers,
    });
    res.end(body);
  };
  /** Compressed bytes by encoding and content hash, so a page or stylesheet is compressed once per build, not once per load. */
  const compressed = new Map();
  /**
   * Answer a page or stylesheet compressed (brotli, else gzip, when the request accepts it) with a content-hash ETag, and 304
   * when the request's If-None-Match names those bytes. It stays revalidated (no-cache) rather than cached for a time, so a
   * reload after an upgrade can never show the old build, and costs a 304 with no body when nothing changed.
   */
  const asset = (req, res, type, text) => {
    const accepted = String(req.headers['accept-encoding'] ?? '');
    const encoding = /(?:^|[\s,])br\s*(?:;\s*q=(?!0(?:\.0*)?\s*(?:,|$))[\d.]+)?\s*(?:,|$)/iu.test(accepted) ? 'br'
      : /(?:^|[\s,])gzip\s*(?:;\s*q=(?!0(?:\.0*)?\s*(?:,|$))[\d.]+)?\s*(?:,|$)/iu.test(accepted) ? 'gzip' : '';
    const hash = createHash('sha256').update(text).digest('base64url').slice(0, 22);
    const etag = `"${hash}${encoding ? '-' + encoding : ''}"`;
    const headers = { 'cache-control': 'no-cache', etag, vary: 'accept-encoding' };
    if (String(req.headers['if-none-match'] ?? '').split(',').some(tag => tag.trim().replace(/^W\//u, '') === etag)) return reply(res, 304, type, '', headers);
    if (!encoding) return reply(res, 200, type, text, headers);
    const key = etag;
    if (!compressed.has(key)) {
      if (compressed.size > 16) compressed.clear();
      const raw = Buffer.from(text);
      compressed.set(key, encoding === 'br'
        ? brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
        : gzipSync(raw, { level: 9 }));
    }
    return reply(res, 200, type, compressed.get(key), { ...headers, 'content-encoding': encoding });
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

  /** Read explicit confirmation and an optional opaque selector; never accept filesystem paths. */
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
      || body.confirm !== true || Object.keys(body).length !== (body.board === undefined ? 1 : 2)
      || (body.board !== undefined && (typeof body.board !== 'string' || !/^[a-f0-9]{64}$/u.test(body.board)))) {
      throw new Refused('BAD_REQUEST', 'confirm forgetting the boards that are unreadable now');
    }
    return body;
  }

  /** Forget only roots that the same current registry snapshot cannot open as boards. */
  async function forgetUnreadableRequest(req, res, url) {
    const given = Buffer.from(String(req.headers['x-pullboard-key'] ?? ''));
    if ((!credentialMatches(given, key) && !cookieMatches(req)) || url.search || req.headers.authorization !== undefined) {
      return json(res, 403, refusalDocument(new Refused('VIEW_SIGN_IN_AUTH', 'open this view and send its session key in the x-pullboard-key header only')));
    }
    if (req.method !== 'POST') return json(res, 405, refusalDocument(new Refused('BAD_REQUEST', 'use a confirmed JSON POST to forget unreadable boards')));
    try {
      const body = await forgetUnreadableBody(req);
      const registered = listApiProjects();
      const selected = body.board === undefined ? null : registered.find(project => createHash('sha256').update(project.root).digest('hex') === body.board);
      if (body.board !== undefined && !selected) throw new Refused('BAD_REQUEST', 'choose a board from this view and refresh before trying again');
      const listing = apiBoardListing(() => registered, undefined, refusalDocument, boardOpeners);
      const unreadable = listing.warnings
        .filter((warning) => warning.error?.error?.code === 'BOARD_UNAVAILABLE' && (!selected || warning.root === selected.root));
      const forgotten = unreadable.filter((project) => forgetProject(project.root)).length;
      return json(res, 200, { version: 1, forgotten });
    } catch (error) {
      const refusal = error instanceof Refused ? error : new Refused('SERVICE_ERROR', 'the unreadable boards could not be forgotten; refresh this view and try again');
      return json(res, 400, refusalDocument(refusal));
    }
  }

  /** This machine's CPU by part, gate workers, queues and runner slots for the Pipeline page, behind the same key as the rest of the API. */
  async function machineRequest(req, res, url) {
    const given = Buffer.from(String(req.headers['x-pullboard-key'] ?? ''));
    if ((!credentialMatches(given, key) && !cookieMatches(req)) || url.search || req.headers.authorization !== undefined) {
      return json(res, 403, refusalDocument(new Refused('VIEW_SIGN_IN_AUTH', 'open this view and send its session key in the x-pullboard-key header only')));
    }
    if (req.method !== 'GET') return json(res, 405, refusalDocument(new Refused('BAD_REQUEST', 'read this machine with a GET')));
    const home = dirname(machineSettingsFile());
    try {
      return json(res, 200, { version: 1, machine: await machineRead({ resourcesFile: machineResourcesFile(), queueDirectory: join(home, 'handoff-queue'), repoRoot: home }) });
    } catch {
      return json(res, 200, { version: 1, machine: null });
    }
  }

  /** Run only the existing person-channel adapter, with per-view intent ownership and header authentication. */
  async function sharingRequest(req, res, url) {
    const given = Buffer.from(String(req.headers['x-pullboard-key'] ?? ''));
    if ((!credentialMatches(given, key) && !cookieMatches(req)) || url.search || req.headers.authorization !== undefined) {
      return json(res, 403, refusalDocument(new Refused('VIEW_SIGN_IN_AUTH', 'open the view link and send its session key in the x-pullboard-key header only')));
    }
    try {
      if (req.method === 'GET') {
        // Whether any board is linked, and as whom: the account control's initial and menu. The login is display text only.
        const linked = listApiProjects().filter(project => relayLinkAvailability(project.root).linked);
        const login = linked.map(project => relayMachineContext(project.root)?.login).find(name => typeof name === 'string' && name) || '';
        return json(res, 200, { version: 1, available: sharingAvailable(), linked: linked.length > 0, login });
      }
      if (req.method !== 'POST') return json(res, 405, refusalDocument(new Refused('VIEW_SIGN_IN_METHOD', 'use GET for the invitation or a JSON POST for sign-in')));
      if (projectRoot !== undefined) throw new Refused('VIEW_SIGN_IN_SCOPE', 'open the full machine view to link every registered board');
      const body = await sharingBody(req);
      if (body.action === 'start' && Object.keys(body).length === 1) {
        const instructions = await startViewSignIn({ signal: signInLifetime.signal, relayPorts: boardOpeners });
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
      if (url.pathname === '/api/v1/machine') return machineRequest(req, res, url);
      if (projectRoot === undefined && url.pathname === '/api/v1/projects/forget-unreadable') return forgetUnreadableRequest(req, res, url);
      return apiHandler(req, res);
    }
    if (hosted) return json(res, 403, { error: 'open the printed view link for local pages; the hosted page uses the API' });
    // The no-link page's stylesheet: the view's tokens and that page's rules only, so it opens before the link does.
    if (req.method === 'GET' && url.pathname === NO_LINK_STYLESHEET) return reply(res, 200, 'text/css; charset=utf-8', NO_LINK_CSS);
    const given = Buffer.from(String(req.headers['x-pullboard-key'] ?? url.searchParams.get('k') ?? ''));
    const validKey = credentialMatches(given, key);
    if (!validKey && !cookieMatches(req)) {
      const destination = req.headers['sec-fetch-dest'];
      const browserPage = req.method === 'GET' && url.pathname === '/' && !url.searchParams.has('k') && req.headers['x-pullboard-key'] === undefined
        && /(?:^|,)\s*text\/html(?:\s*;|\s*,|\s*$)/iu.test(String(req.headers.accept ?? ''))
        && (destination === undefined || destination === 'document');
      if (browserPage) return reply(res, 401, 'text/html; charset=utf-8', noLinkPage(HOSTED_ORIGIN, { remoteAddress: req.socket.remoteAddress, host: req.headers.host }));
      return json(res, 403, { error: 'this view needs its own address and secret: open the link pullboard view printed' });
    }
    if (req.method === 'GET' && url.searchParams.has('k')) {
      url.searchParams.delete('k');
      // A relative address keeps the browser on whatever origin it opened, so a page reached through a proxy stays
      // behind it; collapsing leading slashes keeps "//elsewhere" from reading as another host.
      return reply(res, 303, 'text/plain; charset=utf-8', '', {
        location: `/${url.pathname.replace(/^[/\\]+/u, '')}${url.search}`,
        ...(validKey ? { 'set-cookie': `${cookieName}=${session}; Path=/; HttpOnly; SameSite=Strict` } : {}),
      });
    }
    try {
      // The board, and the Roadmap at its own address (N38), are the one page.
      if (req.method === 'GET' && (url.pathname === '/' || /^\/(?:[^/]+\/)?(?:progress|dashboard|home|items|shouts|spec|doctrine|activity|pipeline|roadmap|cost|settings)(?:\/[^/]+)?$/.test(url.pathname))) return asset(req, res, 'text/html; charset=utf-8', renderPage('', { paths: true, apiHeaders: {}, stylesheet: '/view.css', costPrices: loadMachineSettings().costPrices ?? null, milestoneDelta: loadMachineSettings().state?.milestoneDelta === true ? { forecast: milestoneForecast } : null }));
      if (req.method === 'GET' && url.pathname === '/view.css') return asset(req, res, 'text/css; charset=utf-8', VIEW_CSS);
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
  return new Promise((ready, resolveFail) => {
    /** Refuse the start and stop the state materializer's worker first: a thread left running keeps a foreground process alive after its refusal. */
    const fail = (error) => {
      try { apiHandler.close(); } catch { /* A handler that is already closed has nothing left to stop. */ }
      resolveFail(error);
    };
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
