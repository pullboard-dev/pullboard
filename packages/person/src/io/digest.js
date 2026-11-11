/** The digest that binds a person request's executor receipt to its exact serialized intent [H12,H16]. */
import { createHash } from 'node:crypto';

/**
 * Bind a person request's durable executor receipt to its exact serialized intent.
 *
 * @param {{ encoded: string }} record - The durable request record.
 * @returns {string} The hex SHA-256 of the encoded intent.
 */
export function requestIntentDigest(record) {
  return createHash('sha256').update(record.encoded).digest('hex');
}
