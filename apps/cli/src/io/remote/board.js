/**
 * Board reads over HTTP for a seat whose board lives on another host: with board.url set, show and whoami ask the
 * board host's pullboard serve and open no board.sqlite [P7].
 */
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Refused } from '../../../../../packages/kernel/light.js';
import { boardRemote } from '../../../../../packages/config/index.js';

// Budget: one small board read; a board host slower than this is treated as unreachable.
const READ_TIMEOUT_MS = 10_000;

/** The board this machine's seats use over HTTP, or null for the local board. */
export function remoteBoard() {
  return boardRemote();
}

/**
 * GET one API path from the board host and decode its JSON, turning transport and key failures into refusals.
 * @param {{ url: string, token: string }} remote
 * @param {string} path An absolute API path.
 * @returns {Promise<any>}
 */
function getJson(remote, path) {
  const origin = new URL(remote.url).origin;
  const target = new URL(origin + path);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const unreachable = (why) => new Refused('BOARD_UNREACHABLE', `cannot reach board.url ${origin} (${why}); start pullboard serve on the board host, or fix it with pullboard settings board.url <url>`);
    const request = send(target, { headers: { authorization: `Bearer ${remote.token}`, accept: 'application/json' }, timeout: READ_TIMEOUT_MS }, (response) => {
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
        reject(new Refused(error?.code ?? 'BOARD_UNREACHABLE', error?.message ?? `the board at ${origin} answered HTTP ${response.statusCode}; check pullboard serve on the board host`));
      });
    });
    request.once('timeout', () => request.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    request.once('error', (error) => reject(unreachable(error.code ?? error.message)));
    request.end();
  });
}

/**
 * The API path of the board board.url names: its own /api/v1/boards/<id> path, or the only board the host serves.
 * @param {{ url: string, token: string }} remote
 */
async function boardPath(remote) {
  const named = /^\/api\/v1\/boards\/([^/?#]+)/u.exec(new URL(remote.url).pathname);
  if (named) return `/api/v1/boards/${named[1]}`;
  const { boards = [] } = await getJson(remote, '/api/v1/boards');
  if (boards.length !== 1) {
    throw new Refused('BOARD_AMBIGUOUS', `the host at board.url serves ${boards.length} boards; name one with pullboard settings board.url <origin>/api/v1/boards/<id>`);
  }
  return `/api/v1/boards/${boards[0].id}`;
}

/** This seat's agent name: PULLBOARD_AGENT, or the worktree's git config pullboard.agent that a remote join records. */
function seatAgent(cwd) {
  if (process.env.PULLBOARD_AGENT) return process.env.PULLBOARD_AGENT;
  try { return execFileSync('git', ['config', '--get', 'pullboard.agent'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch { return null; }
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

/** Print this seat's agent from the board host's state. */
async function whoamiRemote(io, remote, cwd) {
  const name = seatAgent(cwd);
  if (!name) throw new Refused('NO_AGENT', 'this seat has no agent name; run pullboard join <lane> with board.url set, or set PULLBOARD_AGENT');
  const document = await getJson(remote, `${await boardPath(remote)}/state`);
  const agent = ((document.state ?? document).agents ?? []).find((entry) => entry.agent_id === name);
  if (!agent) throw new Refused('NO_AGENT', `the board at board.url has no agent ${name}; run pullboard join <lane> with board.url set`);
  const board = new URL(remote.url).origin;
  io.result?.({ id: agent.agent_id, lane: agent.agent_lane, route: agent.agent_route, board });
  io.say(`${agent.agent_id} (${agent.agent_lane} lane${agent.agent_route === 'light' ? ', light route' : ''}) via ${board}`);
}

/**
 * The seat a commit hook checks in a boardless clone with board.url set, read from the served board's state, or null
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
  const document = await getJson(remote, `${await boardPath(remote)}/state`);
  const agent = ((document.state ?? document).agents ?? []).find((entry) => entry.agent_id === name);
  if (!agent?.agent_lane) throw new Refused('NO_AGENT', `the board at board.url has no agent ${name}`, 'run pullboard join <lane> with board.url set');
  return { agent_id: agent.agent_id, agent_lane: agent.agent_lane };
}

/**
 * Run show or whoami against the board host and return the exit code; a refusal prints its code and next step.
 * @param {any} io
 * @param {{ positionals: string[] }} parsed
 * @param {{ url: string, token: string }} remote
 */
export async function runRemoteRead(io, parsed, remote) {
  try {
    if (parsed.positionals[0] === 'show') await showRemote(io, remote, parsed.positionals);
    else await whoamiRemote(io, remote, io.cwd);
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    io.refusal(error);
    await io.prepareRefusal();
    io.err(`pullboard: ${error.message}\nnext: ${io.refusalDocument(error).error.next}`);
    io.flush(1);
    return 1;
  }
  const status = io.exitCode(0);
  io.flush(status);
  return status;
}
