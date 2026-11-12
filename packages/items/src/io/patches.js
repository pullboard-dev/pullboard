/** Immutable coordinator patch inputs retain native author provenance and invalidate stale acceptance [V4,H16]. */
import { createHash } from 'node:crypto';
import { ENGINE_VERSION } from "../../../state/index.js";
import { ITEM_PATCH_SUBMIT_ENGINE } from "../../../state/light.js";
import { ITEM_PATCH_ENGINE } from "../../../state/light.js";
import { PATCH_REVIEW_CUSTODY_ENGINE } from "../../../state/light.js";
import { PATCH_FOLLOW_ENGINE } from "../../../state/light.js";
import { itemPatchSetDigest } from "./patch/state.js";
import { Refused } from "../../../kernel/index.js";
import { NO_ELIGIBLE_REVIEWER_ENGINE } from "../../../state/light.js";
import { ITEM_PATCH_AUTO_ENGINE } from "../../../state/light.js";
import { outsideSource } from "../logic/outside/source.js";
import { itemPatchRecords as records } from "./patch/state.js";
import { itemPatchDigest } from "./patch/state.js";
import { itemPatchPaths } from "./patch/compose.js";
import { outOfLane } from "../../../seats/index.js";
import { IN_STATE } from "../../../state/index.js";
export { itemPatches, itemPatchDigest, itemPatchAuthors, itemPatchSetDigest } from "./patch/state.js";

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

/** Own the public writer using the board root's explicit sealing and canonical transaction ports. */
export function followItemPatches(board, id, options) {
  const sealed = board.executionEngineVersion === undefined ? board.enginePorts.sealItemPatchFollow(board, id, options) : options;
  return applyItemPatchFollow(board, id, sealed, { atomic: board.nativePorts.atomic, logEvent: board.nativePorts.logEvent, getItem: board.nativePorts.getItem });
}

/** Replay one all-or-nothing binding change without changing immutable bytes, authors or the claim. */
export function applyItemPatchFollow(board, id, options, { atomic, getItem, logEvent }) {
  return atomic(board, () => {
    const item = getItem(board, id);
    if ((board.executionEngineVersion ?? ENGINE_VERSION) < PATCH_FOLLOW_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade before following companion heads');
    if (outsideSource(board, id)) throw new Refused('ITEM_PATCH_OUTSIDE', 'outside PR changes remain with their source author; attach patches only to native items');
    if (item.item_status !== 'claimed' || item.item_owner !== options?.agentId
      || !(item.item_lease_until > board.clock.now().toISOString())) throw new Refused('NOT_YOURS', 'claim this item before following its companions');
    const history = records(board, id), patches = history.filter(record => record.active);
    const previous = patches.map(({ key, commit, digest }) => ({ key, commit, digest }));
    if (!fields(options, ['agentId', 'commit', 'digest', 'previous', 'nextDigest']) || !COMMIT.test(options.commit ?? '')
      || !patches.length || patches.some(record => record.source?.commit !== record.commit)
      || options.digest !== itemPatchDigest(board, id) || JSON.stringify(options.previous) !== JSON.stringify(previous)) {
      throw new Refused('ITEM_PATCH_CHANGED', 'read and compose the current exact companion set before following it');
    }
    const rebound = patches.map(record => ({ ...record, commit: options.commit, source: { commit: options.commit } }));
    if (options.nextDigest !== itemPatchSetDigest(options.commit, rebound)) throw new Refused('ITEM_PATCH_CHANGED', 'the followed companion set does not match its sealed applicability');
    if (patches.every(record => record.commit === options.commit)) return { item: id, changed: false, digest: options.nextDigest };
    const changed = previous.map(record => ({ key: record.key, oldHead: record.commit, newHead: options.commit, hash: record.digest }));
    for (const record of patches) { record.attachedCommit ??= record.commit; record.commit = options.commit; record.source = { commit: options.commit }; }
    save(board, id, history);
    logEvent(board, options.agentId, 'item_patch_follow', id, { patches: changed, previousDigest: options.digest, digest: options.nextDigest });
    return { item: id, changed: true, digest: options.nextDigest };
  });
}
/** Only the registered coordinator may change submitted, unmerged review inputs. */
function target(board, id, options, allowed, { getItem }) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < ITEM_PATCH_ENGINE) throw new Refused('ENGINE_VERSION', `item patches require engine ${ITEM_PATCH_ENGINE}`);
  const item = getItem(board, id);
  const builderProposal = options?.autoAttach === true;
  if (!fields(options, allowed) || (builderProposal
    ? !['agentId', 'key', 'commit', 'patch', 'author', 'presubmit', 'autoAttach'].every(key => allowed.includes(key))
      || options.agentId !== item.item_owner || item.item_status !== 'claimed'
      || !(item.item_lease_until > board.clock.now().toISOString())
    : options.agentId !== 'coordinator')) throw new Refused('COORDINATOR_ONLY', 'record a companion on your claimed item with submit --companion, or use the coordinator patch command');
  if (!builderProposal && !board.db.prepare("SELECT 1 FROM agent WHERE agent_id='coordinator'").get()) throw new Refused('NOT_JOINED', 'join the coordinator before attaching patches');
  if (!KEY.test(options.key ?? '')) throw new Refused('ITEM_PATCH_KEY', 'use an immutable patch key of one to 80 letters, digits, dots, underscores or hyphens');
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
const PREVIEWED = Symbol('item patch author preview');
/**
 * Before a live command applies the move, refuse an author who would leave a strict item no ACTIVE reviewer.
 * The author is written inside a transaction that always rolls back, so nothing is recorded; the ordered move
 * keeps its own deterministic check against every registered seat so replay never reads local heartbeats [C7,V4].
 */
