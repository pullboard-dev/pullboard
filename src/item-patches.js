/** Immutable coordinator patch inputs retain native author provenance and invalidate stale acceptance [V4,H16]. */
import { createHash } from 'node:crypto';
import { ENGINE_VERSION } from './engine-metadata.js';
import { ITEM_PATCH_SUBMIT_ENGINE } from './item-patch-submit-engine.js';
import { ITEM_PATCH_ENGINE } from './item-patch-engine.js';
import { PATCH_REVIEW_CUSTODY_ENGINE } from './patch-review-custody-engine.js';
import { Refused } from './refused.js';
import { outsideSource } from './outside-source.js';
import { itemPatchRecords as records } from './item-patch-state.js';
import { itemPatchDigest } from './item-patch-state.js';
export { itemPatches, itemPatchDigest, itemPatchAuthors, itemPatchSetDigest } from './item-patch-state.js';

const PREFIX = 'item_patches:';
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAX_BYTES = 8 * 1024 * 1024;
/** Revoke checked inputs without evicting their live reviewer; old ordered moves retain eviction. */
export function itemPatchResetFields(board, item, { reviewHolder }) {
  const held = (board.executionEngineVersion ?? ENGINE_VERSION) >= PATCH_REVIEW_CUSTODY_ENGINE && reviewHolder(board, item);
  return { item_built_by: item.item_built_by, item_frozen_digest: item.item_frozen_digest,
    item_verdict: null, item_verified_by: null,
    item_review_by: held ? item.item_review_by : null, item_review_until: held ? item.item_review_until : null };
}
/** Preserve native status guards through caller ports; claimed companions never release their owner or lease. */
export function invalidateItemPatch(board, id, agentId, { moveItem, onlyCoordinator, inState, getItem, reviewHolder }) {
  const claimed = getItem(board, id).item_status === 'claimed' && (board.executionEngineVersion ?? ENGINE_VERSION) >= ITEM_PATCH_SUBMIT_ENGINE;
  return moveItem(board, id, claimed ? 'patch-claimed' : 'patch', {
    checks: {
      joined: null,
      [inState]: found => new Refused('ITEM_PATCH_STATE', `item #${id} is ${found.item_status}; attach only to claimed or submitted, unmerged work`),
      coordinatorOnly: () => onlyCoordinator(agentId, 'changes companion inputs'),
      notMerged: found => found.item_merged_commit ? new Refused('ALREADY_MERGED', 'file a follow-up for landed work') : null,
    },
    set: found => claimed ? {} : itemPatchResetFields(board, found, { reviewHolder }),
  });
}

