/**
 * Each seat's own relay credential (#579, H2, V1): the seat name a creator registers, the receipt
 * that binds its first token to that registration, and which token a move is sent with. A live
 * token renews itself; a lost one is reissued by its creator; the machine credential only
 * first-mints a seat the relay never issued, build-only.
 *
 * Why the import back into relay.js: these use its link file and HTTP request, and relay.js calls
 * them only at run time, never while the modules load, so the cycle is safe.
 */
import { createHash } from 'node:crypto';
import * as store from './board.js';
import {
  ENGINE_VERSION,
  VERIFIER_STANDING_ENGINE,
} from './machine.js';
import { Refused } from './refused.js';
import {
  localRecords,
  request,
  saveLink,
} from './relay.js';

/**
 * Name the seat a creator registers (#579): the receipt names its target before the move is
 * sealed, so the id travels in the move. A join no seat made, a returning worktree and the
 * coordinator lane keep the board's own numbering.
 */
export function withSeatName(root, operation, args) {
  // A registration that names no creator is a join no seat made.
  if (operation === 'register' && args?.[0] && args[0].createdBy === undefined) args = [{ ...args[0], createdBy: 'machine' }, ...args.slice(1)];
  const options = args?.[0];
  if (operation !== 'register' || ENGINE_VERSION < VERIFIER_STANDING_ENGINE || !options || typeof options.createdBy !== 'string' ||
      options.createdBy === 'machine' || options.lane === 'coordinator' || options.id !== undefined) return args;
  const id = localRecords(root, (board) => store.agentAt(board, options.path) ? null : store.nextSeatId(board, options.lane));
  return id ? [{ ...options, id }, ...args.slice(1)] : args;
}

/** Move a pending registration to the first name from `from` that this replica has not registered. */
export function nameNextSeat(root, move, from) {
  const options = move.args[0];
  localRecords(root, (board) => {
    let n = Math.max(from, Number(store.nextSeatId(board, options.lane).slice(options.lane.length + 1)));
    while (store.listAgents(board).some((agent) => agent.agent_id === `${options.lane}-${n}`)) n += 1;
    options.id = `${options.lane}-${n}`;
  });
}

/** The public receipt a creator sends with a registration: target, creator, position and sealed digest. */
export function seatReceipt(move, sequence, sealed) {
  const options = move?.operation === 'register' && move.engine >= VERIFIER_STANDING_ENGINE ? move.args?.[0] : null;
  if (!options || typeof options.id !== 'string' || typeof options.createdBy !== 'string' || options.createdBy === 'machine') return undefined;
  return { target: options.id, creator: options.createdBy, sequence, digest: createHash('sha256').update(sealed).digest('hex') };
}

/** Cache one seat's own scoped token; nothing else is ever written into agentTokens. */
export function cacheSeatToken(file, state, actor, issued) {
  if (!/^pa_[A-Za-z0-9_-]{43}$/.test(issued?.token ?? '') || issued.board !== state.board || issued.agent !== actor ||
      typeof issued.id !== 'string' || !Number.isSafeInteger(issued.expires)) {
    throw new Refused('RELAY_RESPONSE', 'the relay did not issue this agent’s scoped credential; retry the command');
  }
  state.agentTokens ??= {};
  state.agentTokens[actor] = { id: issued.id, token: issued.token, expires: issued.expires,
    ...(Number.isSafeInteger(issued.created) ? { created: issued.created } : {}) };
  saveLink(file, state);
  return issued.token;
}

/** When a cached token renews itself: halfway through its life, or a minute before expiry when its start is unknown. */
function renewalDue(cached) {
  return Number.isSafeInteger(cached.created) && cached.expires > cached.created
    ? cached.expires - (cached.expires - cached.created) / 2 : cached.expires - 60_000;
}

/** Refuse a seat whose locally recorded revocation also forbids provisional offline moves [H2,H9,H21]. */
export function refuseRevokedSeat(state, actor) {
  if (state.agentTokens?.[actor]?.revoked) throw new Refused('TOKEN_REVOKED', `the relay token of ${actor} was revoked on this board; work from a seat with its own token, or ask the coordinator for a fresh worktree`);
}

/**
 * The current token of one registered seat (#579). A live token renews itself with itself; a lost
 * or expired one is reissued by the seat that enrolled it, walking up to the coordinator, whose
 * own token only the person reissues. A seat that never held a token gets its first, build-only
 * one from the machine credential. Nothing here ever remints a seat through the machine.
 */
