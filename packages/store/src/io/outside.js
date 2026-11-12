/** Ordered outside facts and the explicitly declared outside submission transition. */
import { createHash } from 'node:crypto';
import { logEvent } from "./board/event/log.js";
import { itemById } from "./board/query.js";
import { Refused } from "../../../kernel/index.js";
import {
  outsideSource,
  saveOutsideSource,
} from "../../../items/index.js";

/** Validate exact immutable identifiers before recording an outside source. */
function validate(source, frozen) {
  if (!source || !['pull-request', 'issue'].includes(source.kind) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(source.repository ?? '') ||
      !Number.isSafeInteger(source.number) || source.number < 1 || !/^[A-Za-z0-9-]{1,39}$/u.test(source.author ?? '') || !['open', 'closed'].includes(source.state) || typeof source.maintainerReplied !== 'boolean') {
    throw new Refused('OUTSIDE_SOURCE', 'intake needs GitHub source metadata; fetch the exact issue or pull request again');
  }
  if (source.kind === 'pull-request' && (!/^[a-f0-9]{40}$/u.test(source.commit ?? '') || !/^[a-f0-9]{40}$/u.test(source.tree ?? '') || !frozen || typeof frozen.text !== 'string' || !Array.isArray(source.files) || !/^[a-f0-9]{40}$/u.test(source.base ?? '') || typeof source.sensitive !== 'boolean' ||
      createHash('sha256').update(frozen.text).digest('hex') !== frozen.digest)) throw new Refused('OUTSIDE_SOURCE', 'fetch the exact pull request commit and freeze its trusted criterion before intake');
}

/** Apply one replayable source refresh; refresh never silently replaces a submitted commit. */
export function applyOutsideIntake(board, options, { atomic, addItem, moveItem, validateItemAddition }) {
  return atomic(board, () => {
    const { agentId, source, item, frozen } = options;
    validate(source, frozen);
    const existing = board.db.prepare("SELECT meta_key,meta_value FROM board_meta WHERE meta_key LIKE 'outside:%'").all()
      .find(row => { const old = JSON.parse(row.meta_value); return old.repository === source.repository && old.kind === source.kind && old.number === source.number; });
    const priorId = existing ? Number(existing.meta_key.slice('outside:'.length)) : null;
    const old = priorId ? outsideSource(board, priorId) : null;
    if (old && (source.kind === 'issue' || old.commit === source.commit)) {
      saveOutsideSource(board, priorId, { ...old, state: source.state, maintainerReplied: source.maintainerReplied,
        ...(source.kind === 'pull-request' ? { sensitive: source.sensitive, sensitivity: source.sensitivity } : {}), updatedAt: source.updatedAt });
      logEvent(board, agentId, 'outside-refresh', priorId, { source });
      return priorId;
    }
    if (old && itemById(board, priorId).item_status !== 'open') throw new Refused('OUTSIDE_HEAD_CHANGED', 'the pull request head changed; ask the coordinator to reopen its recorded submission before intaking the new head');
    // Re-intake must obey the same coordinator-owned bar validation as the original addition.
    validateItemAddition(board, { ...item, by: agentId });
    const id = priorId ?? addItem(board, { ...item, by: agentId });
    saveOutsideSource(board, id, { ...source, ownerApproval: null, sandbox: null });
    if (source.kind === 'pull-request') moveItem(board, id, 'intake', {
      checks: { joined: null, itemExists: null, inState: () => new Refused('NOT_CLAIMABLE', 'intake files or re-intakes a normally returned outside item'), outsideSubmission: null },
      set: () => ({ item_built_by: `outside:github:${source.author}`, item_commit: source.commit, item_tree: source.tree,
        item_title: item.title, item_criterion: item.criterion, item_check: item.check, item_route: item.route ?? 'strong',
        item_owner: null, item_lease_until: null, item_review_by: null, item_review_until: null, item_verdict: null, item_verified_by: null,
        item_claim_head: source.base, item_frozen: frozen.text, item_frozen_digest: frozen.digest, item_files: source.files.join('\n') }),
    });
    logEvent(board, agentId, 'outside-intake', id, { source, frozen });
    return id;
  });
}

/** Person authority is separate from native agent/parent identity and binds one exact commit. */
export function approveOutside(board, id, { agentId }, atomic) {
  return atomic(board, () => {
    const item = itemById(board, id);
    const source = outsideSource(board, id);
    if (agentId !== 'person' || board.verifierStanding && !board.verifierStanding.person) throw new Refused('B26_PERSON_CHANNEL', 'only the owner approves outside sensitive changes through the person channel');
    if (!source || source.kind !== 'pull-request') throw new Refused('OUTSIDE_SOURCE', 'choose an intaken pull request');
    const ownerApproval = { by: 'person', commit: item.item_commit, at: board.clock.now().toISOString() };
    saveOutsideSource(board, id, { ...source, ownerApproval });
    logEvent(board, agentId, 'outside-owner-approval', id, { ownerApproval });
    return ownerApproval;
  });
}
