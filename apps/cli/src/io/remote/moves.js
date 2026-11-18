/**
 * Board writes over HTTP for a seat whose board lives on another host: with board.url set, next, claim, fact, release,
 * submit, verify and shout post {verb, item, args, agent} to the board host's /moves and open no board.sqlite [P7].
 * Why: the board host runs the real CLI move in the seat's registered worktree, so a refusal comes back with the same
 * code and next step the local command prints.
 */
import { Refused } from '../../../../../packages/kernel/light.js';
import { boardPath } from './board.js';
import { reportRemoteRefusal } from './board.js';
import { requestJson } from './board.js';
import { seatAgent } from './board.js';

// Budget: a move runs one CLI command on the board host, a submit's gate handoff included; slower is unreachable.
const MOVE_TIMEOUT_MS = 120_000;

/** The positional arguments each remote verb takes after its item, by the board API's argument names. */
const POSITIONS = Object.freeze({
  next: null,
  claim: [],
  fact: ['kind', 'text'],
  release: [],
  submit: [],
  done: [],
  verify: ['decision'],
  shout: [],
});

/** The commands a seat with board.url set sends to the board host as moves. */
export const REMOTE_MOVES = new Set(Object.keys(POSITIONS));

/**
 * Turn one parsed CLI command into the board API's move body; flags pass through by name for the host to check.
 * @param {{ positionals: string[], values: Record<string, unknown> }} parsed
 * @param {string} agent
 */
export function moveBody({ positionals, values }, agent) {
  const [verb, ...rest] = positionals;
  const names = POSITIONS[verb];
  const args = Object.fromEntries(Object.entries(values).filter(([key, value]) => key !== 'json' && value !== undefined));
  if (verb === 'shout') {
    // A shout names no item: `shout <to> "<text>"`, or `shout "<text>"` to everyone; flags such as --kind pass through by name.
    if (rest.length < 1 || rest.length > 2) throw new Refused('USAGE', 'pullboard shout [<to>] "<text>"');
    const [to, text] = rest.length === 2 ? rest : [undefined, rest[0]];
    return { verb, args: { ...(to === undefined ? {} : { to }), text, ...args }, agent };
  }
  if (names === null) {
    if (rest.length) throw new Refused('USAGE', 'pullboard next takes no positional arguments');
    return { verb, args, agent };
  }
  const raw = String(rest[0] ?? '').replace(/^#/u, '');
  if (!/^[1-9]\d*$/u.test(raw) || rest.length !== names.length + 1) {
    throw new Refused('USAGE', `pullboard ${verb} <id>${names.map((name) => ` <${name}>`).join('')}`);
  }
  names.forEach((name, index) => { args[name] = rest[index + 1]; });
  return { verb, item: Number(raw), args, agent };
}

/** One line naming an item, as board output names it. */
function itemLine(item) {
  return `#${item.item_id ?? item.id} ${item.item_title ?? item.title ?? ''}`.trim();
}

/** Print the served board's result for one move in text form; --json prints the result document itself. */
function sayResult(io, verb, itemId, result, board) {
  const item = result?.item && typeof result.item === 'object' ? result.item : null;
  if (verb === 'next') {
    if (item) io.say(`${result.review ? 'review reserved' : 'build claimed'}: ${itemLine(item)}`);
    else io.say(`next: no eligible work; ${(result?.reasons ?? []).join('; ').replace(/[\r\n]+/gu, ' ') || 'nothing offered'}`);
  } else {
    if (verb === 'shout') { io.say(`shouted${result?.id ? ` #${result.id}` : ''} via ${board}`); return; }
    const done = { claim: 'claimed', fact: 'recorded a fact on', release: 'released', submit: 'submitted', done: 'submitted', verify: 'recorded a verdict on' }[verb];
    io.say(`${done} ${item ? itemLine(item) : `#${itemId}`} via ${board}`);
  }
  const following = result?.next;
  if (following?.item) io.say(`next ${following.review ? 'review reserved' : 'build claimed'}: ${itemLine(following.item)}`);
}

/**
 * Post one write command to the board host's /moves and return the exit code; a refusal prints its code and next step.
 * @param {any} io
 * @param {{ positionals: string[], values: Record<string, unknown> }} parsed
 * @param {{ url: string, token: string }} remote
 */
export async function runRemoteMove(io, parsed, remote) {
  try {
    const agent = seatAgent(io.cwd);
    if (!agent) throw new Refused('NO_AGENT', 'this seat has no agent name; run pullboard join <lane> with board.url set, or set PULLBOARD_AGENT');
    const body = moveBody(parsed, agent);
    // Off by default: board.commits bundle sends the clone's commits with its submit, and pushed names the commit it pushed [P7,C7].
    const commits = await (await import('../submit/push-ref.js')).carriedCommits(remote, body, io.cwd);
    if (commits) body.commits = commits;
    const moved = await requestJson(remote, `${await boardPath(remote)}/moves`, body, MOVE_TIMEOUT_MS);
    const board = new URL(remote.url).origin;
    io.result?.(moved.result ?? moved);
    sayResult(io, body.verb, body.item, moved.result ?? moved, board);
  } catch (error) {
    return reportRemoteRefusal(io, error);
  }
  const status = io.exitCode(0);
  io.flush(status);
  return status;
}
