/** Verify client-held person roots without trusting relay identity assertions [H15]. */
import { Refused } from "../../../kernel/light.js";

const encoder = new TextEncoder();

/** Encode protocol bytes canonically in browsers and Node. */
function encode(bytes) { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, ''); }

/** Refuse noncanonical or incorrectly sized transport bytes. */
function decode(value, length) {
  try {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
    const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
    if (bytes.length !== length || encode(bytes) !== value) throw new Error();
    return bytes;
  } catch { throw new Refused('PERSON_ENROLL_AUTH', 'Use a fresh person-authenticated enrollment with canonical public fields.'); }
}

/** Copy only the public coordinates of a P-256 key for person-held roots and the device-key front door. */
export function devicePublicKey(value) {
  if (!value || value.kty !== 'EC' || value.crv !== 'P-256' || value.d !== undefined ||
      Object.keys(value).some(key => !['kty', 'crv', 'x', 'y', 'ext', 'key_ops'].includes(key))) {
    throw new Refused('DEVICE_KEY', 'Pair a device with a public ECDH P-256 key.');
  }
  try { decode(value.x, 32); decode(value.y, 32); }
  catch { throw new Refused('DEVICE_FORMAT', 'Use a fresh device pairing link.'); }
  return { kty: 'EC', crv: 'P-256', x: value.x, y: value.y };
}

/** Accept stable numeric account identifiers rather than mutable login names. */
function account(value) { return typeof value === 'string' && /^[1-9][0-9]{0,19}$/u.test(value); }

/** Normalize only the signed fields, never a relay-provided trust root or private key. */
export function personEnrollmentBody(value) {
  try {
    if (!value || Object.keys(value).some(k => !['v', 'account', 'device', 'publicKey', 'origin', 'nonce', 'expires', 'grants', 'signature'].includes(k)) ||
        value.v !== 1 || !account(value.account) || !/^device-[0-9a-f]{32}$/u.test(value.device ?? '') ||
        !Number.isSafeInteger(value.expires) || value.expires <= 0 || !Array.isArray(value.grants) ||
        value.grants.length < 1 || value.grants.length > 32 || value.grants.some(b => !/^[0-9a-f]{32}$/u.test(b)) ||
        new Set(value.grants).size !== value.grants.length) throw new Error();
    const origin = new URL(value.origin);
    if (origin.origin !== value.origin || origin.username || origin.password ||
        !(origin.protocol === 'https:' || origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) throw new Error();
    decode(value.nonce, 32);
    return { v: 1, account: value.account, device: value.device, publicKey: devicePublicKey(value.publicKey),
      origin: value.origin, nonce: value.nonce, expires: value.expires, grants: [...value.grants] };
  } catch { throw new Refused('PERSON_ENROLL_AUTH', 'Use a fresh person-authenticated enrollment with the exact account, device and grants.'); }
}

/** Domain-separate signatures from pairing, key wraps and other account actions. */
function signedBytes(body) { return encoder.encode(JSON.stringify(['pullboard-person-enrollment', body])); }

/** Generate the independent person root; credential unlock and recovery UI are separate work. */
export async function createPersonRoot() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  return { privateKey: pair.privateKey, publicKey: devicePublicKey(await crypto.subtle.exportKey('jwk', pair.publicKey)) };
}

/** Sign only with an already unlocked client-held root, never a relay session token. */
export async function signPersonEnrollment(privateKey, value) {
  const body = personEnrollmentBody(value);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, signedBytes(body));
  return { ...body, signature: encode(new Uint8Array(signature)) };
}

/** Authenticate against a caller-pinned root and trusted current context before wrapping. */
export async function authenticatePersonEnrollment(trustedRoot, value, expected) {
  const body = personEnrollmentBody(value);
  if (expected?.revoked) throw new Refused('PERSON_ENROLL_REVOKED', 'Use a non-revoked person enrollment.');
  if (!Number.isSafeInteger(expected?.now) || body.expires <= expected.now || body.expires > expected.now + 600_000) {
    throw new Refused('PERSON_ENROLL_EXPIRED', 'Create a fresh person-authenticated challenge valid for at most ten minutes.');
  }
  try {
    if (body.account !== expected.account || body.origin !== expected.origin || body.nonce !== expected.nonce ||
        JSON.stringify(body.grants) !== JSON.stringify(expected.grants)) throw new Error();
    const key = await crypto.subtle.importKey('jwk', devicePublicKey(trustedRoot), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decode(value.signature, 64), signedBytes(body))) throw new Error();
    await crypto.subtle.importKey('jwk', body.publicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return body;
  } catch { throw new Refused('PERSON_ENROLL_AUTH', 'The person signature or trusted enrollment context changed; authenticate a fresh challenge.'); }
}

/** Require an exact versioned account-vault binding; historical contexts never silently migrate. */
function envelopeContext(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'account,keyId,revision' || !account(value.account) ||
      typeof value.keyId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(value.keyId) || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new Refused('PERSON_ENVELOPE_AUTH', 'Use the exact account, key id and positive vault revision.');
  }
  return { account: value.account, keyId: value.keyId, revision: value.revision };
}

/** Derive a purpose-specific vault key from independently retained 256-bit person material. */
async function envelopeKey(secret, salt, context, usage) {
  if (!(secret instanceof Uint8Array) || secret.length !== 32) throw new Error('256-bit person material required');
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt,
    info: encoder.encode(JSON.stringify(['pullboard-person-vault-key', context])) }, material,
  { name: 'AES-GCM', length: 256 }, false, [usage]);
}

/** Seal a 32-byte vault key; this format supplies no browser credential or lost-key recovery. */
export async function sealAccountEnvelope(secret, vaultKey, value) {
  const context = envelopeContext(value);
  try {
    if (!(vaultKey instanceof Uint8Array) || vaultKey.length !== 32) throw new Error();
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await envelopeKey(secret, salt, context, 'encrypt');
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
      additionalData: encoder.encode(JSON.stringify(['pullboard-account-envelope', 1, context])) }, key, vaultKey);
    return { v: 1, ...context, salt: encode(salt), nonce: encode(nonce), ciphertext: encode(new Uint8Array(ciphertext)) };
  } catch { throw new Refused('PERSON_ENVELOPE_AUTH', 'Seal the vault key with independently retained 256-bit person material.'); }
}

/** Open only with independently retained material and the caller's exact expected context. */
export async function openAccountEnvelope(secret, envelope, expected) {
  const context = envelopeContext(expected);
  try {
    if (!envelope || Object.keys(envelope).sort().join(',') !== 'account,ciphertext,keyId,nonce,revision,salt,v' ||
        envelope.v !== 1 || envelope.account !== context.account || envelope.keyId !== context.keyId || envelope.revision !== context.revision) throw new Error();
    const key = await envelopeKey(secret, decode(envelope.salt, 32), context, 'decrypt');
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(envelope.nonce, 12),
      additionalData: encoder.encode(JSON.stringify(['pullboard-account-envelope', 1, context])) }, key, decode(envelope.ciphertext, 48)));
  } catch { throw new Refused('PERSON_ENVELOPE_AUTH', 'The account envelope or recovery material does not match; use the original person-held material.'); }
}
