import { createCipheriv } from 'node:crypto';
import { createECDH } from 'node:crypto';
import { hkdfSync } from 'node:crypto';
import { randomBytes } from 'node:crypto';

/** Bytes of the record size field's default: one record holds a whole notification payload [C7]. */
const RECORD_SIZE = 4096;

/** Web Push (RFC 8291) caps a payload at 3993 bytes; this refuses anything longer than one record can carry. */
const MAX_PAYLOAD = RECORD_SIZE - 16 - 1;

/** Decode a base64url string to bytes. */
function fromBase64Url(text) {
  return Buffer.from(String(text), 'base64url');
}

/**
 * Encrypt a Web Push payload for one subscription with the aes128gcm content coding of RFC 8291 and RFC 8188 [C7].
 * Pure: node:crypto only, and the salt and sender key may be given so a caller can fix them; unset, both are random.
 * Why: the relay may hold a notification only as sealed bytes, so the payload is encrypted to the paired phone's own key.
 * @param {Buffer|string} payload - The bytes to deliver.
 * @param {{ p256dh: string, auth: string }} subscriptionKeys - The subscriber's public key (65-byte uncompressed P-256) and 16-byte auth secret, base64url.
 * @param {{ salt?: Buffer, senderKey?: import('node:crypto').ECDH }} [options]
 * @returns {Buffer} The request body: salt, record size, sender key id, then the encrypted record.
 */
export function encryptPush(payload, subscriptionKeys, options = {}) {
  const plain = Buffer.from(payload);
  const subscriber = fromBase64Url(subscriptionKeys?.p256dh);
  const authSecret = fromBase64Url(subscriptionKeys?.auth);
  if (subscriber.length !== 65 || subscriber[0] !== 4) throw new TypeError('the subscription p256dh key must be a 65-byte uncompressed P-256 point');
  if (authSecret.length !== 16) throw new TypeError('the subscription auth secret must be 16 bytes');
  if (plain.length > MAX_PAYLOAD) throw new RangeError(`a push payload holds at most ${MAX_PAYLOAD} bytes`);
  const sender = options.senderKey ?? createECDH('prime256v1');
  if (!options.senderKey) sender.generateKeys();
  const senderPublic = sender.getPublicKey();
  const salt = options.salt ?? randomBytes(16);
  const shared = sender.computeSecret(subscriber);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), subscriber, senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = senderPublic.length;
  return Buffer.concat([header, senderPublic, record]);
}
