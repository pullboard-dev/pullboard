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

/** Declarative CLI forms keep API calls on the same argument parser and engine as terminal moves. */
const MOVES = {
  'spec-approve': { prefix: ['spec', 'approve'], positions: ['ids'], flags: ['by'] },
  'spec-decline': { prefix: ['spec', 'decline'], positions: ['ids'], flags: ['reason'] },
  add: { positions: ['lane', 'title'], flags: ['criterion', 'specs', 'parent', 'after', 'brief', 'route', 'check'], booleans: ['wait'] },
  edit: { item: true, flags: ['criterion', 'brief', 'route', 'check'], booleans: ['wait'] },
  claim: { item: true },
  release: { item: true },
  submit: { item: true },
  done: { item: true },
  verify: { item: true, positions: ['decision'], flags: ['reason', 'note', 'as'] },
  merged: { item: true, positions: ['commit'] },
  withdraw: { item: true, positions: ['reason'] },
  refreeze: { item: true },
  escalate: { item: true, flags: ['note'] },
  hold: { positions: ['lane'], flags: ['reason'], booleans: ['off'] },
  shout: { positions: ['to', 'text'], optional: ['to'], booleans: ['decision'], flags: ['evidence', 'outcome', 'item', 'commit'] },
  answer: { item: true, positions: ['text'], flags: ['as'] },
  pass: { item: true, positions: ['note'] },
  next: { flags: ['as'], booleans: ['verify'] },
};

/** Reject unsupported fields, then pass values as distinct argv entries, never a shell command. */
export function moveArgs({ verb, item, args = {} }) {
  if (verb === 'accept' || verb === 'reject') return moveArgs({ verb: 'verify', item, args: { ...args, decision: verb } });
  const form = Object.hasOwn(MOVES, verb) ? MOVES[verb] : null;
  if (!form) throw new Refused('BAD_REQUEST', `no API move ${String(verb)}; use a board move such as add, claim, submit, verify, shout or answer`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Refused('BAD_REQUEST', 'args needs a JSON object containing this move\'s arguments');
  const allowed = [...(form.positions ?? []), ...(form.flags ?? []), ...(form.booleans ?? [])];
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Refused('BAD_REQUEST', `${verb} does not take args.${key}; use only this CLI move's arguments`);
  const argv = form.prefix ? [...form.prefix] : [verb];
  if (form.item) {
    if (!Number.isSafeInteger(item) || item < 1) throw new Refused('BAD_REQUEST', `${verb} needs a positive integer item; use the item id from the board state`);
    argv.push(String(item));
  } else if (item !== undefined && item !== null) throw new Refused('BAD_REQUEST', `${verb} does not take item; put its arguments in args`);
  const positional = [];
  for (const key of form.positions ?? []) {
    if (args[key] === undefined && form.optional?.includes(key)) continue;
    if (typeof args[key] !== 'string' || !args[key].trim()) throw new Refused('BAD_REQUEST', `${verb} needs args.${key} as nonempty text; supply the CLI move's argument`);
    positional.push(args[key]);
  }
  for (const key of form.flags ?? []) if (args[key] !== undefined) {
    if (typeof args[key] !== 'string') throw new Refused('BAD_REQUEST', `args.${key} needs text; supply the CLI flag's value`);
    argv.push(`--${key}=${args[key]}`);
  }
  for (const key of form.booleans ?? []) if (args[key] !== undefined) {
    if (typeof args[key] !== 'boolean') throw new Refused('BAD_REQUEST', `args.${key} needs true or false`);
    if (args[key]) argv.push(`--${key}`);
  }
  // Positionals follow -- so titles and notes beginning with a dash never become CLI flags.
  argv.push('--json', '--', ...positional);
  return argv;
}

/** Execute one actual CLI command and retain its emitted event without a latest-row race. */
async function executeMove(root, body, runCommand) {
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
        milestones: milestoneRoadmap(board.root, db),
        rowDecisions: store.rowDecisions(db),
      }));
      state.requests = projectData.requests;
      state.milestones = projectData.milestones;
      state = projectRowDecisions(projectData.rowDecisions, state);
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