async function seatToken(root, file, state, actor, io, depth = 0) {
  if (depth > 64) throw new Refused('RELAY_ACTOR', 'this seat\'s line of creators loops; ask the coordinator to make a fresh seat');
  const cached = state.agentTokens?.[actor];
  refuseRevokedSeat(state, actor);
  if (cached?.token && cached.expires > Date.now()) {
    if (Date.now() < renewalDue(cached)) return cached.token;
    const renewed = await request({ ...state, token: cached.token, agent: actor }, '/auth/tokens', { method: 'POST', body: { board: state.board, agent: actor } }, io);
    return cacheSeatToken(file, state, actor, renewed);
  }
  const seat = localRecords(root, (board) => {
    const agent = store.listAgents(board).find((row) => row.agent_id === actor);
    return agent ? { creator: store.agentCreator(board, actor), enrolled: store.seatEnrolled(board, actor) } : null;
  });
  if (!seat) throw new Refused('RELAY_ACTOR', 'register this agent in the ordered board before obtaining its scoped token');
  if (seat.enrolled && actor !== 'coordinator') {
    const creatorToken = await seatToken(root, file, state, seat.creator, io, depth + 1);
    const reissued = await request({ ...state, token: creatorToken, agent: seat.creator }, '/auth/tokens',
      { method: 'POST', body: { board: state.board, agent: actor, recover: true } }, io);
    return cacheSeatToken(file, state, actor, reissued);
  }
  if (cached) {
    throw new Refused('TOKEN_EXPIRED', actor === 'coordinator'
      ? 'the coordinator relay token expired; the person reissues it: run pullboard relay on in the main checkout'
      : `the relay token of ${actor} expired, and only a seat's own current token or its creator renews it; ask the coordinator for a fresh worktree: pullboard worktree <lane> --model "<model name>"`);
  }
  if (!state.token?.startsWith('pm_')) throw new Refused('HUMAN_REQUIRED', 'run pullboard relay on --all to authorize this board’s machine credential');
  // The machine credential first-mints only a seat the relay never issued a token to; it stays build-only.
  const issued = await request(state, '/auth/tokens', { method: 'POST', body: { board: state.board, agent: actor } }, io);
  return cacheSeatToken(file, state, actor, issued);
}

/** Select a scoped credential: the machine's, a supplied agent token, or the seat's own token. */
export async function actorTransport(root, file, state, actor, io) {
  if (typeof actor !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(actor)) {
    throw new Refused('RELAY_ACTOR', 'name the registered agent performing this move before sending it');
  }
  if (actor === 'person') {
    throw new Refused('HUMAN_REQUIRED', 'send this person action from the paired phone');
  }
  if (actor === 'machine') {
    if (!state.token?.startsWith('pm_')) throw new Refused('HUMAN_REQUIRED', 'run pullboard relay on --all to authorize this board’s machine credential');
    return state;
  }
  const supplied = io?.ignoreRelayEnvironmentToken ? undefined : process.env.PULLBOARD_RELAY_TOKEN;
  if (supplied !== undefined) {
    if (!/^pa_[A-Za-z0-9_-]{43}$/.test(supplied)) throw new Refused('AUTH_REQUIRED', 'supply a current scoped board token, without including it in command arguments');
    const transport = { ...state, token: supplied, agent: actor };
    const identity = await request(transport, '/auth/session?board=' + state.board, {}, io);
    if (identity.session?.kind !== 'board' || identity.session.agent !== actor) throw new Refused('RELAY_ACTOR', 'use the scoped token belonging to this move’s registered agent');
    return transport;
  }
  if (state.token?.startsWith('pa_')) {
    const identity = await request(state, '/auth/session?board=' + state.board, {}, io);
    if (identity.session?.agent !== actor) throw new Refused('RELAY_ACTOR', 'use the scoped token belonging to this move’s registered agent');
    return { ...state, agent: actor };
  }
  return { ...state, token: await seatToken(root, file, state, actor, io), agent: actor };
}

/**
 * Give the coordinator a token the person set up, once per board, inside relay on's own sign-in
 * (#579): the first one, a reissue after loss or expiry, or the reset of a machine-minted one.
 * A live person-made coordinator token is kept as it is.
 */
export async function ensurePersonCoordinator(file, state, session, io) {
  const cached = state.agentTokens?.coordinator;
  if (cached?.token && !cached.revoked && Date.now() < renewalDue(cached)) {
    try {
      const identity = await request({ ...state, token: cached.token }, '/auth/session?board=' + state.board, {}, io);
      if (identity.session?.kind === 'board' && identity.session.agent === 'coordinator' && identity.session.root === true) return;
    } catch (error) { if (error.code !== 'AUTH_REQUIRED') throw error; }
  }
  const issued = await request({ ...state, token: session }, '/auth/coordinators', { method: 'POST',
    body: { board: state.board, ...(typeof cached?.id === 'string' ? { replaces: cached.id } : {}) } }, io);
  cacheSeatToken(file, state, 'coordinator', { ...issued, agent: 'coordinator' });
}
