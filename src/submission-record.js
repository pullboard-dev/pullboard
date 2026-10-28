/** Record the existing submitted item fields and native event without changing transaction ownership [V4,H16]. */
import { getItem } from './board-query.js';
import { logEvent } from './board-event-log.js';

/** Build the original submit mutation at the same guarded point in its caller's transaction. */
export function submissionItemValues(board, found, { agentId, commit, tree, files, carry, basis }) {
  return {
    item_built_by: agentId,
    item_builder_family: board.db.prepare('SELECT agent_family FROM agent WHERE agent_id = ?').get(agentId)?.agent_family ?? null,
    item_commit: commit,
    item_tree: tree,
    item_lease_until: null,
    item_review_by: null,
    item_review_until: null,
    item_files: [...new Set([...(found.item_files ?? '').split('\n').filter(Boolean), ...files])].join('\n'),
    ...(carry ? { item_verdict: 'ACCEPT', item_verified_by: basis.by } : {}),
  };
}

/** Append the original submit payload after the guarded mutation, preserving legacy omissions and field order. */
export function recordSubmissionEvent(board, id, { agentId, commit, tree, policyCommit, note, recordedProof, infra, modern, gateGreen, companion, carry, mergeOnly, recordedSize, engineVersion }) {
  const criterionDigest = engineVersion >= 9 ? getItem(board, id).item_frozen_digest : null;
  logEvent(board, agentId, 'submit', id, {
    commit,
    tree,
    ...(policyCommit ? { policyCommit } : {}),
    ...(criterionDigest ? { criterionDigest } : {}),
    ...(note === undefined ? {} : { note: note.trim() }),
    ...(recordedProof ? { submissionProof: recordedProof } : {}), ...(infra ? { infra } : {}),
    ...(modern && gateGreen !== undefined ? { gateGreen: gateGreen === true } : {}),
    ...(carry ? { mergeOnly } : {}),
    ...(recordedSize ? { submissionSize: recordedSize } : {}),
    ...(companion ? { companion } : {}),
  });
}
