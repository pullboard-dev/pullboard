/**
 * WebAuthn passkeys for signed person moves, verified with node:crypto alone [E22,H16].
 *
 * A passkey signs only after its authenticator sees the person (Face ID, Touch ID or a security-key touch), which
 * is the user-presence flag the relay requires on every registration and assertion. Why the relay checks it: an
 * agent can read every file and key its user's shell can, but it cannot make an authenticator report a person.
 */
import {
  createHash,
  createPublicKey,
  verify,
} from 'node:crypto';
import { Refused } from '../../../../packages/kernel/index.js';

const USER_PRESENT = 0x01;
const ATTESTED = 0x40;
export const PASSKEY_ALGORITHMS = Object.freeze([-7, -257]);

/** SHA-256 bytes of a value. */
function sha256(value) { return createHash('sha256').update(value).digest(); }

/** Decode canonical base64url transport bytes, refusing anything else with the given code. */
export function passkeyBytes(value, code = 'PASSKEY_ASSERTION', max = 16_384) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length > max) throw passkeyRefusal(code);
  const bytes = Buffer.from(value, 'base64url');
  if (!bytes.length || bytes.toString('base64url') !== value) throw passkeyRefusal(code);
  return bytes;
}

/** A passkey refusal with its next step. */
function passkeyRefusal(code) {
  const why = {
    PASSKEY_REGISTRATION: 'the passkey registration could not be verified; add the passkey again from this browser',
    PASSKEY_ASSERTION: 'the passkey answer does not match this request; confirm it again on your passkey',
    PASSKEY_PRESENCE: 'the passkey answered without a person present; confirm with Face ID, Touch ID or a key touch',
  }[code];
  return new Refused(code, why);
}

/**
 * Read the small CBOR subset a COSE public key uses: unsigned and negative integers, byte strings and one map.
 *
 * @param {Buffer} bytes
 * @param {number} offset
 * @returns {{ value: any, end: number }}
 */
function cbor(bytes, offset) {
  if (offset >= bytes.length) throw passkeyRefusal('PASSKEY_REGISTRATION');
  const major = bytes[offset] >> 5;
  const info = bytes[offset] & 31;
  let length = info;
  let at = offset + 1;
  if (info === 24) { length = bytes[at]; at += 1; }
  else if (info === 25) { length = bytes.readUInt16BE(at); at += 2; }
  else if (info > 25) throw passkeyRefusal('PASSKEY_REGISTRATION');
  if (major === 0) return { value: length, end: at };
  if (major === 1) return { value: -1 - length, end: at };
  if (major === 2) {
    if (at + length > bytes.length) throw passkeyRefusal('PASSKEY_REGISTRATION');
    return { value: bytes.subarray(at, at + length), end: at + length };
  }
  if (major === 5) {
    const map = new Map();
    for (let index = 0; index < length; index += 1) {
      const key = cbor(bytes, at);
      const item = cbor(bytes, key.end);
      map.set(key.value, item.value);
      at = item.end;
    }
    return { value: map, end: at };
  }
  throw passkeyRefusal('PASSKEY_REGISTRATION');
}

/** Turn a COSE ES256 or RS256 key into a JWK node:crypto can verify with, with its algorithm. */
function coseKey(map) {
  const algorithm = map.get(3);
  if (algorithm === -7 && map.get(1) === 2 && map.get(-1) === 1 && map.get(-2)?.length === 32 && map.get(-3)?.length === 32) {
    return { algorithm, jwk: { kty: 'EC', crv: 'P-256', x: map.get(-2).toString('base64url'), y: map.get(-3).toString('base64url') } };
  }
  if (algorithm === -257 && map.get(1) === 3 && Buffer.isBuffer(map.get(-1)) && Buffer.isBuffer(map.get(-2))) {
    return { algorithm, jwk: { kty: 'RSA', n: map.get(-1).toString('base64url'), e: map.get(-2).toString('base64url') } };
  }
  throw passkeyRefusal('PASSKEY_REGISTRATION');
}

