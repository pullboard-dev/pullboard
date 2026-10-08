/** The local API v1: the CLI's moves, persistent board identities and live events (A2). */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import * as store from './board.js';
import { COORDINATOR, loadConfig } from './config.js';
import { repoInfo } from './git.js';
import { refusalDocument } from './json.js';
import { relayLinked, relayOperation } from './relay.js';
import { laneNames } from './lanes.js';
import { listApiProjects } from './projects.js';
import { milestoneRoadmap } from './roadmap.js';
import { projectRowDecisions } from './row-decisions.js';
import { Refused } from './refused.js';
import { codeAt, projectState } from './serve.js';
import { createApiHandler } from './api-http.js';
import { moveArgs } from './api-moves.js';
import { personRequestStatuses } from './relay-requests.js';
export { moveArgs } from './api-moves.js';

const ADDRESS = '127.0.0.1';
const VERSION = 1;

/** Read a registered board and release its SQLite connection on every path. */
function withBoard(root, read) {
  const info = repoInfo(root);
  loadConfig(info.root);
  const board = store.openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'));
  try { return read(board, info); } finally { store.closeBoard(board); }
}

/** Registered boards carry one persistent identity across local and relay addresses. */
export function apiBoards(projects = listApiProjects) {
  return projects().flatMap((project) => {
    try { return [withBoard(project.root, (board) => ({ ...project, id: store.boardId(board) }))]; }
    catch { return []; }
  });
}

/**
 * List readable registered boards and retain actionable warnings for entries that failed to open.
 *
 * @param {() => { root: string, name: string, project: string, added: string }[]} projects
 * @returns {{ boards: object[], warnings: object[] }}
 */
function apiBoardListing(projects = listApiProjects) {
  const boards = [];
  const warnings = [];
  for (const project of projects()) {
    try {
      boards.push(withBoard(project.root, (board) => ({ ...project, id: store.boardId(board) })));
    } catch (cause) {
      const error = cause.code === 'EVENT_LOG_VERSION' ? cause : new Refused('BOARD_UNAVAILABLE', `registered project ${project.root} cannot be read; restore the repo or run pullboard forget ${project.root}`);
      warnings.push({ ...project, error: refusalDocument(error) });
    }
  }
  return { boards, warnings };
}

/** Resolve only registered boards, so a request cannot open an arbitrary path on the machine. */
function findBoard(id, projects) {
  const board = apiBoards(projects).find((entry) => entry.id === id);
  if (!board) throw new Refused('NO_BOARD', `no registered board ${id}; run pullboard serve in its repo and use GET /api/v1/boards`);
  return board;
}

/** Read events in sequence, including changes made by other processes on the same board. */
function afterEvents(root, after) {
  return withBoard(root, (board) => board.db.prepare('SELECT * FROM event WHERE event_id > ? ORDER BY event_id').all(after));
}

/** Resolve an authenticated local caller's agent to its own checkout, never another board. */
function agentPath(root, name = COORDINATOR) {
  if (typeof name !== 'string' || !name) throw new Refused('BAD_REQUEST', 'agent needs a registered name; omit it to act as the coordinator');
  return withBoard(root, (board, info) => {
    if (name === COORDINATOR && !relayLinked(root)) store.ensureCoordinator(board, root);
    const agent = store.listAgents(board).find((entry) => entry.agent_id === name);
    if (!agent) throw new Refused('NO_AGENT', `no registered agent ${name}; use the agents in this board's state or join a worktree first`);
    // A clone shares the coordinator identity, but resolves its main checkout locally.
    if (name === COORDINATOR && relayLinked(root)) return root;
    if (repoInfo(agent.agent_path).commonDir !== info.commonDir) throw new Refused('WRONG_BOARD', `agent ${name}'s worktree belongs to another board; join the agent in this board's worktree`);
    return agent.agent_path;
  });
}

/** Execute one actual CLI command and retain its emitted event without a latest-row race. */
export async function executeMove(root, body, runCommand) {
  if (Object.keys(body).some((key) => !['verb', 'item', 'args', 'agent'].includes(key))) throw new Refused('BAD_REQUEST', 'a move takes only verb, item, args and agent; remove the unknown fields');
  const argv = moveArgs(body);
  let cwd;
  try { cwd = agentPath(root, body.agent); } catch (error) {
    if (!(error instanceof Refused) || error.code === 'BAD_REQUEST') throw error;
    return { status: error.code === 'WRONG_BOARD' ? 403 : 409, body: refusalDocument(error) };
  }
  let output = '';
  let diagnostics = '';
  const events = [];
  const status = await runCommand(argv, {
    cwd,
    personChannel: 'view',
    stdout: { isTTY: false, write: (text) => { output += text; } },
    stderr: { write: (text) => { diagnostics += text; } },
    onEvent: (row) => { events.push(row); },
  });
  const result = JSON.parse(output);
  if (status) return { status: 409, body: result };
  if (body.verb === 'next' && result.offer) return { status: 200, body: { version: VERSION, event: null, result, offer: result.offer } };
  const kind = body.verb === 'verify' ? body.args?.decision
    : body.verb === 'done' ? 'submit'
    : body.verb === 'hold' && body.args?.off ? 'unhold' : body.verb;
  const event = events.find((row) => row.event_kind === kind) ?? events.at(-1);
  if (!event) throw new Error(`move ${body.verb} produced no event${diagnostics ? `: ${diagnostics}` : ''}`);
  return { status: 200, body: { version: VERSION, event, result } };
}

