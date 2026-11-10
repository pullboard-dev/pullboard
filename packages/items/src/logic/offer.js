/** Common exact wire primitives; board identity resolution is always supplied by the consumer [H3,H16]. */
import { Refused } from "../../../kernel/index.js";

/** A wire record has explicit fields, never arbitrary properties or array indices. */
export function exactOfferFields(value, keys, code = 'ITEM_OFFER') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Refused(code, 'use the exact permitted fields and canonical board references');
}
/** Opaque references retain their spelling; the supplied canonical resolver owns identity. */
export function offerReference(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value); }
/** Item ids stay local to the board named beside them. */
export function offerItemId(value) { return Number.isSafeInteger(value) && value > 0; }
/** Stable JSON binds permitted fields independently of a caller's object insertion order. */
export function offerBytes(value) {
  return JSON.stringify(value, (_, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
}
/** Resolve an opaque id through the consumer's single canonical boundary, never through display names. */
export function resolveOfferBoard(id, resolveBoardRef, code = 'ITEM_OFFER') {
  if (!offerReference(id) || typeof resolveBoardRef !== 'function' || resolveBoardRef(id)?.boardId !== id) throw new Refused(code, 'use the exact permitted fields and canonical board references');
}
