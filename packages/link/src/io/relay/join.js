/** relay on in a clone joins the board its pullboard.json names, and never links a second one [E12,E17]. */
import { hostname } from 'node:os';
import { join } from 'node:path';
import * as store from '../../../../store/index.js';
import { importBoard } from '../../../../store/index.js';
import { isInitialBoard } from '../../../../store/index.js';
import { appliedSequence } from '../../../../state/index.js';
import { codeIsFromMain } from '../../../../git/index.js';
import { repoInfo } from '../../../../git/index.js';
import { forgetBoardKey } from '../../../../keys/index.js';
import { readBoardKey } from '../../../../keys/index.js';
import { storeBoardKey } from '../../../../keys/index.js';
import { requestBoardKey } from './handover.js';
import { namedBoard } from './config.js';
import { relayRelink } from './relink.js';
import { updateRelayMachine } from './machine.js';
import { listApiProjects } from '../../../../seats/index.js';
import { Refused } from '../../../../kernel/light.js';
import { mainPolicy } from '../../../../sandbox/index.js';
import { localRecords } from '../relay.js';
import { relayPersonCoordinator } from '../relay.js';
import { relayStatus } from '../relay.js';
import { request } from '../relay.js';
import { restoreCheckpoint } from '../relay.js';
import { saveLink } from '../relay.js';
import { syncRelay } from '../relay.js';

const TOKEN = /^pm_[A-Za-z0-9_-]{43}$/u;

/** Refuse a clone whose board already holds work before asking anyone for a key: joining would hide it. */
function requireFreshBoard(root, board, openBoard) {
  const local = openBoard(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite'), undefined, { isMain: codeIsFromMain() });
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
export async function joinNamedBoard(root, file, { board, url, repository, signIn, openBoard }, io) {
  requireFreshBoard(root, board, openBoard);
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
    state.sequence = localRecords(openBoard, root, appliedSequence);
    state.cursor = localRecords(openBoard, root, (local) => local.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id);
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
  const result = { ...relayStatus(root, io), notice: `Joined ${name}: this clone works on board ${board.slice(0, 8)}, the one pullboard.json names.` };
  io.err(result.notice);
  return result;
}

/**
 * Join the board this clone's pullboard.json names when the clone has no link and its own board is another one, or
 * return null so relay on links as before. A relink after relay off names its own previous board and is not a join.
 */
export async function joinNamedBoardIfAny(root, file, { linked, url, repository, signIn, openBoard }, io) {
  const named = linked ? null : namedBoard(repoInfo(root).root);
  const relinking = relayRelink(root);
  if (!named || named === localRecords(openBoard, root, store.boardId) || relinking?.previous === named || relinking?.next === named) return null;
  return joinNamedBoard(root, file, { board: named, url, repository, signIn: () => signIn(url), openBoard }, io);
}
