/** Sign the VAPID token a Web Push request carries, so the push service knows which sender it serves [C7]. */
import { loadSigningAdapter } from '../../../../../packages/keys/index.js';

/** The real signing adapter, loaded once: the token is signed through the keys cell, never node:crypto directly [C7,#1428]. */
const signing = (await loadSigningAdapter()).createSigningAdapter();

/** Push services refuse a token valid for more than 24 hours; this stays well inside it. */
const TOKEN_LIFETIME_SECONDS = 12 * 60 * 60 - 60;

/** Base64url without padding, as the JWT form requires. */
function encode(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}

/**
 * Build the ES256 token for a push endpoint: audience is the endpoint's origin, expiry is just under 12 hours out,
 * and the subject names who to contact about the traffic.
 *
 * @param {string} endpointOrigin - The push endpoint URL; only its origin enters the token.
 * @param {string} subject - A mailto: or https: contact for the sender.
 * @param {string | import('node:crypto').KeyObject} key - The sender's P-256 private key, as PEM or a key object.
 * @param {number} [now] - Milliseconds since the epoch.
 * @param {{ signWith: (options: { algorithm: string, privateKey: string }, text: string) => string }} [adapter] - The signing adapter; the real one by default.
 * @returns {string} The signed JWT, three base64url parts.
 */
export function vapidAuth(endpointOrigin, subject, key, now = Date.now(), adapter = signing) {
  const claims = { aud: new URL(endpointOrigin).origin, exp: Math.floor(now / 1000) + TOKEN_LIFETIME_SECONDS, sub: subject };
  const signed = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode(claims)}`;
  const privateKey = typeof key === 'string' ? key : key.export({ type: 'pkcs8', format: 'pem' });
  return `${signed}.${adapter.signWith({ algorithm: 'ES256', privateKey }, signed)}`;
}
