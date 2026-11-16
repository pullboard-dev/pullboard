import { Refused } from "../../../kernel/index.js";
import { seatFamily } from "../../../items/light.js";
/** Record the existing submitted item fields and native event without changing transaction ownership [V4,H16]. */
import { getItem } from "./board/query.js";
import { logEvent } from "./board/event/log.js";
import { runSubmitTable } from "../logic/board/landing/lease.js";
import { INFRASTRUCTURE_CODES } from "./submit/handoff/retry.js";
import { INFRASTRUCTURE_RETRY_LIMIT } from "./submit/handoff/retry.js";
import { shadowHook } from "./board/shadow-record.js";
import { shadowDecide } from "./board/shadow-record.js";
import { firstDifference } from "./board/shadow-record.js";

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
 * What the COMMIT table's submit outcome writes for this submission: the item patch and the submit event it logs.
 * Why: the writer and the table must give one answer, and the shadow compare shows it [C7,#8281].
 *
 * @returns {{ patch: object, events: object[] }}
 */
export function commitDecision(board, id, { agentId, commit, tree, files, policyCommit, note, recordedProof, infra, tooling, gateGreen, companion, quarantineProofIds, recordedSize }) {
  const row = getItem(board, id);
  const snapshot = {
    now: board.clock.now().toISOString(), actor: { id: agentId },
    item: { id, status: 'claimed', owner: agentId, leaseUntil: row.item_lease_until, frozenDigest: row.item_frozen_digest, files: (row.item_files ?? '').split('\n').filter(Boolean) },
    children: [], rejects: [], history: [], submits: [], receipts: [], handoff: null, io: {}, deferred: { proofRecord: recordedProof ?? null, builderFamily: seatFamily(board, agentId) },
    gate: { green: gateGreen, size: recordedSize, tooling, policyCommit },
  };
  const move = { id, actor: agentId, commit, tree, files, note, infra, companionRecord: companion, quarantineProofIds };
  const { table } = runSubmitTable('COMMIT', { retryLimit: INFRASTRUCTURE_RETRY_LIMIT, infrastructureCodes: INFRASTRUCTURE_CODES }, snapshot, move);
  const outcome = table.outcomes.find(o => o.id === 'submit');
  return { patch: outcome.patch(snapshot, move), events: outcome.events(snapshot, move) };
}

/**
 * Append the original submit payload after the guarded mutation, preserving legacy omissions and field order.
 * Why the tooling tree: landing and review reuse a submit's proof only when its tooling tree is the one that judges
 * them (RFC 0007 SC7); dropped here, every receipt read as TOOLING_CHANGED and no proof was ever reused [C7,#3685].
 */
export function recordSubmissionEvent(board, id, { agentId, commit, tree, policyCommit, note, recordedProof, infra, tooling = null, modern, gateGreen, companion, quarantineProofIds, carry, mergeOnly, recordedSize, engineVersion, shadow = false, live = false }) {
  // A board that carries `submitCommitShadow` is handed the table's event beside the one logged here; the table models only a modern, non-carry submit [C7,#8281].
  // With no such hook, `shadow` (the moves.shadow setting, read before the write opened) records the compare on the board instead [C7,#8379].
  // With moves.live.submit on (`live`, read before the write opened), the COMMIT table decides the submit event and it is the one logged; it models only the same modern, non-carry submit [C7,#8384].
  if (live && modern && !carry && engineVersion >= 9) {
    for (const event of commitDecision(board, id, { agentId, commit, tree, files: [], policyCommit, note, recordedProof, infra, tooling, gateGreen, companion, quarantineProofIds, recordedSize }).events) logEvent(board, event.by, event.kind, id, event.detail);
    return;
  }
  const hook = modern && !carry && engineVersion >= 9 ? shadowHook(board, 'submitCommitShadow', 'commit', commitDiffers, () => shadow === true) : null;
  const shadowed = hook !== null;
  const decided = shadowed ? shadowDecide(hook, () => commitDecision(board, id, { agentId, commit, tree, files: [], policyCommit, note, recordedProof, infra, tooling, gateGreen, companion, quarantineProofIds, recordedSize })) : null;
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
    ...(quarantineProofIds !== undefined ? { quarantineProofIds: [...quarantineProofIds] } : {}),
    ...(typeof tooling === 'string' && /^[a-f0-9]{40,64}$/u.test(tooling) ? { tooling } : {}),
  });
  if (shadowed) {
    const logged = board.db.prepare("SELECT event_by AS by, event_detail AS detail FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC LIMIT 1").get(id);
    const { model, ...detail } = JSON.parse(logged.detail);
    hook({ id, decided: decided.threw ? decided : decided.events, wrote: [{ kind: 'submit', by: logged.by, detail }] });
  }
}

/** Preserve the native submit child guard at its original transaction boundary. */
export function submissionChildrenProblem(board, id) {
  const { total } = board.db
    .prepare("SELECT COUNT(*) AS total FROM item WHERE item_parent_id = ? AND item_status IN ('open', 'claimed', 'submitted')")
    .get(id);
  return total ? new Refused('CHILDREN_OPEN', `item #${id} has ${total} unfinished child items`) : null;
}

/** Where the COMMIT table's submit event and the event the writer logged part: the first differing path, or null when they agree. */
export function commitDiffers({ decided, wrote }) {
  if (decided?.threw) return `threw ${decided.threw}`;
  return firstDifference(decided, wrote, 'events');
}
