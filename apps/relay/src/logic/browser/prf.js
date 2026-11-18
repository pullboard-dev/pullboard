/** Read the passkey PRF secret from a credential's extension results, exactly 32 bytes [H5,#11075]. */
import { Refused } from '../../../../../packages/kernel/index.js';

const PRF_BYTES = 32;

/**
 * The 32 PRF output bytes from `credential.getClientExtensionResults()`.
 *
 * Why exactly 32: the sealed key is derived from it, and a short or long output means the
 * authenticator did not do what the pairing assumes. Returns a copy so the caller cannot alias the credential's buffer.
 *
 * @param {object} credentialResult - The object `getClientExtensionResults()` returned.
 * @returns {Uint8Array} A copy of `prf.results.first`.
 */
export function prfOutput(credentialResult) {
  const first = credentialResult?.prf?.results?.first;
  if (first === undefined || first === null) {
    throw new Refused('PRF_MISSING', 'This passkey did not return a PRF secret. Use a passkey that supports it.');
  }
  const bytes = first instanceof ArrayBuffer ? new Uint8Array(first) : ArrayBuffer.isView(first) ? new Uint8Array(first.buffer, first.byteOffset, first.byteLength) : null;
  if (bytes === null || bytes.byteLength !== PRF_BYTES) {
    throw new Refused('PRF_LENGTH', `The passkey secret must be exactly ${PRF_BYTES} bytes. Use a different passkey.`);
  }
  return new Uint8Array(bytes);
}
