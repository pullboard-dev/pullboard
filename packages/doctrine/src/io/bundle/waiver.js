import {
  createPublicKey,
  sign,
  verify,
} from 'node:crypto';

/**
 * A refused waiver: the same shape as the kernel's Refused (a rule code, then the next step).
 * Why: the doctrine cell may not import the kernel for one class, as in verify.js [C7].
 */
class Refused extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = 'Refused';
    this.code = code;
  }
}

/** The fixed-order bytes a waiver's signature covers: every field it binds, so changing any one voids it [C7]. */
function waiverBytes({ issuer, rule, revision, scope, reason, expires }) {
  return JSON.stringify({ issuer, rule, revision, scope, reason, expires });
}

/**
 * Sign a scoped waiver: it binds the issuer, one rule, one revision, one child scope, a reason and an expiry.
 * @param {{ rule: string, revision: number, scope: string, reason: string, expires: string }} fields expires is an ISO time
 * @param {import('node:crypto').KeyObject} privateKey ed25519 key
 * @returns {{ issuer: string, rule: string, revision: number, scope: string, reason: string, expires: string, signature: string }}
 */
export function signWaiver(fields, privateKey) {
  const issuer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
  const bound = { issuer, rule: fields.rule, revision: fields.revision, scope: fields.scope, reason: fields.reason, expires: fields.expires };
  return { ...bound, signature: sign(null, Buffer.from(waiverBytes(bound), 'utf8'), privateKey).toString('base64') };
}

/**
 * Whether a waiver permits exactly one rule at one revision in one child scope.
 * Why: an unsigned, forged or unauthorized waiver and an expired one grant nothing, and refuse by name; a waiver
 * for another rule, revision or scope is a valid waiver that simply permits nothing here (false). The expiry is read
 * from the injected clock, never the wall clock, so the answer is replayable [C7].
 * @param {any} waiver
 * @param {{ rule: string, revision: number, scope: string }} wanted what the caller wants waived
 * @param {{ authorizedKeys: string[], now: () => number }} context the rule board's keys and an injected clock in epoch ms
 * @returns {boolean}
 */
export function waiverPermits(waiver, wanted, { authorizedKeys, now }) {
  const unsigned = () => new Refused('BUNDLE_WAIVER_UNSIGNED', 'the waiver is not signed by an authorized key; ask the rule board to sign it and send it again');
  if (!waiver || typeof waiver.signature !== 'string' || !waiver.signature || typeof waiver.issuer !== 'string') throw unsigned();
  let valid = false;
  try {
    valid = verify(null, Buffer.from(waiverBytes(waiver), 'utf8'),
      createPublicKey({ key: Buffer.from(waiver.issuer, 'base64'), format: 'der', type: 'spki' }), Buffer.from(waiver.signature, 'base64'));
  } catch { valid = false; }
  if (!valid || !authorizedKeys.includes(waiver.issuer)) throw unsigned();
  const expires = Date.parse(waiver.expires);
  if (!Number.isFinite(expires) || now() >= expires) {
    throw new Refused('BUNDLE_WAIVER_EXPIRED', 'the waiver has expired; ask the rule board for a new waiver with a later expiry');
  }
  return waiver.rule === wanted.rule && waiver.revision === wanted.revision && waiver.scope === wanted.scope;
}
