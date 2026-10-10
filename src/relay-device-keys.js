/** Authenticate device enrollment and wrap board keys only on clients [H5,H15,H17]. */
import { Refused } from './refused.js';

const encoder = new TextEncoder();
const DEVICE = /^device-[0-9a-f]{32}$/u;
const BOARD = /^[0-9a-f]{32}$/u;
const LOCATOR = /^[A-Za-z0-9_-]{22}$/u;

/** Encode transport bytes canonically without relying on a Node-only Buffer. */
function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** Refuse malformed or noncanonical bytes without echoing a secret. */
function decode(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Refused('DEVICE_FORMAT', 'Use a fresh device pairing link.');
  let bytes;
  try {
    bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), character => character.charCodeAt(0));
  } catch { throw new Refused('DEVICE_FORMAT', 'Use a fresh device pairing link.'); }
  if (bytes.length !== length || encode(bytes) !== value) throw new Refused('DEVICE_FORMAT', 'Use a fresh device pairing link.');
  return bytes;
}

/** Require browser or Node WebCrypto; no private key is exported as a fallback. */
function platform() {
  if (!globalThis.crypto?.subtle) throw new Refused('DEVICE_CRYPTO', 'Use Node 22 or a secure browser with WebCrypto.');
  return globalThis.crypto;
}

/** Copy only the public coordinates of a P-256 key, rejecting a supplied private half. */
export function devicePublicKey(value) {
  if (!value || value.kty !== 'EC' || value.crv !== 'P-256' || value.d !== undefined ||
      Object.keys(value).some(key => !['kty', 'crv', 'x', 'y', 'ext', 'key_ops'].includes(key))) {
    throw new Refused('DEVICE_KEY', 'Pair a device with a public ECDH P-256 key.');
  }
  decode(value.x, 32);
  decode(value.y, 32);
  return { kty: 'EC', crv: 'P-256', x: value.x, y: value.y };
}

/** Make a persistent non-extractable private device key for IndexedDB storage. */
export async function createDeviceKeys() {
  const crypto = platform();
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { deviceId: 'device-' + [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join(''),
    privateKey: pair.privateKey, publicKey: devicePublicKey(await crypto.subtle.exportKey('jwk', pair.publicKey)) };
}

/** Bind the exact public key and account to one short-lived pairing locator. */
function enrollment(value) {
  if (!value || value.v !== 1 || !DEVICE.test(value.deviceId ?? '') || !LOCATOR.test(value.locator ?? '') ||
      typeof value.account !== 'string' || !value.account || value.account.length > 128 ||
      typeof value.label !== 'string' || !value.label.trim() || value.label.length > 80 || /[\u0000-\u001f\u007f]/u.test(value.label) ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Refused('DEVICE_ENROLLMENT', 'Create a fresh one-time device pairing link.');
  }
  decode(value.locator, 16);
  return { v: 1, account: value.account, locator: value.locator, deviceId: value.deviceId,
    publicKey: devicePublicKey(value.publicKey), label: value.label, createdAt: value.createdAt };
}

/** Serialize an enrollment in one fixed field order for its authenticated MAC. */
function enrollmentBytes(value) {
  return encoder.encode(JSON.stringify(['pullboard-device-enroll', 1, value.account, value.locator,
    value.deviceId, value.publicKey, value.label, value.createdAt]));
}

/** Derive a domain-separated HMAC key from the QR-only secret and enrollment context. */
async function enrollmentKey(secret, value) {
  if (typeof secret !== 'string' && !(secret instanceof Uint8Array)) throw new Refused('DEVICE_PAIR_SECRET', 'Use the one-time secret from the pairing QR fragment.');
  const bytes = typeof secret === 'string' ? decode(secret, 32) : new Uint8Array(secret);
  if (bytes.length !== 32) throw new Refused('DEVICE_PAIR_SECRET', 'Use the one-time secret from the pairing QR fragment.');
  const subtle = platform().subtle;
  const material = await subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
  return await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: decode(value.locator, 16),
    info: encoder.encode(JSON.stringify(['pullboard-device-auth', 1, value.account, value.locator])) },
  material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
}

/** Sign a phone's enrollment locally; the relay receives the public key and MAC, never the secret. */
export async function signDeviceEnrollment(secret, value) {
  const body = enrollment(value);
  const key = await enrollmentKey(secret, body);
  return { ...body, mac: encode(new Uint8Array(await platform().subtle.sign('HMAC', key, enrollmentBytes(body)))) };
}

