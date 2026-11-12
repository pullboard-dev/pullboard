/** Append-only withdrawal bindings and derived review-history annotations [V2,V6,H16]. */
import { Refused } from '../../../../kernel/index.js';
import { VERDICT_WITHDRAW_ENGINE } from '../../../../state/light.js';
import { ENGINE_VERSION } from '../../../../state/index.js';
import { MERGE_ONLY_VERDICT_ENGINE } from '../../../../state/light.js';

/** Pair immutable verdict rows with their corresponding immutable acceptance/rejection events. */
function verdictPairs(board, id) {
  const verdicts = board.db.prepare('SELECT * FROM verdict WHERE item_id = ? ORDER BY verdict_id').all(id);
  const events = board.db.prepare("SELECT * FROM event WHERE item_id = ? AND event_kind IN ('accept', 'reject') ORDER BY event_id").all(id);
  return verdicts.map((verdict, index) => ({ verdict, event: events[index] }));
}

/** Reuse an existing ordered read when supplied; standalone callers still load their own immutable pairs. */
export function verdictWithdrawals(board, id, pairs = verdictPairs(board, id)) {
  const result = new Map();
  for (const row of board.db.prepare("SELECT * FROM event WHERE item_id = ? AND event_kind = 'reopen' ORDER BY event_id").all(id)) {
    const detail = JSON.parse(row.event_detail), binding = detail.withdrawnVerdict;
    if (!binding) continue;
    const pair = pairs.find(({ verdict, event }) => verdict.verdict_id === binding.verdictId
      && verdict.verdict_decision === 'ACCEPT' && event?.event_id === binding.acceptEventId
      && event.event_kind === 'accept' && event.event_id < row.event_id
      && (verdict.verdict_commit === detail.commit || board.db.prepare("SELECT 1 FROM event WHERE item_id = ? AND event_kind = 'merge-only-accept' AND event_id > ? AND event_id < ? AND json_extract(event_detail,'$.commit') = ? AND json_extract(event_detail,'$.verdict') = ?")
        .get(id, event.event_id, row.event_id, detail.commit, verdict.verdict_id)));
    if (!pair) continue;
    result.set(pair.verdict.verdict_id, { eventId: row.event_id, acceptEventId: pair.event.event_id,
      at: row.event_at, by: row.event_by, note: detail.note });
  }
  return result;
}

/** Bind the latest current acceptance and authorize only its own reviewer or the coordinator. */
export function verdictWithdrawalTarget(board, item, agentId) {
  if (item.item_status !== 'verified') throw new Refused('VERDICT_WITHDRAW_STATE', 'withdraw an accepted, unmerged item; use ordinary reopen for a submitted item');
  const withdrawn = verdictWithdrawals(board, item.item_id);
  const carry = (board.executionEngineVersion ?? ENGINE_VERSION) >= MERGE_ONLY_VERDICT_ENGINE
    ? board.db.prepare("SELECT event_detail FROM event WHERE item_id = ? AND event_kind = 'merge-only-accept' AND json_extract(event_detail,'$.commit') = ? ORDER BY event_id DESC LIMIT 1")
      .get(item.item_id, item.item_commit) : null;
  const carriedVerdict = carry ? JSON.parse(carry.event_detail).verdict : null;
  const pair = verdictPairs(board, item.item_id).findLast(({ verdict, event }) => verdict.verdict_decision === 'ACCEPT'
    && (verdict.verdict_commit === item.item_commit || verdict.verdict_id === carriedVerdict)
    && event?.event_kind === 'accept' && !withdrawn.has(verdict.verdict_id));
  if (!pair) throw new Refused('VERDICT_WITHDRAW_STATE', 'this item has no current acceptance to withdraw; refresh its recorded history');
  if (agentId !== 'coordinator' && agentId !== pair.verdict.verdict_by) {
    throw new Refused('VERDICT_WITHDRAW_FORBIDDEN', 'only the accepting reviewer or coordinator can withdraw this verdict; ask that reviewer or the coordinator');
  }
  return { verdictId: pair.verdict.verdict_id, acceptEventId: pair.event.event_id };
}

/** Preserve withdrawal option refusals before any lifecycle mutation or review-history lookup. */
export function checkOptions(withdrawVerdict, forMerge, currentEngine) {
  if (withdrawVerdict !== undefined && typeof withdrawVerdict !== 'boolean') throw new Refused('BAD_VERDICT_WITHDRAW', 'withdrawVerdict must be a boolean; use --withdraw-verdict');
  if (withdrawVerdict === true && currentEngine < VERDICT_WITHDRAW_ENGINE) throw new Refused('ENGINE_VERSION', 'update Pullboard before withdrawing a verdict');
  if (withdrawVerdict === true && forMerge) throw new Refused('BAD_VERDICT_WITHDRAW', 'withdraw a verdict or report a trunk conflict, not both');
}
