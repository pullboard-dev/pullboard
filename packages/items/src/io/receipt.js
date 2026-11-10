/** Minimal private-landing receipts contain integrity-bound references, never item prose [H3,H16]. */
import { createHash } from 'node:crypto';
import {
  exactOfferFields,
  offerBytes,
  offerItemId,
  offerReference,
  resolveOfferBoard,
} from "../logic/offer.js";
import { Refused } from "../../../kernel/index.js";
const FIELDS = ['version', 'sourceBoardId', 'item', 'commit', 'verifier', 'verdict'];
/** Refuse malformed, mismatched or unauthenticated private receipts before a consumer can apply them. */
function refuse() { throw new Refused('ITEM_RECEIPT', 'use the exact minimal receipt from the source board and verify its source, item, commit and verdict binding'); }
/** Validate permitted references without copying any title, criterion or note into the envelope. */
function fields(value) {
  exactOfferFields(value, FIELDS, 'ITEM_RECEIPT');
  if (value.version !== 1 || !offerReference(value.sourceBoardId) || !offerItemId(value.item)
      || typeof value.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.commit)
      || !offerReference(value.verifier) || !offerReference(value.verdict)) refuse();
  return structuredClone(value);
}
/** Sign canonical permitted bytes through the source authority port; a digest alone is not authority. */
export function minimalItemReceipt(input, { sign } = {}) {
  const value = fields(input), bytes = offerBytes(value);
  if (typeof sign !== 'function') refuse();
  const signature = sign(bytes);
  if (typeof signature !== 'string' || !signature || signature.length > 16384) refuse();
  return { ...value, integrity: { digest: createHash('sha256').update(bytes).digest('hex'), signature } };
}
/** Match the consumer's exact expected identity and verify against its established source trust port. */
export function verifyItemReceipt(input, { resolveBoardRef, verify } = {}, expected) {
  exactOfferFields(input, [...FIELDS, 'integrity'], 'ITEM_RECEIPT');
  const { integrity, ...rest } = input, value = fields(rest), wanted = fields(expected);
  exactOfferFields(integrity, ['digest', 'signature'], 'ITEM_RECEIPT');
  resolveOfferBoard(value.sourceBoardId, resolveBoardRef, 'ITEM_RECEIPT');
  const bytes = offerBytes(value), digest = createHash('sha256').update(bytes).digest('hex');
  if (offerBytes(value) !== offerBytes(wanted) || integrity.digest !== digest || typeof integrity.signature !== 'string'
      || !integrity.signature || integrity.signature.length > 16384 || typeof verify !== 'function'
      || verify(bytes, integrity.signature, value.sourceBoardId) !== true) refuse();
  return true;
}