/** Authenticate the relay-carried enrollment before the Mac records a device or wraps any key. */
export async function authenticateDeviceEnrollment(secret, value, expected) {
  const body = enrollment(value);
  if (body.account !== expected.account || body.locator !== expected.locator) {
    throw new Refused('DEVICE_ENROLL_AUTH', 'The pairing account or locator changed. Create a fresh pairing link.');
  }
  const mac = decode(value.mac, 32);
  const key = await enrollmentKey(secret, body);
  if (!await platform().subtle.verify('HMAC', key, mac, enrollmentBytes(body))) {
    throw new Refused('DEVICE_ENROLL_AUTH', 'The device public key was changed or the pairing secret is wrong. Create a fresh pairing link.');
  }
  try { await platform().subtle.importKey('jwk', body.publicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []); }
  catch { throw new Refused('DEVICE_KEY', 'Pair again with a valid ECDH P-256 public key.'); }
  return { deviceId: body.deviceId, publicKey: body.publicKey,
    fingerprint: [...new Uint8Array(await platform().subtle.digest('SHA-256', encoder.encode(JSON.stringify(body.publicKey))))]
      .map(byte => byte.toString(16).padStart(2, '0')).join(''), label: body.label, createdAt: body.createdAt };
}

/** Validate the expected board, device and engine instead of trusting a relay envelope's context. */
function binding(value) {
  if (!value || !BOARD.test(value.board ?? '') || !DEVICE.test(value.device ?? '') ||
      !Number.isSafeInteger(value.engine) || value.engine < 1) {
    throw new Refused('DEVICE_WRAP_BINDING', 'Name the linked board, paired device and supported engine version.');
  }
  return { board: value.board, device: value.device, engine: value.engine };
}

/** Derive one AES key with the ephemeral public key as salt and board/device-specific HKDF info. */
async function wrappingKey(privateKey, publicKey, ephemeral, context, usages) {
  const subtle = platform().subtle;
  const peer = await subtle.importKey('jwk', devicePublicKey(publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const salt = await subtle.exportKey('raw', await subtle.importKey('jwk', devicePublicKey(ephemeral), { name: 'ECDH', namedCurve: 'P-256' }, true, []));
  return await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt,
    info: encoder.encode(JSON.stringify(['pullboard-wrap-v1', context.board, context.device])) },
  material, { name: 'AES-GCM', length: 256 }, false, usages);
}

/** Bind the versioned wrap to the expected device, board and executable engine. */
function wrapAAD(context) {
  return encoder.encode(JSON.stringify(['pullboard-device-wrap', 1, context.board, context.device, context.engine]));
}

/** Wrap a board key to a locally trusted public key; roster selection belongs to the native caller. */
export async function wrapDeviceBoardKey(key, publicKey, value) {
  const context = binding(value);
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new Refused('DEVICE_WRAP_KEY', 'Use this linked board’s 32-byte device-only key.');
  const raw = new Uint8Array(key);
  const recipient = devicePublicKey(publicKey);
  const crypto = platform();
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const ephemeral = devicePublicKey(await crypto.subtle.exportKey('jwk', pair.publicKey));
  let derived;
  try { derived = await wrappingKey(pair.privateKey, recipient, ephemeral, context, ['encrypt']); }
  catch { throw new Refused('DEVICE_KEY', 'Pair again with a valid ECDH P-256 public key.'); }
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: wrapAAD(context), tagLength: 128 }, derived, raw);
  return { v: 1, ...context, ephemeral, nonce: encode(nonce), ciphertext: encode(new Uint8Array(ciphertext)) };
}

/** Unwrap only with the phone's stored private key and caller-supplied expected context. */
export async function unwrapDeviceBoardKey(privateKey, envelope, expected) {
  const context = binding(expected);
  if (!envelope || envelope.v !== 1 || envelope.board !== context.board || envelope.device !== context.device || envelope.engine !== context.engine) {
    throw new Refused('DEVICE_WRAP_AUTH', 'The wrapped board key belongs to another device or board. Pair again.');
  }
  try {
    const derived = await wrappingKey(privateKey, envelope.ephemeral, envelope.ephemeral, context, ['decrypt']);
    return new Uint8Array(await platform().subtle.decrypt({ name: 'AES-GCM', iv: decode(envelope.nonce, 12),
      additionalData: wrapAAD(context), tagLength: 128 }, derived, decode(envelope.ciphertext, 48)));
  } catch { throw new Refused('DEVICE_WRAP_AUTH', 'The wrapped board key could not be authenticated. Pair again.'); }
}
