/** The relay's signed passkey stamp on a person request, shared by the relay that signs it and the boards that check it [E22,H16]. */
import {
  createPublicKey,
  verify,
} from 'node:crypto';

/** The exact bytes the relay signs when it stamps a passkey-confirmed request; every board verifies the same bytes. */
export function presenceAttestation({ board, request, digest, credential, at }) {
  return Buffer.from(JSON.stringify(['pullboard-person-presence', 1, board, request, digest, credential, at]));
}

/**
 * Whether a stamp carries the relay's Ed25519 signature under the pinned public key (base64url DER SPKI).
 * Why a signature and not the stamp alone: board files are the user's to edit, so only a key no local process holds
 * tells a stamp the relay made from one written into the board by hand.
 *
 * @param {{ board: string, request: string, digest: string, credential: string, at: number, signature: string }} stamp
 * @param {string} publicKey
 */
export function presenceSigned(stamp, publicKey) {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' && verify(null, presenceAttestation(stamp), key, Buffer.from(stamp.signature, 'base64url'));
  } catch { return false; } // An unreadable key or signature verifies nothing; the caller fails closed.
}

/**
 * The relay's passkey stamp on a person request: the board, the request id and intent digest it was granted for,
 * the passkey, when, and the relay's signature over them [E22].
 */
export function validPresence(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === 'at,board,credential,digest,request,signature' &&
    typeof value.request === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(value.request) && typeof value.credential === 'string' &&
    /^[A-Za-z0-9_-]{1,1400}$/u.test(value.credential) && Number.isSafeInteger(value.at) && value.at > 0 &&
    /^[0-9a-f]{32}$/u.test(value.board ?? '') && /^[0-9a-f]{64}$/u.test(value.digest ?? '') && /^[A-Za-z0-9_-]{86}$/u.test(value.signature ?? ''));
}