export function refuseLiveAttach(board, item, { key, author, commit, patch = '' }, { atomic, review, asSubmitted, refuseUnreviewable, listAgents = board.nativePorts?.listAgents }) {
  try {
    atomic(board, () => {
      const patches = records(board, item.item_id);
      if (!patches.some(record => record.key === key)) {
        patches.push({ key, commit: commit ?? item.item_commit, source: { commit: commit ?? item.item_commit }, patch, digest: hash(patch), author: authorIdentity(board, author), active: true });
        save(board, item.item_id, patches);
      }
      refuseUnreviewable(board, asSubmitted(board, item), review, { listAgents });
      throw PREVIEWED;
    });
  } catch (error) {
    // Any other refusal (a stale source, a bad patch) belongs to the ordered move that runs next and reports it by its own code.
    if (error !== PREVIEWED && error?.code === 'NO_ELIGIBLE_REVIEWER') throw error;
  }
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
    const item = target(board, id, options, ['agentId', 'key', 'commit', 'patch', 'author', 'presubmit', 'autoAttach'], ports);
    if (outsideSource(board, id)) throw new Refused('ITEM_PATCH_OUTSIDE', 'outside PR changes remain with their source author; attach patches only to native items');
    const patches = records(board, id), existing = patches.find(record => record.key === options.key);
    const originalRetry = (board.executionEngineVersion ?? ENGINE_VERSION) >= PATCH_FOLLOW_ENGINE && existing?.attachedCommit === options.commit;
    if (!COMMIT.test(options.commit ?? '') || !originalRetry && item.item_status !== 'claimed' && options.commit !== item.item_commit) throw new Refused('ITEM_PATCH_SOURCE', 'attach against the exact builder head (or submitted commit)');
    const patch = patchBytes(options.patch), author = authorIdentity(board, options.author), digest = hash(patch);
    const authorLane = board.db.prepare('SELECT agent_lane FROM agent WHERE agent_id=?').get(author.agentId)?.agent_lane;
    if (options.autoAttach) {
      if (!authorLane || authorLane === item.item_lane || !board.gitRoot) throw new Refused('ITEM_PATCH_AUTHOR', 'name a registered author from another lane and submit from the item worktree');
      const policy = board.enginePorts.sandboxPolicyReads.itemPolicy(board.gitRoot, item);
      const denied = outOfLane(policy.config, authorLane, [...itemPatchPaths(patch)]);
      if (denied.length) throw new Refused('OUTSIDE_LANE', `patch author ${author.agentId} cannot change ${denied.join(', ')} under frozen policy ${policy.commit}`);
    }
    if (existing) {
      if (options.autoAttach && existing.autoAttach && existing.builder === options.agentId
        && existing.patch === patch && existing.author.agentId === author.agentId) {
        return { item: id, key: options.key, digest: itemPatchDigest(board, id), changed: false };
      }
      if ((existing.attachedCommit ?? existing.commit) !== options.commit || existing.patch !== patch || existing.author.agentId !== author.agentId) throw new Refused('ITEM_PATCH_CONFLICT', 'this immutable patch key already names different bytes, source or author');
      return { item: id, key: options.key, digest: itemPatchDigest(board, id), changed: false };
    }
    const record = { key: options.key, commit: options.commit, source: { commit: options.commit }, patch, digest, author, active: true,
      ...(options.autoAttach ? { autoAttach: true, builder: options.agentId, ownerLane: authorLane } : {}),
      ...(item.item_status === 'claimed' ? { presubmit: true } : {}) };
    patches.push(record); save(board, id, patches);
    // The new author may leave no seat able to review a strict item; the throw rolls this whole move back.
    if ((board.executionEngineVersion ?? ENGINE_VERSION) >= NO_ELIGIBLE_REVIEWER_ENGINE) ports.refuseUnreviewable(board, ports.asSubmitted(board, item), { registered: true }, ports);
    if (!options.autoAttach) ports.invalidate(id);
    ports.logEvent(board, options.agentId, 'item_patch_attach', id, { key: record.key, commit: record.commit, digest, author });
    if (options.autoAttach) ports.notifyOwner?.(board, { builder: options.agentId, owner: author.agentId, item: id, key: record.key });
    return { item: id, key: options.key, digest: itemPatchDigest(board, id), changed: true };
  });
}

