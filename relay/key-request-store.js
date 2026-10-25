/** Short-lived board-key requests from a member's new device; the relay never sees a board key [E17,H15]. */
import { randomBytes } from 'node:crypto';
import { Refused } from '../src/refused.js';

const TEN_MINUTES = 10 * 60_000;
const MAX_REQUESTS = 1_000;
const MAX_PER_BOARD = 20;
const BOARD = /^[0-9a-f]{32}$/u;
const ID = /^[A-Za-z0-9_-]{22}$/u;
const DEVICE = /^device-[0-9a-f]{32}$/u;
const B64 = /^[A-Za-z0-9_-]{43}$/u;
const ARMOR = /^-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\n]{40,4000}\n-----END SSH SIGNATURE-----\n?$/u;

/**
 * Check the exact statement a new device signed: its board, repository, device key and the GitHub login the
 * relay authenticated. The relay checks shape and identity only; member devices check the SSH signature.
 */
export function keyRequestStatement(value) {
  const fields = ['v', 'board', 'repository', 'device', 'publicKey', 'login', 'engine', 'expires'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== [...fields].sort().join()
      || value.v !== 1 || !BOARD.test(value.board ?? '') || typeof value.repository !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(value.repository)
      || !DEVICE.test(value.device ?? '') || typeof value.login !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(value.login)
      || !Number.isSafeInteger(value.engine) || value.engine < 1 || !Number.isSafeInteger(value.expires) || value.expires < 1
      || !value.publicKey || typeof value.publicKey !== 'object' || Object.keys(value.publicKey).sort().join() !== 'crv,kty,x,y'
      || value.publicKey.kty !== 'EC' || value.publicKey.crv !== 'P-256' || !B64.test(value.publicKey.x ?? '') || !B64.test(value.publicKey.y ?? '')) {
    throw new Refused('KEY_REQUEST', 'send the exact signed device-key statement; run pullboard relay on again in the clone');
  }
  return { v: 1, board: value.board, repository: value.repository, device: value.device,
    publicKey: { kty: 'EC', crv: 'P-256', x: value.publicKey.x, y: value.publicKey.y }, login: value.login, engine: value.engine, expires: value.expires };
}

/** Accept only an armored OpenSSH signature of bounded size. */
function armored(value) {
  if (typeof value !== 'string' || !ARMOR.test(value)) throw new Refused('KEY_REQUEST', 'sign the device key with ssh-keygen -Y sign; run pullboard relay on again in the clone');
  return value;
}

/** Accept a member's wrap as opaque base64url text, or a member's named refusal. */
function answer(value) {
  if (value && Object.keys(value).join() === 'wrapped' && typeof value.wrapped === 'string' && /^[A-Za-z0-9_-]{40,4000}$/u.test(value.wrapped)) return { wrapped: value.wrapped };
  if (value && Object.keys(value).join() === 'refused' && value.refused && typeof value.refused.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(value.refused.code)
      && typeof value.refused.message === 'string' && value.refused.message.length <= 500) return { refused: { code: value.refused.code, message: value.refused.message } };
  throw new Refused('KEY_REQUEST', 'answer a key request with the wrapped key or a named refusal');
}

/** Keep each request for at most ten minutes in memory; a restart only makes the new device ask again. */
export function createKeyRequestStore({ now = Date.now } = {}) {
  const records = new Map();

  /** Drop expired requests before any read or write. */
  function prune(at) {
    for (const [id, record] of records) if (at >= record.statement.expires) records.delete(id);
  }

  return Object.freeze({
    /** Record a new device's signed statement for the person the relay authenticated. */
    publish(board, body, who) {
      const at = now();
      prune(at);
      if (!body || Object.keys(body).sort().join() !== 'signature,statement') throw new Refused('KEY_REQUEST', 'send only the signed statement and its SSH signature');
      const statement = keyRequestStatement(body.statement);
      const signature = armored(body.signature);
      if (statement.board !== board) throw new Refused('KEY_REQUEST', 'the statement names another board; run pullboard relay on again in the clone');
      if (statement.login !== who.user.login) throw new Refused('KEY_REQUEST_PERSON', 'sign the statement as the GitHub account you signed in with');
      if (statement.expires <= at || statement.expires > at + TEN_MINUTES) throw new Refused('KEY_REQUEST_EXPIRED', 'make a statement valid for at most ten minutes; run pullboard relay on again');
      if (records.size >= MAX_REQUESTS || [...records.values()].filter(record => record.board === board).length >= MAX_PER_BOARD) {
        throw new Refused('KEY_REQUEST_BUSY', 'too many devices are waiting for this board; retry once one is handed its key');
      }
      const id = randomBytes(16).toString('base64url').slice(0, 22);
      records.set(id, { id, board, statement, signature, userId: who.user.id, login: who.user.login });
      return { id, expiresIn: Math.floor((statement.expires - at) / 1000) };
    },
    /** List the requests still waiting on a board, for its member devices to check and answer. */
    waiting(board) {
      prune(now());
      return [...records.values()].filter(record => record.board === board && !record.answer)
        .map(({ id, statement, signature, login }) => ({ id, statement, signature, login }));
    },
    /** Count waiting requests, so a member's ordinary sync learns of them without another call. */
    count(board) { return this.waiting(board).length; },
    /** Take a member device's answer once; the first answer wins. */
    answer(board, id, body) {
      prune(now());
      const record = ID.test(id ?? '') ? records.get(id) : undefined;
      if (!record || record.board !== board) throw new Refused('KEY_REQUEST_UNKNOWN', 'this key request expired or was answered; the new device asks again');
      if (record.answer) throw new Refused('KEY_REQUEST_ANSWERED', 'another member device already answered this request');
      record.answer = answer(body);
      return { answered: id };
    },
    /** Return the answer to the person who asked, once, and forget the request. */
    read(board, id, who) {
      prune(now());
      const record = ID.test(id ?? '') ? records.get(id) : undefined;
      if (!record || record.board !== board || record.userId !== who.user.id) throw new Refused('KEY_REQUEST_UNKNOWN', 'this key request expired; run pullboard relay on again in the clone');
      if (!record.answer) return { state: 'waiting' };
      records.delete(id);
      return record.answer.wrapped ? { state: 'delivered', wrapped: record.answer.wrapped } : { state: 'refused', refused: record.answer.refused };
    },
  });
}
