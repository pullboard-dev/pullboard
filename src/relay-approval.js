/** Client-only encrypted phone approval and RAM-only native replies [H5,H16,H17,B26]. */
import { devicePublicKey } from './relay-device-keys.js';
import { Refused } from './refused.js';

const encoder = new TextEncoder();
const FIELDS = ['id', 'account', 'publisher', 'board', 'device', 'action', 'target', 'machine', 'command', 'expires'];

/** Canonically bind an opaque approval to the exact command the paired phone will display. */
export function approvalContext(value) {
  if (!value || Object.keys(value).some(key => !FIELDS.includes(key)) ||
      !/^[A-Za-z0-9_-]{1,80}$/u.test(value.id ?? '') || !/^[0-9a-f]{32}$/u.test(value.publisher ?? '') ||
      !/^[0-9a-f]{32}$/u.test(value.board ?? '') || !/^device-[0-9a-f]{32}$/u.test(value.device ?? '') ||
      !['link', 'revoke-device', 'revoke-token', 'delete-board'].includes(value.action) || !Number.isSafeInteger(value.expires) || value.expires < 1 ||
      ['account', 'target', 'machine', 'command'].some(key => typeof value[key] !== 'string' || !value[key] || value[key].length > 256 || /[\u0000-\u001f\u007f]/u.test(value[key])) ||
      value.action === 'link' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.target) ||
      value.action === 'revoke-device' && !/^device-[0-9a-f]{32}$/u.test(value.target) ||
      value.action === 'revoke-token' && !/^[A-Za-z0-9_-]{1,128}$/u.test(value.target) ||
      value.action === 'delete-board' && value.target !== value.board ||
      value.action !== 'link' && value.board !== value.publisher) {
    throw new Refused('PHONE_APPROVAL_CONTEXT', 'Request approval for the exact board, action, machine and command.');
  }
  return Object.fromEntries(FIELDS.map(key => [key, value[key]]));
}

/** Encode bounded ciphertext without a Node dependency so the same protocol runs on the phone. */
function encode(value) {
  return btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** Decode canonical transport bytes without accepting an oversized approval envelope. */
function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,24000}$/u.test(value)) throw new Refused('PHONE_APPROVAL_AUTH', 'Request a fresh phone approval.');
  let result;
  try { result = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0)); }
  catch { throw new Refused('PHONE_APPROVAL_AUTH', 'Request a fresh phone approval.'); }
  if (encode(result) !== value) throw new Refused('PHONE_APPROVAL_AUTH', 'Request a fresh phone approval.');
  return result;
}

/** Authenticate a proposal with the already paired board key, preventing relay-created native intent. */
export async function signApprovalIntent(boardKey, envelope) {
  if (!(boardKey instanceof Uint8Array) || boardKey.length !== 32) throw new Refused('PHONE_APPROVAL_AUTH', 'Pair this publishing board on the phone first.');
  const key = await crypto.subtle.importKey('raw', boardKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify(['pullboard-phone-intent-v1', envelope])))));
}

/** Check a native proposal before showing its approval button; unknown boards never receive a grant. */
export async function verifyApprovalIntent(boardKey, packet) {
  try {
    if (!(boardKey instanceof Uint8Array) || boardKey.length !== 32) throw new Error('key');
    const key = await crypto.subtle.importKey('raw', boardKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('HMAC', key, decode(packet.mac), encoder.encode(JSON.stringify(['pullboard-phone-intent-v1', packet.envelope])))) throw new Error('mac');
    return packet.envelope;
  } catch { throw new Refused('PHONE_APPROVAL_AUTH', 'The native request could not be authenticated by its paired board.'); }
}

/** Create a nonextractable reply key unless this is an explicitly durable, non-person link request. */
export async function createApprovalReply({ link = false } = {}) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, link, ['deriveBits']);
  return { privateKey: pair.privateKey, publicKey: devicePublicKey(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    ...(link ? { storedKey: await crypto.subtle.exportKey('jwk', pair.privateKey) } : {}) };
}

/** Restore only a non-person link request's reply key; native person actions never call this path. */
export async function restoreLinkReply(value) {
  try { return await crypto.subtle.importKey('jwk', value, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']); }
  catch { throw new Refused('PHONE_APPROVAL_AUTH', 'Cancel the expired link request and ask the phone to link this board again.'); }
}

/** Derive a separate key for each intent/reply and immutable context, outside the board-key domain. */
async function approvalKey(privateKey, publicKey, ephemeral, context, direction, usage) {
  const peer = await crypto.subtle.importKey('jwk', devicePublicKey(publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(JSON.stringify(devicePublicKey(ephemeral))),
    info: encoder.encode(JSON.stringify(['pullboard-phone-approval-v1', direction, context])) }, material,
  { name: 'AES-GCM', length: 256 }, false, [usage]);
}

/** Encrypt a bounded intent or reply to a locally trusted key, authenticated with its exact context. */
export async function sealApproval(value, publicKey, binding, direction) {
  const context = approvalContext(binding);
  if (!['intent', 'reply'].includes(direction)) throw new Refused('PHONE_APPROVAL_CONTEXT', 'Use the intent or reply approval domain.');
  const plain = encoder.encode(JSON.stringify(value));
  if (plain.length > 16000) throw new Refused('PHONE_APPROVAL_CONTEXT', 'Keep the phone approval smaller than 16 KiB.');
  const pair = await createApprovalReply();
  const derived = await approvalKey(pair.privateKey, publicKey, pair.publicKey, context, direction, 'encrypt');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
    additionalData: encoder.encode(JSON.stringify(['pullboard-phone-approval', 1, direction, context])), tagLength: 128 }, derived, plain));
  return { v: 1, direction, context, ephemeral: pair.publicKey, nonce: encode(nonce), ciphertext: encode(ciphertext) };
}

/** Authenticate before decoding, refusing changed action metadata or another request's encrypted grant. */
export async function openApproval(privateKey, envelope, binding, direction) {
  const context = approvalContext(binding);
  try {
    if (!envelope || envelope.v !== 1 || envelope.direction !== direction || !['intent', 'reply'].includes(direction) ||
        JSON.stringify(approvalContext(envelope.context)) !== JSON.stringify(context)) throw new Error('context');
    const nonce = decode(envelope.nonce);
    if (nonce.length !== 12) throw new Error('nonce');
    const derived = await approvalKey(privateKey, envelope.ephemeral, envelope.ephemeral, context, direction, 'decrypt');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce,
      additionalData: encoder.encode(JSON.stringify(['pullboard-phone-approval', 1, direction, context])), tagLength: 128 }, derived, decode(envelope.ciphertext));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } catch { throw new Refused('PHONE_APPROVAL_AUTH', 'The phone approval could not be authenticated for this exact action. Request approval again.'); }
}
