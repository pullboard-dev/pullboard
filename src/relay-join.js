/** relay on in a clone joins the board its pullboard.json names, and never links a second one [E12,E17]. */
import { hostname } from 'node:os';
import { join } from 'node:path';
import * as store from './board.js';
import {
  importBoard,
  isInitialBoard,
} from './exchange.js';
import { appliedSequence } from './engine.js';
import {
  codeIsFromMain,
  repoInfo,
} from './git.js';
import {
  forgetBoardKey,
  readBoardKey,
  storeBoardKey,
} from './relay-key.js';
import { requestBoardKey } from './relay-handover.js';
import { namedBoard } from './relay-board-config.js';
import { relayRelink } from './relay-relink.js';
import { updateRelayMachine } from './relay-machine.js';
import { listApiProjects } from './projects.js';
import { Refused } from './refused.js';
import { mainPolicy } from './trusted-policy.js';
import {
  localRecords,
  relayPersonCoordinator,
  relayStatus,
  request,
  restoreCheckpoint,
  saveLink,
  syncRelay,
} from './relay.js';

const TOKEN = /^pm_[A-Za-z0-9_-]{43}$/u;

/** Refuse a clone whose board already holds work before asking anyone for a key: joining would hide it. */
function requireFreshBoard(root, board) {
  const local = store.openBoard(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite'), undefined, { isMain: codeIsFromMain() });
  try {
    if (!isInitialBoard(local)) {
      throw new Refused('RELAY_JOIN_NOT_EMPTY', `pullboard.json names board ${board.slice(0, 8)}, but this clone's own board already holds work`,
        'keep this board, and run pullboard init then pullboard relay on in a fresh clone to join the team board');
    }
  } finally { store.closeBoard(local); }
}

/** This device's copy of the board key: already here for another clone on this machine, or handed over by a member. */
async function boardKey(link, login, io) {
  try { return { key: readBoardKey(link.board), stored: false }; } catch (error) { if (error.code !== 'RELAY_KEY_MISSING') throw error; }
  const key = Buffer.from(await requestBoardKey(link, login, request, io));
  return { key, stored: storeBoardKey(link.board, key) };
}

/**
 * Join the named board: the person signs in, a member device hands over the key, the relay issues this machine its own
 * credential, and the relay's checkpoint becomes this clone's board, as a pairing would bring it.
 */
export async function joinNamedBoard(root, file, { board, url, repository, signIn }, io) {
  requireFreshBoard(root, board);
  const signed = await signIn();
  const login = signed.login ?? signed.user?.login;
  const account = signed.account ?? signed.user?.id;
  const { key, stored } = await boardKey({ url, board, repository, token: signed.token }, login, io);
  try {
    const machine = updateRelayMachine(settings => settings.machine);
    const issued = await request({ url, board, token: signed.token }, '/auth/machines', { method: 'POST', body: { board, machine, host: hostname() } }, io);
    if (!TOKEN.test(issued.token ?? '') || issued.board !== board || issued.machine !== machine) throw new Refused('RELAY_RESPONSE', 'the relay did not issue this board’s machine credential; sign in again');
    const state = { version: 1, mode: 'ordered', board, url, repository, token: issued.token, tokenId: issued.id, machine, account,
      ...(typeof login === 'string' && login ? { login } : {}), keyStorage: stored || 'file', sequence: 0, cursor: 0, baselineAccepted: true };
    await restoreCheckpoint(root, state, io, key, (local, native) => importBoard(local, native));
    state.sequence = localRecords(root, appliedSequence);
    state.cursor = localRecords(root, (local) => local.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id);
    saveLink(file, state);
  } catch (error) {
    if (stored) { try { forgetBoardKey(board, stored); } catch { /* The original refusal is the useful next step. */ } }
    throw error;
  }
  const approvers = mainPolicy(root).config.approvers;
  // Membership admits an ordinary developer; it does not confer the board person’s coordinator authority.
  if (!Array.isArray(approvers) || !approvers.length || approvers.some(approver => approver.toLowerCase() === String(login).toLowerCase())) {
    await relayPersonCoordinator(root, signed.token, io);
  }
  await syncRelay(root, io);
  const name = listApiProjects().find(project => project.root === repoInfo(root).root)?.name ?? repository;
  const result = { ...relayStatus(root), notice: `Joined ${name}: this clone works on board ${board.slice(0, 8)}, the one pullboard.json names.` };
  io.err(result.notice);
  return result;
}

/**
 * Join the board this clone's pullboard.json names when the clone has no link and its own board is another one, or
 * return null so relay on links as before. A relink after relay off names its own previous board and is not a join.
 */
export async function joinNamedBoardIfAny(root, file, { linked, url, repository, signIn }, io) {
  const named = linked ? null : namedBoard(repoInfo(root).root);
  const relinking = relayRelink(root);
  if (!named || named === localRecords(root, store.boardId) || relinking?.previous === named || relinking?.next === named) return null;
  return joinNamedBoard(root, file, { board: named, url, repository, signIn: () => signIn(url) }, io);
}
