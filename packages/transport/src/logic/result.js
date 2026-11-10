/** The shard result file every runner adapter writes and every driver reads: one header line, then the output [C7]. */
import { createHash } from 'node:crypto';
import { Refused } from '../../../kernel/light.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HEADER = /^PBRESULT 1 (\d{1,3}) (\d{1,12})\n/u;

/**
 * Refuse a job or shard id that is not a plain name, so no adapter ever turns one into a path outside its folder.
 *
 * @param {{ job: string, shard: string }} ids
 * @returns {{ job: string, shard: string }}
 */
export function shardIds({ job, shard }) {
  if (!ID.test(String(job ?? ''))) throw new Refused('TRANSPORT_SHARD_ID', `job id ${JSON.stringify(job)} is not a plain name; use letters, digits, dot, dash or underscore`);
  if (!ID.test(String(shard ?? ''))) throw new Refused('TRANSPORT_SHARD_ID', `shard id ${JSON.stringify(shard)} is not a plain name; use letters, digits, dot, dash or underscore`);
  return { job, shard };
}

/**
 * The digest that names a result file's exact bytes.
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
export function resultDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Parse a shard's result file. A file that is cut short, padded or malformed, or whose digest is not the one a
 * done step recorded, is import.invalid.
 *
 * @param {Buffer} bytes - The whole result file.
 * @param {string} [expected] - The recorded digest, when there is one.
 * @returns {{ valid: true, status: number, output: Buffer, digest: string } | { valid: false, reason: string, digest: string }}
 */
export function parseResult(bytes, expected) {
  const digest = resultDigest(bytes);
  if (expected && expected !== digest) return { valid: false, digest, reason: `digest ${digest.slice(0, 12)} is not the recorded ${String(expected).slice(0, 12)}` };
  const head = HEADER.exec(bytes.subarray(0, 64).toString('latin1'));
  if (!head) return { valid: false, digest, reason: 'the result header is missing or malformed' };
  const length = Number(head[2]), output = bytes.subarray(head[0].length);
  if (output.length !== length) return { valid: false, digest, reason: `the result holds ${output.length} output bytes, not the ${length} its header names` };
  return { valid: true, status: Number(head[1]), output, digest };
}