/** Split authenticator data into its RP id hash, flags, counter and any attested credential. */
function authenticatorData(bytes, code) {
  if (bytes.length < 37) throw passkeyRefusal(code);
  return { rpIdHash: bytes.subarray(0, 32), flags: bytes[32], counter: bytes.readUInt32BE(33), rest: bytes.subarray(37) };
}

/** Check client data for this ceremony, challenge and origin. */
function clientData(encoded, type, challenge, origin, code) {
  const bytes = passkeyBytes(encoded, code);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw passkeyRefusal(code); }
  if (value?.type !== type || value.challenge !== challenge || value.origin !== origin || value.crossOrigin === true) throw passkeyRefusal(code);
  return bytes;
}

/**
 * Verify a registration made in a browser on this relay's origin, with the person present. Returns the credential
 * id, its public key as a JWK, its algorithm and its starting counter.
 *
 * @param {{ id: string, clientDataJSON: string, authenticatorData: string }} body
 * @param {{ challenge: string, origin: string, rpId: string }} expected
 */
export function verifyRegistration(body, { challenge, origin, rpId }) {
  clientData(body.clientDataJSON, 'webauthn.create', challenge, origin, 'PASSKEY_REGISTRATION');
  const data = authenticatorData(passkeyBytes(body.authenticatorData, 'PASSKEY_REGISTRATION'), 'PASSKEY_REGISTRATION');
  if (!data.rpIdHash.equals(sha256(rpId)) || !(data.flags & ATTESTED)) throw passkeyRefusal('PASSKEY_REGISTRATION');
  if (!(data.flags & USER_PRESENT)) throw passkeyRefusal('PASSKEY_PRESENCE');
  if (data.rest.length < 18) throw passkeyRefusal('PASSKEY_REGISTRATION');
  const length = data.rest.readUInt16BE(16);
  const id = data.rest.subarray(18, 18 + length);
  if (id.length !== length || !length || id.toString('base64url') !== body.id) throw passkeyRefusal('PASSKEY_REGISTRATION');
  const key = coseKey(cbor(data.rest, 18 + length).value);
  createPublicKey({ key: key.jwk, format: 'jwk' });
  return { id: body.id, ...key, counter: data.counter };
}

/**
 * Verify an assertion from a registered passkey over this challenge, on this origin, with the person present.
 * Returns the authenticator's new counter; a counter that does not rise, when either side counts, is refused.
 *
 * @param {{ clientDataJSON: string, authenticatorData: string, signature: string }} body
 * @param {{ challenge: string, origin: string, rpId: string, passkey: { jwk: any, algorithm: number, counter: number } }} expected
 */
export function verifyAssertion(body, { challenge, origin, rpId, passkey }) {
  const client = clientData(body.clientDataJSON, 'webauthn.get', challenge, origin, 'PASSKEY_ASSERTION');
  const raw = passkeyBytes(body.authenticatorData);
  const data = authenticatorData(raw, 'PASSKEY_ASSERTION');
  if (!data.rpIdHash.equals(sha256(rpId))) throw passkeyRefusal('PASSKEY_ASSERTION');
  const key = createPublicKey({ key: passkey.jwk, format: 'jwk' });
  const signed = Buffer.concat([raw, sha256(client)]);
  if (!verify('sha256', signed, key, passkeyBytes(body.signature))) throw passkeyRefusal('PASSKEY_ASSERTION');
  if (!(data.flags & USER_PRESENT)) throw passkeyRefusal('PASSKEY_PRESENCE');
  if ((data.counter || passkey.counter) && data.counter <= passkey.counter) throw passkeyRefusal('PASSKEY_ASSERTION');
  return data.counter;
}

/** The WebAuthn challenge for a person grant: SHA-256 of the grant, so the bearer grant never reaches an authenticator. */
export function grantChallenge(grant) {
  return sha256(grant).toString('base64url');
}