/** Start the lane owner's objection period only after the exact submitted source passed its gate [C7]. */
export function startItemPatchObjectionWindow(board, id, { agentId, commit }, { logEvent }) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < ITEM_PATCH_AUTO_ENGINE) return null;
  const patches = records(board, id);
  const automatic = patches.filter(record => record.active && record.autoAttach && record.commit === commit);
  if (!automatic.length) return null;
  const until = new Date(board.clock.now().getTime() + 15 * 60_000).toISOString();
  for (const record of automatic) record.objectionUntil = until;
  save(board, id, patches);
  logEvent(board, agentId, 'item_patch_window', id, { keys: automatic.map(record => record.key), until, commit });
  return until;
}

/** Refuse review selection and verdicts until every automatic companion has had its objection window [C7]. */
export function companionWindowProblem(board, item) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < ITEM_PATCH_AUTO_ENGINE || item.item_status !== 'submitted') return null;
  const pending = records(board, item.item_id).filter(record => record.active && record.autoAttach);
  for (const record of pending) {
    if (!Number.isFinite(Date.parse(record.objectionUntil ?? ''))) throw new Refused('COMPANION_WINDOW', 'the automatic companion objection deadline is missing from native history; ask the coordinator to inspect the item patch record');
    if (Date.parse(record.objectionUntil) > board.clock.now().getTime()) {
      return new Refused('COMPANION_WINDOW', `#${item.item_id} companion ${record.key} can be objected to by ${record.ownerLane} until ${record.objectionUntil}`);
    }
  }
  return null;
}

/** A registered companion lane owner can object during its window, deactivating the patch and reopening the item [C7]. */
export function applyItemPatchObjection(board, id, options, { atomic, getItem, logEvent, moveItem }) {
  return atomic(board, () => {
    const item = getItem(board, id);
    if ((board.executionEngineVersion ?? ENGINE_VERSION) < ITEM_PATCH_AUTO_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade before objecting to automatic companions');
    if (!fields(options, ['agentId', 'key', 'note']) || typeof options.note !== 'string' || !options.note.trim()
      || /[\r\n\u2028\u2029]/u.test(options.note)) throw new Refused('NOTE_REQUIRED', 'say why the owning lane objects with --note "reason"');
    const patches = records(board, id);
    const record = patches.find(entry => entry.key === options.key && entry.active && entry.autoAttach);
    const lane = board.db.prepare('SELECT agent_lane FROM agent WHERE agent_id=?').get(options.agentId)?.agent_lane;
    const allowed = record && ['claimed', 'submitted'].includes(item.item_status) && !item.item_merged_commit
      && record.builder !== options.agentId && lane === record.ownerLane
      && Number.isFinite(Date.parse(record.objectionUntil ?? ''))
      && Date.parse(record.objectionUntil) > board.clock.now().getTime();
    moveItem(board, id, 'patch-objected', {
      checks: {
        joined: null,
        [IN_STATE]: found => ['claimed', 'submitted'].includes(found.item_status)
          ? null : new Refused('ITEM_PATCH_WINDOW', `#${id} is ${found.item_status}; the owner objection window is closed`),
        patchObjection: () => allowed ? null : new Refused('ITEM_PATCH_WINDOW', `#${id} has no live companion objection for ${options.key} from your owning lane`),
      },
      set: () => ({ item_owner: null, item_lease_until: null, item_verdict: null, item_verified_by: null, item_review_by: null, item_review_until: null }),
    });
    record.active = false;
    record.objectedAt = board.clock.now().toISOString();
    record.objection = options.note.trim();
    save(board, id, patches);
    logEvent(board, options.agentId, 'item_patch_object', id, { key: record.key, builder: record.builder, ownerLane: record.ownerLane,
      note: record.objection, commit: record.commit });
    return { item: id, key: record.key, reopened: true };
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
