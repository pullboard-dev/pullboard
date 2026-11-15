/** Read-only native companion inputs stay outside the writer and person import graphs [C7,V4,H16]. */
import { createHash } from 'node:crypto';
import { itemPatchRecords } from "../../logic/patch/records.js";
export { itemPatchRecords, itemPatches } from "../../logic/patch/records.js";
/** Hash canonical native metadata identically on every replica. */
function hash(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
/** Canonical composition digest ignores presentation fields and retains native author identity. */
export function itemPatchSetDigest(commit, patches) {
  return hash(JSON.stringify({ commit, patches: patches.map(({ key, commit: source, digest, author }) => ({ key, commit: source, digest,
    author: { agentId: author.agentId, parentSession: author.parentSession, session: author.session } })) }));
}
/** No-history legacy items have no new digest; a removed set still has an explicit digest. */
export function itemPatchDigest(board, id, source = null) {
  const history = itemPatchRecords(board, id);
  if (!history.length) return null;
  const item = board.db.prepare('SELECT item_status,item_commit,item_claim_head FROM item WHERE item_id=?').get(id);
  const base = source ?? (item?.item_status === 'claimed' ? history.find(record => record.active)?.commit ?? item.item_commit ?? item.item_claim_head : item?.item_commit);
  return itemPatchSetDigest(base, history.filter(record => record.active));
}
/** Removed patches retain all recorded author identities for independent-review checks. */
export function itemPatchAuthors(board, id) {
  const unique = new Map(itemPatchRecords(board, id).map(record => [JSON.stringify(record.author), record.author]));
  return structuredClone([...unique.values()]);
}
