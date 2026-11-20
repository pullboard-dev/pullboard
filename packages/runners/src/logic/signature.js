/** Keep runner result signatures bound to their enrolled Ed25519 key and exact receipt bytes [C7]. */
import { createHash } from 'node:crypto';
import { createPrivateKey } from 'node:crypto';
import { createPublicKey } from 'node:crypto';
import { sign } from 'node:crypto';
import { verify } from 'node:crypto';
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../fs/index.js';

const fs = fileSystemAdapter();

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Reject any enrolled runner key except a canonical Ed25519 SPKI public key. */
export function runnerPublicKeyProblem(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{59}$/u.test(value)) return 'runner public key must be an Ed25519 SPKI key';
  let der;
  try { der = Buffer.from(value, 'base64url'); } catch { return 'runner public key must be an Ed25519 SPKI key'; }
  if (der.length !== 44 || der.toString('base64url') !== value || !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return 'runner public key must be an Ed25519 SPKI key';
  }
  return '';
}

/** Derive a private-key path that is stable for this enrolled key and safe as one filename. */
export function runnerSigningKeyPath(machineHome, publicKey) {
  const problem = runnerPublicKeyProblem(publicKey);
  if (problem) throw new TypeError(problem);
  const id = createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex');
  return join(machineHome, `runner-signing-${id}.pem`);
}

/** Read only the owner-private key matching one pinned public key; private material never enters the request. */
export function readRunnerSigningKey(machineHome, publicKey) {
  const path = runnerSigningKeyPath(machineHome, publicKey);
  const entry = fs.lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0
    || typeof process.getuid === 'function' && entry.uid !== process.getuid() || entry.size > 4096) {
    throw new Error('runner signing key is not an owner-only regular file');
  }
  const key = createPrivateKey(fs.readFile(path, null));
  const actual = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64url');
  if (actual !== publicKey) throw new Error('runner signing key does not match the enrolled public key');
  return key;
}

/** Serialize a receipt without its signature while preserving the runner's original property order. */
export function runnerReceiptPayload(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new TypeError('runner receipt must be an object');
  return Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'signature'))));
}

/** Sign one complete runner receipt with the private key held by that runner. */
export function signRunnerReceipt(receipt, privateKey) {
  return sign(null, runnerReceiptPayload(receipt), privateKey).toString('base64url');
}

/** Verify the exact result receipt against the public key pinned by runner add. */
export function verifyRunnerReceipt(receipt, publicKey) {
  if (runnerPublicKeyProblem(publicKey) || typeof receipt?.signature !== 'string'
    || !/^[A-Za-z0-9_-]{86}$/u.test(receipt.signature)) return false;
  const signature = Buffer.from(receipt.signature, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== receipt.signature) return false;
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
  return verify(null, runnerReceiptPayload(receipt), key, signature);
}