/** Hash exact UTF8 data with one stable algorithm on all replicas. */
function hash(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
/** Refuse unknown payload fields rather than accepting caller identity assertions. */
function fields(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
}
/** Read immutable records, including removed entries; no reader writes a projection. */
/** Persist one ordered patch history in the caller transaction. */
function save(board, id, patches) {
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run(PREFIX + id, JSON.stringify({ version: 1, patches }));
}
/** Only the registered coordinator may change submitted, unmerged review inputs. */
function target(board, id, options, allowed, { getItem }) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < ITEM_PATCH_ENGINE) throw new Refused('ENGINE_VERSION', `item patches require engine ${ITEM_PATCH_ENGINE}`);
  if (!fields(options, allowed) || options.agentId !== 'coordinator') throw new Refused('COORDINATOR_ONLY', 'only the coordinator attaches or removes item patches');
  if (!board.db.prepare("SELECT 1 FROM agent WHERE agent_id='coordinator'").get()) throw new Refused('NOT_JOINED', 'join the coordinator before attaching patches');
  if (!KEY.test(options.key ?? '')) throw new Refused('ITEM_PATCH_KEY', 'use an immutable patch key of one to 80 letters, digits, dots, underscores or hyphens');
  const item = getItem(board, id);
  if (!(item.item_status === 'claimed' && (board.executionEngineVersion ?? ENGINE_VERSION) >= ITEM_PATCH_SUBMIT_ENGINE
    || ['submitted', 'verified'].includes(item.item_status)) || item.item_merged_commit) throw new Refused('ITEM_PATCH_STATE', 'patches belong to claimed or unmerged submitted or verified items');
  return item;
}
/** Capture registered author identity, never an identity object supplied by the caller. */
function authorIdentity(board, author) {
  if (typeof author !== 'string' || !board.db.prepare('SELECT 1 FROM agent WHERE agent_id=?').get(author)) throw new Refused('ITEM_PATCH_AUTHOR', 'name an existing native author seat');
  const identity = key => board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key + author)?.meta_value ?? null;
  return { agentId: author, parentSession: identity('agent_parent_session:'), session: identity('agent_session:') };
}
/** Check exact bounded git diff bytes; application/path safety is enforced by the composition consumer. */
function patchBytes(patch) {
  if (typeof patch !== 'string' || !patch || Buffer.byteLength(patch, 'utf8') > MAX_BYTES || patch.includes('\0')
    || Buffer.from(patch, 'utf8').toString('utf8') !== patch || !patch.startsWith('diff --git ')
    || !/^(@@ |GIT binary patch$|(?:new|deleted) file mode |old mode |similarity index )/mu.test(patch)) {
    throw new Refused('ITEM_PATCH_FORMAT', 'supply a nonempty UTF8 git unified or binary diff of at most eight MiB');
  }
  return patch;
}
/** Attach one immutable, source-bound patch; an exact retry never reactivates a removed key. */
export function applyItemPatchAttachment(board, id, options, ports) {
  return ports.atomic(board, () => {
    const item = target(board, id, options, ['agentId', 'key', 'commit', 'patch', 'author', 'presubmit'], ports);
    if (outsideSource(board, id)) throw new Refused('ITEM_PATCH_OUTSIDE', 'outside PR changes remain with their source author; attach patches only to native items');
    if (!COMMIT.test(options.commit ?? '') || item.item_status !== 'claimed' && options.commit !== item.item_commit) throw new Refused('ITEM_PATCH_SOURCE', 'attach against the exact builder head (or submitted commit)');
    const patch = patchBytes(options.patch), author = authorIdentity(board, options.author), digest = hash(patch);
    const patches = records(board, id), existing = patches.find(record => record.key === options.key);
    if (existing) {
      if (existing.commit !== options.commit || existing.patch !== patch || existing.author.agentId !== author.agentId) throw new Refused('ITEM_PATCH_CONFLICT', 'this immutable patch key already names different bytes, source or author');
      return { item: id, key: options.key, digest: itemPatchDigest(board, id), changed: false };
    }
    const record = { key: options.key, commit: options.commit, source: { commit: options.commit }, patch, digest, author, active: true,
      ...(item.item_status === 'claimed' ? { presubmit: true } : {}) };
    patches.push(record); save(board, id, patches); ports.invalidate(id);
    ports.logEvent(board, options.agentId, 'item_patch_attach', id, { key: record.key, commit: record.commit, digest, author });
    return { item: id, key: options.key, digest: itemPatchDigest(board, id), changed: true };
  });
}
/** Remove only the active application, never its immutable key or authorship history. */
export function applyItemPatchRemoval(board, id, options, ports) {
  return ports.atomic(board, () => {
    target(board, id, options, ['agentId', 'key', 'presubmit'], ports);
    const patches = records(board, id), record = patches.find(entry => entry.key === options.key);
    if (!record) throw new Refused('NO_ITEM_PATCH', 'list the item patches and name an existing key');
    if (!record.active) return { item: id, key: options.key, digest: itemPatchDigest(board, id), changed: false };
    record.active = false; save(board, id, patches); ports.invalidate(id);
    ports.logEvent(board, options.agentId, 'item_patch_remove', id, { key: record.key, commit: record.commit, digest: record.digest, author: record.author });
    return { item: id, key: options.key, digest: itemPatchDigest(board, id), changed: true };
  });
}
/** Fail closed when review omitted changed patch inputs or an active patch belongs to old source. */
export function itemPatchReviewProblem(board, item, expectedDigest, { getItem }) {
  const current = getItem(board, item.item_id);
  const history = records(board, item.item_id);
  if (!history.length) return null;
  if (history.some(record => record.active && (record.commit !== current.item_commit || record.source?.commit !== current.item_commit))) return new Refused('ITEM_PATCH_SOURCE', 'remove stale patches and attach against the current submitted commit before review');
  if (typeof expectedDigest !== 'string' || expectedDigest !== itemPatchDigest(board, item.item_id)) return new Refused('ITEM_PATCH_CHANGED', 'read and compose the current item patches before reviewing');
  return null;
}
