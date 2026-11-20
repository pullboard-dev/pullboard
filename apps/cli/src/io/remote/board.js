/**
 * Board calls over HTTP for a seat whose board lives on another host: with board.url set, join, show and whoami ask
 * the board host's pullboard serve and open no board.sqlite [P7]. Writes reuse its transport from moves.js.
 */
import { environmentAdapter } from '../../../../../packages/env/index.js';
import { gitExecFileSync } from '../../../../../packages/git/light.js';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Refused } from '../../../../../packages/kernel/light.js';
import { boardRemote } from '../../../../../packages/config/light.js';

// Budget: one small board read; a board host slower than this is treated as unreachable.
const READ_TIMEOUT_MS = 10_000;

/** The board this machine's seats use over HTTP, or null for the local board. */
export function remoteBoard() {
  return boardRemote();
}

/**
 * GET one API path from the board host, or POST a JSON body to it, and decode its JSON, turning transport, key and
 * board refusals into refusals that keep the board's own code and next step.
 * Every call opens its own connection (agent: false): the shared keep-alive pool reuses a socket the board closed while idle,
 * which surfaced as ECONNRESET on a POST that then must not be retried [P7].
 * @param {{ url: string, token: string, seatKey?: string | null }} remote
 * @param {string} path An absolute API path.
 * @param {any} [body] A JSON body to POST; omitted for a read.
 * @param {number} [timeout] Milliseconds to wait for the answer.
 * @returns {Promise<any>}
 */
export function requestJson(remote, path, body, timeout = READ_TIMEOUT_MS) {
  const origin = new URL(remote.url).origin;
  const target = new URL(origin + path);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = body === undefined ? null : JSON.stringify(body);
  // A move as a seat carries that seat's own key beside the board key, or a served board refuses it SEAT_CREDENTIAL [P7,#10790].
  const headers = { authorization: `Bearer ${remote.token}`, accept: 'application/json', ...(remote.seatKey ? { 'x-pullboard-seat-key': remote.seatKey } : {}),
    ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) };
  return new Promise((resolve, reject) => {
    const unreachable = (why) => new Refused('BOARD_UNREACHABLE', `cannot reach board.url ${origin} (${why}); start pullboard serve on the board host, or fix it with pullboard settings board.url <url>`);
    const request = send(target, { method: payload === null ? 'GET' : 'POST', headers, timeout, agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (part) => { body += part; });
      response.once('end', () => {
        let document;
        try { document = JSON.parse(body); } catch { reject(unreachable(`HTTP ${response.statusCode} without a JSON answer`)); return; }
        const error = document?.error;
        if (response.statusCode === 200 && !error) { resolve(document); return; }
        if (error?.code === 'AUTH_REQUIRED' || response.statusCode === 401) {
          reject(new Refused('BOARD_TOKEN', `the board at ${origin} refused board.token; set the key its pullboard serve printed with pullboard settings board.token <key>`));
          return;
        }
        reject(new Refused(error?.code ?? 'BOARD_UNREACHABLE', error?.message ?? `the board at ${origin} answered HTTP ${response.statusCode}; check pullboard serve on the board host`, error?.next));
      });
    });
    request.once('timeout', () => request.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    request.once('error', (error) => reject(unreachable(error.code ?? error.message)));
    request.end(payload ?? undefined);
  });
}

/** GET one API path from the board host. */
function getJson(remote, path) {
  return requestJson(remote, path);
}

/**
 * The API path of the board board.url names: its own /api/v1/boards/<id> path, or the only board the host serves.
 * @param {{ url: string, token: string }} remote
 */
