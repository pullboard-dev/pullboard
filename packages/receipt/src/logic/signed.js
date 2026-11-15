/** The receipt cell's check of a runner-signed result file: a missing or bad signature is import.invalid, never red [C7]. */
import { createHash } from 'node:crypto';
import { createPublicKey } from 'node:crypto';
import { verify } from 'node:crypto';

const KEY = /^[A-Za-z0-9_-]{59}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;

/**
 * The exact text a runner signs for one result file: the job, shard, tree, digest, base, tooling pin, command and attempt.
 *
 * Why: every field is length-prefixed (`<bytes>:<value>`), so no two field lists concatenate to the same text, and the
 * base, tooling, command and attempt stop a good result being replayed for another attempt, base, pin or command.
 * Any runner can build it with sha256 and an Ed25519 signer; the reference pull runner in transport builds the same.
 *
 * @param {{ job: string, shard: string, tree: string, digest: string, base?: string, tooling?: string, command?: string, attempt?: string | number }} fields
 * @returns {string}
 */
export function resultStatement({ job, shard, tree, digest, base = '', tooling = '', command = '', attempt = '' }) {
  const field = value => `${Buffer.byteLength(String(value))}:${value}`;
  return ['PBSIGNED 2', job, shard, tree, digest, base, tooling, command, attempt].map(field).join('\n');
}

/**
 * The id of a runner key: the sha256 of its SPKI DER bytes, as the runner enrolment already names keys.
 *
 * @param {string} publicKey - The key as base64url SPKI DER.
 * @returns {string}
 */
export function runnerKeyId(publicKey) {
  return createHash('sha256').update(Buffer.from(String(publicKey), 'base64url')).digest('hex');
}

/**
 * Check a posted result file's signature against the runner key the board registered, before any judging.
 *
 * Why (DJ31): the board trusts a verdict from a sandbox it does not trust only through the runner's key, so an
 * unsigned, wrongly signed or key-less result is an infrastructure outcome to rerun, never a red.
 *
 * @param {{ bytes: Buffer, signature?: string, publicKey?: string, job: string, shard: string, tree: string, base?: string, tooling?: string, command?: string, attempt?: string | number }} posted
 * @returns {{ valid: true, digest: string, keyId: string } | { valid: false, outcome: 'infra', code: 'import.invalid', reason: string }}
 */
export function checkSignedResult({ bytes, signature, publicKey, job, shard, tree, base, tooling, command, attempt }) {
  const invalid = reason => ({ valid: false, outcome: 'infra', code: 'import.invalid', reason });
  if (!Buffer.isBuffer(bytes)) return invalid('the result file is missing');
  if (typeof publicKey !== 'string' || !KEY.test(publicKey)) return invalid('the board holds no registered key for this runner');
  if (typeof signature !== 'string' || !signature) return invalid('the result file is unsigned');
  if (!SIGNATURE.test(signature)) return invalid('the result signature is malformed');
  const digest = createHash('sha256').update(bytes).digest('hex');
  let key;
  try { key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' }); }
  catch { return invalid('the registered runner key does not parse'); }
  if (key.asymmetricKeyType !== 'ed25519') return invalid('the registered runner key is not Ed25519');
  const statement = Buffer.from(resultStatement({ job, shard, tree, digest, base, tooling, command, attempt }));
  if (!verify(null, statement, key, Buffer.from(signature, 'base64url'))) return invalid('the result signature does not match the registered runner key');
  return { valid: true, digest, keyId: runnerKeyId(publicKey) };
}
