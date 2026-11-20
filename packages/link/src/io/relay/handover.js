/** A member's new device gets its board key from an online member device, vouched by an SSH key on GitHub [E17]. */
import { createDeviceKeys } from '../../../../keys/index.js';
import { unwrapDeviceBoardKey } from '../../../../keys/index.js';
import { wrapDeviceBoardKey } from '../../../../keys/index.js';
import { ENGINE_VERSION } from '../../../../state/index.js';
import { Refused } from '../../../../kernel/light.js';
import { signSshVouch } from './proof.js';
import { verifySshVouch } from './proof.js';
import { authorizeMember } from './membership.js';
import { memberAuthorityStamp } from './membership.js';
import { boardId } from '../../../../store/index.js';
import { readBoardMembers } from '../../../../store/index.js';
import { localRecords } from '../relay.js';

const NAMESPACE = 'pullboard-device-key';
const TEN_MINUTES = 10 * 60_000;
const POLL_MS = 1000;

/** The exact bytes an SSH key signs: the statement, domain-separated from every other signature. */
export function statementBytes(statement) { return JSON.stringify([NAMESPACE, statement]); }

/** Wait between polls without keeping a finished command alive. */
function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

/**
 * Ask the repository's board for its key from this new device: sign a fresh device key with the person's SSH key, then
 * wait until a member device hands the key over, wrapped to that device key alone. `link` carries the relay url and
 * the person's own sign-in token; `send` is the relay transport.
 *
 * @returns {Promise<Uint8Array>} the board key
 */
export async function requestBoardKey(link, login, send, io) {
  const keys = await createDeviceKeys();
  const statement = { v: 1, board: link.board, repository: link.repository, device: keys.deviceId, publicKey: keys.publicKey,
    login, engine: ENGINE_VERSION, expires: Date.now() + TEN_MINUTES - 30_000 };
  const path = '/api/v1/boards/' + link.board + '/key-requests';
  const posted = await send(link, path, { method: 'POST', body: { statement, signature: signSshVouch(statementBytes(statement), NAMESPACE) } }, io);
  let said = false;
  while (Date.now() < statement.expires) {
    const answer = await send(link, path + '/' + posted.id, {}, io);
    if (answer.state === 'delivered') {
      return unwrapDeviceBoardKey(keys.privateKey, JSON.parse(Buffer.from(answer.wrapped, 'base64url').toString('utf8')),
        { board: link.board, device: keys.deviceId, engine: ENGINE_VERSION });
    }
    if (answer.state === 'refused') throw new Refused(answer.refused.code, answer.refused.message.replace(/^\[[A-Z0-9_]+\] /u, ''));
    if (!said) {
      said = true;
      // A live wait line, like the sign-in prompt: it reaches the terminal even when the result is JSON.
      (io.stderr ?? process.stderr).write(`pullboard: no member device is online to hand over the key for board ${link.board.slice(0, 8)}; waiting. Any pullboard command on a linked computer of this repository hands it over. Ctrl-C stops; run pullboard relay on again later.\n`);
    }
    await pause(POLL_MS);
  }
  throw new Refused('RELAY_KEY_WAIT_EXPIRED', 'no member device handed over the board key within ten minutes; run pullboard relay on again while a linked computer of this repository is online');
}

/** Read membership from this device's native board rather than a transport-supplied snapshot. */
function currentMembers(root, state, io) {
  if (typeof root !== 'string' || !root) {
    throw new Refused('RELAY_NOT_MEMBER', 'open the linked repository before handing over its board key');
  }
  return localRecords(io.openBoard, root, board => {
    if (boardId(board) !== state.board) {
      throw new Refused('RELAY_NOT_MEMBER', 'the local board does not match this key request; reopen the linked repository');
    }
    return readBoardMembers(board);
  });
}

/**
 * On a member device, answer every waiting key request for this board: wrap the key to a device key that one of the
 * person's GitHub SSH keys signed, and refuse the rest by name. GitHub being unreachable leaves a request waiting.
 * `send` is the relay transport and `githubKeys` reads a login's public SSH keys from GitHub.
 */
export async function handOverBoardKeys(state, key, { send, githubKeys, root, identity = null }, io) {
  const path = '/api/v1/boards/' + state.board + '/key-requests';
  const { requests } = await send(state, path, {}, io);
  for (const entry of Array.isArray(requests) ? requests : []) {
    const statement = entry.statement;
    let body;
    try {
      if (statement?.board !== state.board || typeof statement.repository !== 'string' || statement.repository.toLowerCase() !== String(state.repository).toLowerCase() || statement.login !== entry.login || !(statement.expires > Date.now())) {
        throw new Refused('RELAY_KEY_VOUCH', 'the key request names another board, repository or person; run pullboard relay on again in the clone');
      }
      if (!await verifySshVouch(statementBytes(statement), entry.signature, entry.login, githubKeys, NAMESPACE)) {
        throw new Refused('RELAY_KEY_VOUCH', `no SSH key on ${entry.login}'s GitHub account signed this device key; add the key that signed it to GitHub with gh ssh-key add, then run pullboard relay on again`);
      }
      const document = currentMembers(root, state, io);
      const authority = memberAuthorityStamp(root, document);
      await authorizeMember(root, state, document, entry.login, { githubKeys, identity });
      const wrapped = await wrapDeviceBoardKey(key, statement.publicKey, { board: state.board, device: statement.device, engine: statement.engine });
      // GitHub and WebCrypto yield: a local revocation or accepted-policy change must win before publication.
      if (authority !== memberAuthorityStamp(root, currentMembers(root, state, io))) {
        throw new Refused('RELAY_NOT_MEMBER', 'board membership changed during verification; retry with the current signed member list');
      }
      body = { wrapped: Buffer.from(JSON.stringify(wrapped)).toString('base64url') };
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      if (error.code === 'GITHUB_UNAVAILABLE') { io.err('pullboard: ' + error.message); continue; }
      body = { refused: { code: error.code, message: error.message } };
    }
    await send(state, path + '/' + entry.id, { method: 'PUT', body }, io);
    io.err(body.wrapped ? `pullboard: handed this board's key to a new device of ${entry.login}` : `pullboard: refused a new device of ${entry.login}: ${body.refused.message}`);
  }
}

/** Hand this board's key to member devices that asked; a failure here never fails the command that noticed [E17]. */
export async function handOverKeys(root, state, key, send, io) {
  delete io.keyRequestsWaiting;
  try {
    // This proof is made with this device's local SSH key, never accepted from a relay response.
    let identity = null;
    if (typeof state.login === 'string' && state.login) {
      const body = { v: 1, board: state.board, repository: state.repository, login: state.login };
      try { identity = { body, signature: signSshVouch(JSON.stringify(['pullboard-person-identity', body]), 'pullboard-person-identity') }; }
      catch (error) { if (!(error instanceof Refused)) throw error; }
    }
    await handOverBoardKeys(state, key, { send, githubKeys: io.githubKeys, root, identity }, io);
  } catch (error) { if (!(error instanceof Refused)) throw error; io.err(`pullboard: a new device's key request waits: ${error.message}`); }
}
