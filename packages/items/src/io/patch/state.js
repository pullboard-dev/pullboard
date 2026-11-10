/** Read-only native companion inputs stay outside the writer and person import graphs [C7,V4,H16]. */
import { createHash } from 'node:crypto';
import { ENGINE_VERSION } from "../../../../state/light.js";
import { ITEM_PATCH_ENGINE } from "../../../../state/light.js";
import { Refused } from "../../../../kernel/index.js";
const PREFIX = 'item_patches:';
/** Hash canonical native metadata identically on every replica. */
function hash(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
/** Read immutable native history without importing board opening or write orchestration. */
export function itemPatchRecords(board, id) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < ITEM_PATCH_ENGINE || !Number.isSafeInteger(id) || id < 1) return [];
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(PREFIX + id);
  if (!row) return [];
  const saved = JSON.parse(row.meta_value);
  if (saved.version !== 1 || !Array.isArray(saved.patches)) throw new Refused('ITEM_PATCH_FORMAT', 'restore the native item patch metadata before reviewing');
  return saved.patches;
}
/** Canonical composition digest ignores presentation fields and retains native author identity. */
export function itemPatchSetDigest(commit, patches) {
  return hash(JSON.stringify({ commit, patches: patches.map(({ key, commit: source, digest, author }) => ({ key, commit: source, digest,
    author: { agentId: author.agentId, parentSession: author.parentSession, session: author.session } })) }));
}
/** Return active patches in native attachment order, with independent result objects. */
export function itemPatches(board, id) { return structuredClone(itemPatchRecords(board, id).filter(record => record.active)); }
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
