/**
 * The device-only sealed format (H15, H17), shared unchanged with the browser.
 * Version 1 is one byte, a 12-byte nonce, then ciphertext and its 16-byte GCM tag.
 * Keys never go to the relay. Transport encoding and key storage belong to callers.
 */
import { Refused } from './refused.js';

export const SEAL_VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Return the platform WebCrypto implementation without a Node-specific fallback. */
function crypto() {
  const value = globalThis.crypto;
  if (!value?.subtle || typeof value.getRandomValues !== 'function') {
    throw new Refused('SEAL_CRYPTO', 'WebCrypto is unavailable. Use Node 22 or a secure browser context.');
  }
  return value;
}

/** Copy caller-owned bytes before asynchronous operations can observe a changed buffer. */
function bytes(value, code, message) {
  if (!(value instanceof Uint8Array)) throw new Refused(code, message);
  try {
    return new Uint8Array(value);
  } catch {
    throw new Refused(code, message);
  }
}

/** Validate and copy a raw AES-256 key without including its value in any refusal. */
function keyBytes(value) {
  const key = bytes(value, 'SEAL_KEY', 'A board key must be 32 bytes. Pair this device again.');
  if (key.length !== KEY_BYTES) throw new Refused('SEAL_KEY', 'A board key must be 32 bytes. Pair this device again.');
  return key;
}

/** Canonical, domain-separated associated data binds the header and public position. */
function associatedData(binding, version = SEAL_VERSION) {
  if (!binding || typeof binding.boardId !== 'string' || !binding.boardId.length ||
      binding.boardId.length > 256 || !['snapshot', 'move', 'request'].includes(binding.kind) ||
      !Number.isSafeInteger(binding.sequence) || binding.sequence < 0 || !Number.isInteger(version) || version < 0 || version > 255) {
    throw new Refused('SEAL_BINDING', 'Supply the board id, snapshot/move/request kind and nonnegative safe sequence.');
  }
  return new TextEncoder().encode(JSON.stringify([
    'pullboard-sealed', version, binding.boardId, binding.sequence, binding.kind,
  ]));
}

/** Make a fresh 256-bit board key on the device; callers own its private storage. */
export async function generateBoardKey() {
  const subtle = crypto().subtle;
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  return new Uint8Array(await subtle.exportKey('raw', key));
}

/** Encode a board key as canonical unpadded base64url for a pairing URL fragment. */
export function encodeBoardKey(key) {
  return btoa(String.fromCharCode(...keyBytes(key))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Decode only the canonical 43-character pairing representation, without echoing it. */
export function decodeBoardKey(encoded) {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new Refused('SEAL_KEY', 'The pairing key is invalid. Get a new pairing link from a linked device.');
  }
  const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/') + '=');
  const key = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBoardKey(key) !== encoded) {
    throw new Refused('SEAL_KEY', 'The pairing key is invalid. Get a new pairing link from a linked device.');
  }
  return key;
}

/**
 * Seal bytes with a fresh random 96-bit nonce and a full 128-bit authentication tag.
 * @param {Uint8Array} key - Raw board key, never sent to the relay.
 * @param {Uint8Array} plaintext - The caller's encoded snapshot, move or request.
 * @param {{boardId: string, kind: string, sequence: number}} binding - Public relay position.
 * @returns {Promise<Uint8Array>} Version, nonce, ciphertext and tag; no plaintext metadata.
 */
export async function seal(key, plaintext, binding) {
  const raw = keyBytes(key);
  const plain = bytes(plaintext, 'SEAL_DATA', 'Encode the payload as bytes before sealing it.');
  const additionalData = associatedData(binding, SEAL_VERSION);
  const platform = crypto();
  const iv = platform.getRandomValues(new Uint8Array(NONCE_BYTES));
  const imported = await platform.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await platform.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData, tagLength: 128,
  }, imported, plain));
  const result = new Uint8Array(1 + NONCE_BYTES + ciphertext.length);
  result[0] = SEAL_VERSION;
  result.set(iv, 1);
  result.set(ciphertext, 1 + NONCE_BYTES);
  return result;
}

/**
 * Authenticate before returning plaintext. Wrong keys, altered bytes and wrong positions share
 * one refusal: authentication cannot safely distinguish those causes.
 * @param {Uint8Array} key - This device's raw board key.
 * @param {Uint8Array} sealed - Exactly the sealed-format bytes, after transport decoding.
 * @param {{boardId: string, kind: string, sequence: number}} binding - Expected public position.
 * @returns {Promise<Uint8Array>} Authenticated bytes; callers decode and validate their contents.
 */
export async function unseal(key, sealed, binding) {
  const raw = keyBytes(key);
  const blob = bytes(sealed, 'SEAL_FORMAT', 'The sealed payload must be bytes. Fetch the board again.');
  if (!blob.length) throw new Refused('SEAL_FORMAT', 'The sealed payload is truncated. Fetch the board again.');
  const version = blob[0];
  const additionalData = associatedData(binding, version);
  if (version !== SEAL_VERSION) throw new Refused('SEAL_VERSION', 'This sealed format is unsupported. Upgrade this device.');
  if (blob.length < 1 + NONCE_BYTES + TAG_BYTES) {
    throw new Refused('SEAL_FORMAT', 'The sealed payload is truncated. Fetch the board again.');
  }
  const subtle = crypto().subtle;
  const imported = await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  try {
    return new Uint8Array(await subtle.decrypt({
      name: 'AES-GCM', iv: blob.slice(1, 1 + NONCE_BYTES), additionalData, tagLength: 128,
    }, imported, blob.slice(1 + NONCE_BYTES)));
  } catch {
    throw new Refused('SEAL_AUTH_FAILED', 'The key, payload or board position does not match. Fetch again or pair this device again.');
  }
}
