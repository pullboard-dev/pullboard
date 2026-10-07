/** Client-side one-time pairing envelope; the relay sees only locator-bound ciphertext [H15,H17]. */
import { randomBytes, webcrypto } from 'node:crypto';
import { Refused } from './refused.js';

const LOCATOR = /^[A-Za-z0-9_-]{22}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_PACKAGE_BYTES = 14_000_000;

/** Refuse noncanonical unpadded base64url instead of accepting aliases for a pairing secret. */
function decode(encoded, bytes, code, next) {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Refused(code, next);
  const value = Buffer.from(encoded, 'base64url');
  if ((bytes !== undefined && value.length !== bytes) || value.toString('base64url') !== encoded) throw new Refused(code, next);
  return new Uint8Array(value);
}

/** Generate a random locator and independent 256-bit secret; only the locator is sent to the relay. */
export function createPairingCode(board) {
  if (typeof board !== 'string' || !/^[0-9a-f]{32}$/.test(board)) throw new Refused('BAD_BOARD', 'use this board’s persistent identifier before creating a pairing code');
  const locator = randomBytes(16).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  return { board, locator, secret, code: board + '.' + locator + '.' + secret };
}

/** Parse a human pairing code without including any supplied part in a refusal. */
export function parsePairingCode(code) {
  if (typeof code !== 'string') throw new Refused('PAIR_CODE_INVALID', 'use the full one-time code printed by the linked device');
  const parts = code.split('.');
  if (parts.length !== 3 || !/^[0-9a-f]{32}$/.test(parts[0]) || !LOCATOR.test(parts[1]) || !SECRET.test(parts[2])) {
    throw new Refused('PAIR_CODE_INVALID', 'use the full one-time code printed by the linked device');
  }
  return { board: parts[0], locator: parts[1], secret: decode(parts[2], 32, 'PAIR_CODE_INVALID', 'use the full one-time code printed by the linked device') };
}

/** Validate a native v1 board snapshot and pairing metadata before sealing or installing it. */
function validateBundle(value) {
  const fields = ['version', 'board', 'url', 'repository', 'mode', 'sequence', 'cursor', 'key', 'snapshot'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort()) || value.version !== 1 ||
      typeof value.board !== 'string' || !/^[0-9a-f]{32}$/.test(value.board) ||
      typeof value.url !== 'string' || typeof value.repository !== 'string' || !REPOSITORY.test(value.repository) ||
      !['mirror', 'ordered'].includes(value.mode) ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !Number.isSafeInteger(value.cursor) || value.cursor < 0 ||
      typeof value.key !== 'string' || !KEY.test(value.key) ||
      !value.snapshot || typeof value.snapshot !== 'object' || Array.isArray(value.snapshot) ||
      value.snapshot.version !== 1 || !value.snapshot.tables || typeof value.snapshot.tables !== 'object' || Array.isArray(value.snapshot.tables)) {
    throw new Refused('PAIR_PACKAGE', 'the encrypted pairing package is not a supported board link; create a new code on the linked device');
  }
  const metadata = value.snapshot.tables.board_meta;
  const events = value.snapshot.tables.event;
  if (!Array.isArray(metadata) || !Array.isArray(events) ||
      metadata.filter((row) => row?.meta_key === 'board_id').length !== 1 ||
      metadata.find((row) => row?.meta_key === 'board_id')?.meta_value !== value.board ||
      !Number.isSafeInteger(events.at(-1)?.event_id ?? 0) || (events.at(-1)?.event_id ?? 0) !== value.cursor) {
    throw new Refused('PAIR_PACKAGE', 'the encrypted pairing snapshot does not match its board identity and local cursor; create a fresh code');
  }
  const meta = new Map(metadata.map((row) => [row?.meta_key, row?.meta_value]));
  const hasApplied = meta.has('relay_applied_sequence');
  const hasEngine = meta.has('relay_engine_version');
  if (hasApplied !== hasEngine || (value.mode === 'ordered' && (!hasApplied || meta.get('relay_engine_version') !== '1' ||
      !Number.isSafeInteger(Number(meta.get('relay_applied_sequence'))) || String(Number(meta.get('relay_applied_sequence'))) !== meta.get('relay_applied_sequence') ||
      Number(meta.get('relay_applied_sequence')) !== value.sequence)) || (value.mode === 'mirror' && hasApplied)) {
    throw new Refused('PAIR_PACKAGE', 'the encrypted relay checkpoint does not match its ordering mode; create a fresh code after sync');
  }
  let origin;
  try { origin = new URL(value.url); } catch { throw new Refused('PAIR_PACKAGE', 'the encrypted pairing package has an invalid relay origin; create a new code'); }
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) {
    throw new Refused('PAIR_PACKAGE', 'the encrypted pairing package has an invalid relay origin; create a new code');
  }
  decode(value.key, 32, 'PAIR_PACKAGE', 'the encrypted pairing package has an invalid board key; create a new code');
  return value;
}

/** Bind a native local export and board key to the one-time code before upload to the relay. */
export async function sealPairingBundle(code, bundle) {
  const { board, locator, secret } = parsePairingCode(code);
  const value = validateBundle(bundle);
  if (value.board !== board) throw new Refused('PAIR_PACKAGE', 'the pairing code belongs to another board; create a new code on this device');
  const iv = randomBytes(12);
  const key = await webcrypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt']);
  const aad = new TextEncoder().encode(JSON.stringify(['pullboard-pairing', 1, locator]));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  if (plaintext.length > MAX_PACKAGE_BYTES) throw new Refused('PAIR_PACKAGE_SIZE', 'this board export is too large for one-time pairing; use a smaller local board export before trying again');
  const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext));
  return Buffer.concat([iv, ciphertext]).toString('base64url');
}

/** Authenticate and validate a relayed pairing envelope using only the human-held secret. */
export async function openPairingBundle(code, sealed) {
  const { board, locator, secret } = parsePairingCode(code);
  const blob = decode(sealed, undefined, 'PAIR_CODE_INVALID', 'the one-time code is invalid or already used; ask the linked device for a new code');
  if (blob.length < 12 + 16) throw new Refused('PAIR_CODE_INVALID', 'the one-time code is invalid or already used; ask the linked device for a new code');
  const key = await webcrypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['decrypt']);
  const aad = new TextEncoder().encode(JSON.stringify(['pullboard-pairing', 1, locator]));
  let plaintext;
  try { plaintext = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12), additionalData: aad, tagLength: 128 }, key, blob.slice(12)); }
  catch { throw new Refused('PAIR_CODE_INVALID', 'the one-time code is invalid or already used; ask the linked device for a new code'); }
  let value;
  if (plaintext.byteLength > MAX_PACKAGE_BYTES) throw new Refused('PAIR_PACKAGE_SIZE', 'the encrypted board export exceeds the pairing limit; ask the linked device for a smaller package');
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)); }
  catch { throw new Refused('PAIR_PACKAGE', 'the encrypted pairing package is invalid; ask the linked device for a new code'); }
  const bundle = validateBundle(value);
  if (bundle.board !== board) throw new Refused('PAIR_PACKAGE', 'the encrypted package is for another board; ask for a fresh one-time code');
  return bundle;
}
