import { createHash } from 'node:crypto';
import { createPublicKey } from 'node:crypto';
import { sign } from 'node:crypto';
import { verify } from 'node:crypto';

/**
 * A refused bundle: the same shape as the kernel's Refused (a rule code, then the next step).
 * Why: the doctrine cell may not import the kernel for one class, and this file's cross-cell ceiling is zero [C7].
 */
class Refused extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = 'Refused';
    this.code = code;
  }
}

/** A public key as base64 of its DER spki bytes, the form a rule board lists its authorized keys in [C7]. */
function keyText(publicKey) {
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

/**
 * Sign canonical bundle bytes with an ed25519 private key, returning one signature entry.
 * Why: the signature covers the bytes themselves, so any changed byte invalidates it [C7].
 * @param {string} bytes - Canonical bundle bytes from encodeBundle.
 * @param {import('node:crypto').KeyObject} privateKey
 * @returns {{ key: string, signature: string }}
 */
export function signBundle(bytes, privateKey) {
  return {
    key: keyText(createPublicKey(privateKey)),
    signature: sign(null, Buffer.from(bytes, 'utf8'), privateKey).toString('base64'),
  };
}

/**
 * Verify a rule bundle offline against the rule board's authorized keys; returns its digest.
 * Why: a child board must trust a bundle with no network, so the only inputs are the bytes, their signatures and the
 * key list the rule board authorized. Refuses BUNDLE_UNSIGNED (no signature), BUNDLE_BYTES_CHANGED (digest or signature
 * does not match the bytes) and BUNDLE_WRONG_ISSUER (signed by a key the rule board did not authorize) [C7].
 * @param {{ bytes: string, digest?: string, signatures?: Array<{ key: string, signature: string }> }} bundle
 * @param {string[]} authorizedKeys - Base64 DER spki public keys.
 * @returns {{ digest: string, issuer: string }}
 */
export function verifyBundle(bundle, authorizedKeys) {
  const { bytes, digest, signatures } = bundle ?? {};
  if (!Array.isArray(signatures) || signatures.length === 0) {
    throw new Refused('BUNDLE_UNSIGNED', 'the rule bundle carries no signature; ask the rule board to sign and send it again');
  }
  const actual = createHash('sha256').update(String(bytes), 'utf8').digest('hex');
  if (digest !== undefined && digest !== actual) {
    throw new Refused('BUNDLE_BYTES_CHANGED', 'the rule bundle bytes do not match their digest; fetch the bundle from the rule board again');
  }
  const authorized = new Set(authorizedKeys);
  for (const { key, signature } of signatures) {
    let valid = false;
    try {
      valid = verify(null, Buffer.from(bytes, 'utf8'), createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }), Buffer.from(signature, 'base64'));
    } catch { valid = false; }
    if (!valid) throw new Refused('BUNDLE_BYTES_CHANGED', 'the rule bundle signature does not match its bytes; fetch the bundle from the rule board again');
    if (authorized.has(key)) return { digest: actual, issuer: key };
  }
  throw new Refused('BUNDLE_WRONG_ISSUER', 'the rule bundle is signed by a key the rule board did not authorize; ask the rule board to sign it with an authorized key');
}
