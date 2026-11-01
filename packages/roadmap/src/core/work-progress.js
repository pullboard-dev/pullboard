/** Native workflow progress and waits shared by board views and automatic notices [B35]. */

/** Resolve only native dependency identities; unresolved references stay visible as waits. */
export function progressWaits(item, byId) {
  const waits = String(item.item_after ?? '').split(',').filter(Boolean).flatMap(reference => {
    const dependency = byId.get(Number(reference));
    return dependency && (dependency.item_merged_commit || dependency.item_status === 'withdrawn') ? [] : [`#${reference}`];
  });
  if (item.item_hold_reason) waits.push(`hold: ${item.item_hold_reason}`);
  return waits;
}

/** Project actual board stages, holders and elapsed board activity without estimating code completion. */
export function itemProgress(board, id, { now = board.clock.now(), workObservation } = {}) {
  const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(id);
  if (!item) return null;
  const byId = new Map(board.db.prepare('SELECT * FROM item').all().map(row => [row.item_id, row]));
  const stage = item.item_merged_commit ? 'landed' : item.item_status === 'verified' ? 'accepted' : item.item_status;
  const holder = item.item_status === 'claimed' && item.item_lease_until > new Date(now).toISOString() ? item.item_owner
    : item.item_status === 'submitted' && item.item_review_until > new Date(now).toISOString() ? item.item_review_by : null;
  const activity = board.db.prepare(`SELECT MAX(event_at) AS at FROM event WHERE item_id=?
    AND event_kind IN ('add','claim','submit','accept','reject','release','merged','withdraw','refreeze','attempt')`).get(id).at ?? item.item_created_at;
  const observed = holder && workObservation ? workObservation(board, holder) : null;
  const lastActivity = observed?.available && observed.at && observed.at > activity ? observed.at : activity;
  const waits = progressWaits(item, byId);
  const laneHold = board.db.prepare('SELECT * FROM hold WHERE hold_lane=?').get(item.item_lane);
  if (laneHold) waits.push(`lane hold: ${laneHold.hold_reason}`);
  if (stage === 'submitted') waits.push(item.item_review_by ? 'review verdict' : 'independent reviewer');
  if (stage === 'accepted') waits.push('landing on main');
  return { item: id, stage, holder, heldBy: item.item_hold_by ?? null, waits,
    lastActivity, idleMinutes: Math.max(0, Math.floor((new Date(now) - new Date(lastActivity)) / 60_000)),
    idleBasis: observed?.available ? 'board and observed worktree activity' : 'board activity; worktree activity unknown' };
}

/** Keep the human view a rendering of the same native fields exposed in JSON. */
export function progressLine(progress) {
  return `progress: ${progress.stage}; holder ${progress.holder ?? 'none'}${progress.heldBy ? `; held by ${progress.heldBy}` : ''}; waits ${progress.waits.join(', ') || 'none'}; idle ${progress.idleMinutes}m (${progress.idleBasis})`;
}

/** Recognize state-only messages conservatively; evidence, questions and decisions remain messages. */
export function restatesBoardState(board, message) {
  if (message.decision || message.request || message.evidence || message.answers != null || /[?]/u.test(message.text)) return false;
  const text = message.text.trim();
  const match = /^#(\d+)\s+(?:(?:is|has|was|still|now)\s+)*(?:open|claimed|building|submitted|in review|accepted|verified|landed|merged|rejected|stalled|unblocked|blocked|ready|held|waiting|waits)(?:\s+(?:on|by|for|at|idle|until)\s+[\w#.,:@/ -]+)?[.!]?$/iu.exec(text);
  if (match && !/\b(?:because|error|failed|failure|need|requires|changed|bug|conflict)\b/iu.test(text) && board.db.prepare('SELECT 1 FROM item WHERE item_id=?').get(Number(match[1]))) return true;
  const milestone = /^(.+?):\s*\d+\/\d+ landed[.!]?$/iu.exec(text);
  if (milestone) {
    const row = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='milestones'").get();
    if (row && JSON.parse(row.meta_value).some(entry => entry.name === milestone[1])) return true;
  }
  const nudge = /^(?:please\s+)?(?:resume|continue|claim|pick up|fix|check|submit|release)\s+#(\d+)(?:\s+(?:please|now|when ready))?[.!]?$/iu.exec(text);
  return Boolean(nudge && board.db.prepare('SELECT 1 FROM item WHERE item_id=?').get(Number(nudge[1])));
}
