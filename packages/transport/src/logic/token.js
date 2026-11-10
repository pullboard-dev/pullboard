/** Short-lived pull job tokens: scoped to one job and one runner, signed by the board, never board write access [C7]. */
import { createHmac } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import { Refused } from '../../../kernel/light.js';

/** The board's HMAC over a token body. */
function mac(secret, body) {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/**
 * Mint a token that lets one runner fetch one job's bundle, heartbeat it and post its results until it expires.
 *
 * Why (DJ35): a sandbox holds only this, so losing it leaks one job's bundle for minutes, never the board.
 *
 * @param {{ job: string, runner: string, tree: string, secret: Buffer | string, now: number, ttlMs: number }} fields
 * @returns {string}
 */
export function mintJobToken({ job, runner, tree, secret, now, ttlMs }) {
  const body = Buffer.from(JSON.stringify({ v: 1, job, runner, tree, until: now + ttlMs })).toString('base64url');
  return `${body}.${mac(secret, body)}`;
}

/**
 * Read a job token back, refusing one the board did not mint or one past its expiry.
 *
 * @param {string} token
 * @param {{ secret: Buffer | string, now: number }} options
 * @returns {{ job: string, runner: string, tree: string, until: number }}
 */
export function readJobToken(token, { secret, now }) {
  const [body, given, extra] = String(token ?? '').split('.');
  if (!body || !given || extra !== undefined) throw new Refused('PULL_TOKEN', 'the job token is missing or malformed; take the job again for a fresh token');
  const want = Buffer.from(mac(secret, body)), got = Buffer.from(given);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new Refused('PULL_TOKEN', 'the job token was not minted by this board; take the job again');
  let fields;
  try { fields = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { throw new Refused('PULL_TOKEN', 'the job token body does not parse; take the job again'); }
  if (fields?.v !== 1 || typeof fields.job !== 'string' || typeof fields.runner !== 'string') throw new Refused('PULL_TOKEN', 'the job token names no job; take the job again');
  if (!(now < fields.until)) throw new Refused('PULL_TOKEN_EXPIRED', `the token for job ${fields.job} expired; take the job again`);
  return { job: fields.job, runner: fields.runner, tree: fields.tree, until: fields.until };
}
