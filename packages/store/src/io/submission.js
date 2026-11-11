import { Refused } from "../../../kernel/index.js";
import { seatFamily } from "../../../items/light.js";
/** Record the existing submitted item fields and native event without changing transaction ownership [V4,H16]. */
import { getItem } from "./board/query.js";
import { logEvent } from "./board/event/log.js";

/** Build the original submit mutation at the same guarded point in its caller's transaction. */
export function submissionItemValues(board, found, { agentId, commit, tree, files, carry, basis }) {
  return {
    item_built_by: agentId,
    item_builder_family: seatFamily(board, agentId),
    item_commit: commit,
    item_tree: tree,
    item_lease_until: null,
    item_review_by: null,
    item_review_until: null,
    item_files: [...new Set([...(found.item_files ?? '').split('\n').filter(Boolean), ...files])].join('\n'),
    ...(carry ? { item_verdict: 'ACCEPT', item_verified_by: basis.by } : {}),
  };
}

/**
 * Append the original submit payload after the guarded mutation, preserving legacy omissions and field order.
 * Why the tooling tree: landing and review reuse a submit's proof only when its tooling tree is the one that judges
 * them (RFC 0007 SC7); dropped here, every receipt read as TOOLING_CHANGED and no proof was ever reused [C7,#3685].
 */
export function recordSubmissionEvent(board, id, { agentId, commit, tree, policyCommit, policy = null, note, recordedProof, infra, tooling = null, modern, gateGreen, companion, quarantineProofIds, carry, mergeOnly, recordedSize, engineVersion }) {
  const criterionDigest = engineVersion >= 9 ? getItem(board, id).item_frozen_digest : null;
  logEvent(board, agentId, 'submit', id, {
    commit,
    tree,
    ...(policyCommit ? { policyCommit } : {}),
    ...(policy ? { policy: { commit: policy.commit, digest: policy.digest } } : {}),
    ...(criterionDigest ? { criterionDigest } : {}),
    ...(note === undefined ? {} : { note: note.trim() }),
    ...(recordedProof ? { submissionProof: recordedProof } : {}), ...(infra ? { infra } : {}),
    ...(modern && gateGreen !== undefined ? { gateGreen: gateGreen === true } : {}),
    ...(carry ? { mergeOnly } : {}),
    ...(recordedSize ? { submissionSize: recordedSize } : {}),
    ...(companion ? { companion } : {}),
    ...(quarantineProofIds !== undefined ? { quarantineProofIds: [...quarantineProofIds] } : {}),
    ...(typeof tooling === 'string' && /^[a-f0-9]{40,64}$/u.test(tooling) ? { tooling } : {}),
  });
}

/** Preserve the native submit child guard at its original transaction boundary. */
export function submissionChildrenProblem(board, id) {
  const { total } = board.db
    .prepare("SELECT COUNT(*) AS total FROM item WHERE item_parent_id = ? AND item_status IN ('open', 'claimed', 'submitted')")
    .get(id);
  return total ? new Refused('CHILDREN_OPEN', `item #${id} has ${total} unfinished child items`) : null;
}