export async function boardPath(remote) {
  const named = /^\/api\/v1\/boards\/([^/?#]+)/u.exec(new URL(remote.url).pathname);
  if (named) return `/api/v1/boards/${named[1]}`;
  const { boards = [] } = await getJson(remote, '/api/v1/boards');
  if (boards.length !== 1) {
    throw new Refused('BOARD_AMBIGUOUS', `the host at board.url serves ${boards.length} boards; name one with pullboard settings board.url <origin>/api/v1/boards/<id>`);
  }
  return `/api/v1/boards/${boards[0].id}`;
}

/** This seat's agent name: PULLBOARD_AGENT, or the worktree's git config pullboard.agent that a remote join records. */
export function seatAgent(cwd) {
  if (environmentAdapter().get('PULLBOARD_AGENT')) return environmentAdapter().get('PULLBOARD_AGENT');
  try { return gitExecFileSync(['config', '--get', 'pullboard.agent'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch { return null; }
}

/**
 * The seat's own key that a remote join kept in this worktree's git config beside its name, or null when `agent` is
 * another seat (PULLBOARD_AGENT naming one) or the seat joined before keys were issued [P7,#10790].
 * @param {string} cwd
 * @param {string} agent
 */
export function seatKey(cwd, agent) {
  const read = (name) => { try { return gitExecFileSync(['config', '--get', name], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } };
  return agent && read('pullboard.agent') === agent ? read('pullboard.seatKey') : null;
}

/** Print one item from the board host, as show's header lines print it. */
async function showRemote(io, remote, positionals) {
  const raw = String(positionals[1] ?? '').replace(/^#/u, '');
  if (!/^[1-9]\d*$/u.test(raw) || positionals.length !== 2) throw new Refused('USAGE', 'pullboard show <id>');
  const path = await boardPath(remote);
  // An item's detail path leaves out its summary fields (title, lane, status), which the board's state carries.
  const [{ item: detail }, document] = await Promise.all([getJson(remote, `${path}/items/${raw}`), getJson(remote, `${path}/state`)]);
  const summary = ((document.state ?? document).items ?? []).find((entry) => entry.id === Number(raw)) ?? {};
  const item = { ...summary, ...detail };
  io.result?.({ item, board: new URL(remote.url).origin });
  io.say(`#${item.id}  ${item.status}  ${item.lane}  ${item.title}${item.specs?.length ? `  [${item.specs.join(', ')}]` : ''}`);
  if (item.criterion) io.say(`criterion: ${item.criterion}`);
  if (item.brief) io.say(`brief:\n  ${String(item.brief).split('\n').join('\n  ')}`);
}

/**
 * One seat's own row from the board host's agent route: its lane, route and the ids it holds claimed, without the board state,
 * which is 10 MB and too slow for a read budget [P7].
 * @param {{ url: string, token: string }} remote
 * @param {string} name
 */
export async function seatRoute(remote, name) {
  try { return await getJson(remote, `${await boardPath(remote)}/agents/${encodeURIComponent(name)}`); }
  catch (error) {
    if (error instanceof Refused && error.code === 'NO_AGENT') throw new Refused('NO_AGENT', `the board at board.url has no agent ${name}`, 'run pullboard join <lane> with board.url set');
    throw error;
  }
}

/** Print this seat's agent from the board host's agent route. */
async function whoamiRemote(io, remote, cwd) {
  const name = seatAgent(cwd);
  if (!name) throw new Refused('NO_AGENT', 'this seat has no agent name; run pullboard join <lane> with board.url set, or set PULLBOARD_AGENT');
  const agent = await seatRoute(remote, name);
  const board = new URL(remote.url).origin;
  io.result?.({ id: agent.agent_id, lane: agent.agent_lane, route: agent.agent_route, board });
  io.say(`${agent.agent_id} (${agent.agent_lane} lane${agent.agent_route === 'light' ? ', light route' : ''}) via ${board}`);
}

/**
 * The seat a commit hook checks in a boardless clone with board.url set, read from the served board's agent route, or null
 * when board.url is unset so the local check decides. An unreachable board or an unnamed seat refuses, never passes.
 * Why: the pre-commit lane check needs the seat's lane, and only the board host knows it [P7].
 * @param {string} cwd
 * @returns {Promise<{ agent_id: string, agent_lane: string } | null>}
 */
export async function remoteHookSeat(cwd) {
  const remote = remoteBoard();
  if (!remote) return null;
  const name = seatAgent(cwd);
  if (!name) throw new Refused('NO_AGENT', 'this clone has board.url set but no seat name, so its lane is unknown', 'run pullboard join <lane> with board.url set, or set PULLBOARD_AGENT');
  const agent = await seatRoute(remote, name);
  if (!agent?.agent_lane) throw new Refused('NO_AGENT', `the board at board.url has no agent ${name}`, 'run pullboard join <lane> with board.url set');
  return { agent_id: agent.agent_id, agent_lane: agent.agent_lane };
}

/**
 * Run join, show or whoami against the board host and return the exit code; a refusal prints its code and next step.
 * @param {any} io
 * @param {{ positionals: string[] }} parsed
 * @param {{ url: string, token: string }} remote
 */
export async function runRemoteRead(io, parsed, remote) {
  try {
    if (parsed.positionals[0] === 'join') {
      const postMove = async (move) => requestJson(remote, `${await boardPath(remote)}/moves`, move);
      await (await import('../commands/join.js')).joinRemote(io, parsed, new URL(remote.url).origin, postMove);
    } else if (parsed.positionals[0] === 'show') await showRemote(io, remote, parsed.positionals);
    else await whoamiRemote(io, remote, io.cwd);
  } catch (error) {
    return reportRemoteRefusal(io, error);
  }
  const status = io.exitCode(0);
  io.flush(status);
  return status;
}

/**
 * Print a refusal from the board host as the local command prints it, code and next: line included, and return 1.
 * @param {any} io
 * @param {unknown} error Rethrown unless it is a Refused.
 */
export async function reportRemoteRefusal(io, error) {
  if (!(error instanceof Refused)) throw error;
  io.refusal(error);
  await io.prepareRefusal();
  io.err(`pullboard: ${error.message}\nnext: ${error.next ?? io.refusalDocument(error).error.next}`);
  io.flush(1);
  return 1;
}
