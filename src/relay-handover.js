/** A member's new device gets its board key from an online member device, vouched by an SSH key on GitHub [E17]. */
import {
  createDeviceKeys,
  unwrapDeviceBoardKey,
  wrapDeviceBoardKey,
} from './relay-device-keys.js';
import { ENGINE_VERSION } from './machine.js';
import { Refused } from './refused.js';
import {
  signSshVouch,
  verifySshVouch,
} from './relay-ssh-proof.js';
import {
  authorizeMember,
  memberAuthorityStamp,
} from './relay-membership.js';
import { boardId } from './board-query.js';
import { readBoardMembers } from './board-members.js';
import { localRecords } from './relay.js';

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
function currentMembers(root, state) {
  if (typeof root !== 'string' || !root) {
    throw new Refused('RELAY_NOT_MEMBER', 'open the linked repository before handing over its board key');
  }
  return localRecords(root, board => {
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
      const document = currentMembers(root, state);
      const authority = memberAuthorityStamp(root, document);
      await authorizeMember(root, state, document, entry.login, { githubKeys, identity });
      const wrapped = await wrapDeviceBoardKey(key, statement.publicKey, { board: state.board, device: statement.device, engine: statement.engine });
      // GitHub and WebCrypto yield: a local revocation or accepted-policy change must win before publication.
      if (authority !== memberAuthorityStamp(root, currentMembers(root, state))) {
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

/** The public SSH keys on a GitHub account, read from GitHub itself so the relay cannot add one. */
export async function githubKeys(login) {
  const base = new URL(process.env.PULLBOARD_GITHUB_API || 'https://api.github.com');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) {
    throw new Refused('GITHUB_UNAVAILABLE', 'PULLBOARD_GITHUB_API must be an HTTPS address, or loopback HTTP for tests');
  }
  let keys;
  try {
    const response = await fetch(new URL('users/' + encodeURIComponent(login) + '/keys', base.href.endsWith('/') ? base : base.href + '/'),
      { headers: { accept: 'application/vnd.github+json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) }); // budget: one GitHub read, the same ceiling as a relay request.
    if (!response.ok) throw new Error(String(response.status));
    keys = await response.json();
  } catch { throw new Refused('GITHUB_UNAVAILABLE', `could not read ${login}'s SSH keys from GitHub; the key request waits for the next command`); }
  return (Array.isArray(keys) ? keys : []).map(entry => entry?.key).filter(key => typeof key === 'string' && /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+$/u.test(key));
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
    await handOverBoardKeys(state, key, { send, githubKeys, root, identity }, io);
  } catch (error) { if (!(error instanceof Refused)) throw error; io.err(`pullboard: a new device's key request waits: ${error.message}`); }
}
