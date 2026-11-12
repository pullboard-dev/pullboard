/** Shared offer contracts; orchestration supplies canonical board resolution and authority [B2,H3,H16]. */
import { createHash } from 'node:crypto';
import { Refused } from "../../../kernel/index.js";
import {
  exactOfferFields,
  offerReference,
  offerItemId,
  offerBytes,
  resolveOfferBoard,
} from "../logic/offer.js";
export { minimalItemReceipt, verifyItemReceipt } from "./receipt.js";

const FIELDS = ['version', 'offerId', 'sourceBoardId', 'parentItem', 'destinationBoardId', 'proposedContent', 'disposition', 'childRef', 'reason'];
const STATE = FIELDS.filter(key => key !== 'proposedContent');

/** Refuse a malformed contract before a callback can observe or act on it. */
function refuse(code = 'ITEM_OFFER') { throw new Refused(code, 'use the exact item-offer contract and its canonical board references; refresh the offer before retrying'); }
/** Bind exact wire content without retaining its private text in the retry ledger. */
function digest(value) { return createHash('sha256').update(offerBytes(value)).digest('hex'); }
/** Validate an offer or its separate content-free state announcement. */
function validate(value, stateOnly = false) {
  exactOfferFields(value, stateOnly ? STATE : FIELDS);
  if (value.version !== 1 || !offerReference(value.offerId) || !offerReference(value.sourceBoardId)
      || !offerReference(value.destinationBoardId) || value.sourceBoardId === value.destinationBoardId || !offerItemId(value.parentItem)) refuse();
  if (!stateOnly) {
    const content = value.proposedContent, allowed = ['lane', 'title', 'criterion', 'specIds', 'brief', 'route', 'check'];
    if (!content || typeof content !== 'object' || Array.isArray(content) || Object.keys(content).some(key => !allowed.includes(key))
        || !offerReference(content.lane) || typeof content.title !== 'string' || !content.title.trim()
        || ['criterion', 'brief', 'route', 'check'].some(key => Object.hasOwn(content, key) && typeof content[key] !== 'string')
        || Object.hasOwn(content, 'specIds') && (!Array.isArray(content.specIds) || content.specIds.some(id => !offerReference(id)))) refuse();
  }
  if (value.disposition === 'accepted') {
    exactOfferFields(value.childRef, ['boardId', 'item']);
    if (value.childRef.boardId !== value.destinationBoardId || !offerItemId(value.childRef.item) || value.reason !== null) refuse();
  } else if (value.disposition === 'declined') {
    if (value.childRef !== null || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 2048) refuse();
  } else if (value.disposition !== 'pending' || value.childRef !== null || value.reason !== null) refuse();
  return structuredClone(value);
}
/** Only the explicitly disclosed proposal reaches the recipient; state replication uses another shape. */
export function itemOfferAnnouncement(value) {
  const offer = validate(value);
  return Object.fromEntries(STATE.map(key => [key, offer[key]]));
}
/** Resolve both boards and require the consumer's authenticated authority for this exact action. */
function authorize(board, value, ports, action, local) {
  if (ports?.boardId !== value[local] || ports.readBoardId(board) !== ports.boardId) refuse('OFFER_AUTHORITY');
  resolveOfferBoard(value.sourceBoardId, ports.resolveBoardRef);
  resolveOfferBoard(value.destinationBoardId, ports.resolveBoardRef);
  if (typeof ports.authorize !== 'function' || ports.authorize({ action, boardId: ports.boardId, document: structuredClone(value) }) !== true) refuse('OFFER_AUTHORITY');
}
/** The destination's transaction serializes simultaneous deliveries of the same source offer. */
function key(sourceBoardId, offerId) { return `item_offer:${digest([sourceBoardId, offerId])}`; }
/** Read the durable state-only result; the ledger never contains proposed item text. */
export function readItemOffer(board, sourceBoardId, offerId) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key(sourceBoardId, offerId));
  return row ? JSON.parse(row.meta_value).result : null;
}
/** Persist one immutable result inside the caller's transaction. */
function save(board, offer, binding, result) {
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(key(offer.sourceBoardId, offer.offerId), JSON.stringify({ binding, result }));
}
/** Create a child and its idempotency result together, or decline without creating anything. */
function decide(board, input, ports, disposition, reason = null) {
  const offer = validate(input);
  if (offer.disposition !== 'pending') refuse();
  return ports.atomic(board, () => {
    authorize(board, offer, ports, disposition, 'destinationBoardId');
    const binding = digest(offer), row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key(offer.sourceBoardId, offer.offerId));
    if (row) {
      const saved = JSON.parse(row.meta_value);
      if (saved.binding !== binding || saved.result.disposition !== disposition || saved.result.reason !== reason) refuse('OFFER_CONFLICT');
      return { ...offer, ...saved.result };
    }
    let childRef = null;
    if (disposition === 'accepted') {
      if (typeof ports.createChild !== 'function') refuse();
      const item = ports.createChild(structuredClone(offer.proposedContent));
      if (!offerItemId(item) || !ports.itemById(board, item)) refuse();
      childRef = { boardId: ports.boardId, item };
    }
    const result = validate({ ...offer, disposition, reason, childRef });
    save(board, offer, binding, itemOfferAnnouncement(result));
    return result;
  });
}
/** The synchronous child port must create on this same SQLite board, under the consumer's ordered move. */
export function acceptItemOffer(board, offer, ports) { return decide(board, offer, ports, 'accepted'); }
/** The resulting state announcement carries the decline reason to both boards by retryable delivery. */
export function declineItemOffer(board, offer, reason, ports) { return decide(board, offer, ports, 'declined', reason); }
/** Record an authenticated destination result at its source; this is not a two-board transaction. */
export function recordItemOfferResult(board, input, ports) {
  const result = validate(input, true);
  if (result.disposition === 'pending') refuse();
  return ports.atomic(board, () => {
    authorize(board, result, ports, 'receive-result', 'sourceBoardId');
    const saved = readItemOffer(board, result.sourceBoardId, result.offerId);
    if (saved && offerBytes(saved) !== offerBytes(result)) refuse('OFFER_CONFLICT');
    if (!saved) save(board, result, null, result);
    return result;
  });
}