/** Create a person's coordinator request through the same shout transaction as the CLI. */
async function createRequest(root, body) {
  if (typeof body.text !== 'string' || !body.text.trim() || Object.keys(body).some((key) => key !== 'text')) throw new Refused('BAD_REQUEST', 'a request needs {text: "what the coordinator should do"}');
  const message = { from: 'person', to: COORDINATOR, text: body.text, request: true, lanes: laneNames(loadConfig(root)) };
  if (relayLinked(root)) {
    const id = await relayOperation(root, 'shout', [message], { err: () => {} });
    return withBoard(root, (board) => ({ version: VERSION,
      event: store.events(board).find((event) => JSON.parse(event.event_detail).shout === id),
      result: { id, request: true } }));
  }
  return withBoard(root, (board) => {
    const id = store.shout(board, message);
    return { version: VERSION, event: board.lastEvent, result: { id, request: true } };
  });
}

/** Create the authenticated local adapter used by the HTTP server and other local transports. */
export function createLocalApiHandler({ secret, getPort, runCommand, projects = listApiProjects } = {}) {
  if (typeof getPort !== 'function') throw new TypeError('createLocalApiHandler needs a bound-port getter');
  if (typeof runCommand !== 'function') throw new TypeError('createLocalApiHandler needs the actual CLI entry point as runCommand');
  const key = Buffer.from(secret);
  return createApiHandler({
    authenticate: (req) => {
      const url = new URL(req.url ?? '/', 'http://' + ADDRESS);
      const authorization = String(req.headers.authorization ?? '');
      const given = Buffer.from(String(req.headers['x-pullboard-key'] ?? (authorization.startsWith('Bearer ') ? authorization.slice(7) : url.searchParams.get('k') ?? '')));
      const bound = getPort();
      const ownHost = req.headers.host === ADDRESS + ':' + bound || req.headers.host === 'localhost:' + bound;
      if (!ownHost || given.length !== key.length || !timingSafeEqual(given, key)) throw new Refused('AUTH_REQUIRED', 'this API needs its session secret and own host; use the address pullboard serve printed');
      if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) throw new Refused('API_ORIGIN', 'use the API from its own origin');
      return { local: true };
    },
    boards: () => apiBoardListing(projects),
    board: (id) => findBoard(id, projects),
    state: (board, who, seen) => {
      let state = projectState(board.root, { seen });
      state.board = board.id;
      const projectData = withBoard(board.root, (db) => ({
        requests: store.openRequests(db),
        personRequests: personRequestStatuses(db),
        milestones: milestoneRoadmap(board.root, db),
        rowDecisions: store.rowDecisions(db),
        threads: new Map(store.listItems(db, { all: true }).map((item) => [item.item_id, store.itemThread(db, item.item_id)])),
      }));
      state.requests = projectData.requests;
      state.personRequests = projectData.personRequests;
      state.milestones = projectData.milestones;
      state = projectRowDecisions(projectData.rowDecisions, state);
      state.items = state.items.map((item) => ({ ...item, thread: projectData.threads.get(item.id) ?? [] }));
      return state;
    },
    code: (board, ref) => codeAt(board.root, ref),
    events: (board, after) => afterEvents(board.root, after),
    eventLogVersion: () => store.EVENT_LOG_VERSION,
    move: (board, body) => executeMove(board.root, body, runCommand),
    request: (board, body) => createRequest(board.root, body),
  });
}

/** Serve the RFC 0002 API only on loopback, behind the same session-secret boundary as the view. */
export function serveApi({ port = 0, secret = randomBytes(18).toString('base64url'), runCommand, projects = listApiProjects } = {}) {
  if (typeof runCommand !== 'function') throw new TypeError('serveApi needs the actual CLI entry point as runCommand');
  let bound;
  const handler = createLocalApiHandler({ secret, getPort: () => bound, runCommand, projects });
  const server = createServer(handler);
  server.requestTimeout = 15_000;
  return new Promise((ready, fail) => {
    server.once('error', (error) => fail(new Refused(error.code === 'EADDRINUSE' ? 'PORT_BUSY' : 'API_LISTEN', `cannot listen on ${ADDRESS}:${port}: ${error.message}; run pullboard serve --port 0 to choose a free port`)));
    server.listen(port, ADDRESS, () => {
      bound = server.address().port;
      ready({
        url: `http://${ADDRESS}:${bound}/api/v1/boards?k=${secret}`,
        port: bound,
        close: () => new Promise((closed) => { handler.close(); server.close(() => closed()); server.closeIdleConnections(); }),
      });
    });
  });
}
