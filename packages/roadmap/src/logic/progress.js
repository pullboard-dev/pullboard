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

/** Compute one consistent snapshot in bounded queries, rather than rescanning history per item. */
export function workProgress(board, { now = board.clock.now(), workObservation } = {}) {
  const items = board.db.prepare('SELECT * FROM item').all();
  const byId = new Map(items.map(item => [item.item_id, item]));
  const activity = new Map(board.db.prepare(`SELECT item_id,MAX(event_at) AS at FROM event
    WHERE event_kind IN ('add','claim','submit','accept','reject','release','merged','withdraw','refreeze','attempt','reserve_review')
    GROUP BY item_id`).all().map(row => [row.item_id, row.at]));
  const holds = new Map(board.db.prepare('SELECT * FROM hold').all().map(row => [row.hold_lane, row]));
  const observations = new Map();
  const at = new Date(now).toISOString();
  return new Map(items.map(item => {
    const stage = item.item_merged_commit ? 'landed' : item.item_status === 'verified' ? 'accepted' : item.item_status;
    const holder = item.item_status === 'claimed' && item.item_lease_until > at ? item.item_owner
      : item.item_status === 'submitted' && item.item_review_until > at ? item.item_review_by : null;
    if (holder && workObservation && !observations.has(holder)) observations.set(holder, workObservation(board, holder));
    const observed = observations.get(holder);
    const recorded = activity.get(item.item_id) ?? item.item_created_at;
    const lastActivity = observed?.available && observed.at && observed.at > recorded ? observed.at : recorded;
    const waits = progressWaits(item, byId);
    const laneHold = holds.get(item.item_lane);
    if (laneHold) waits.push(`lane hold: ${laneHold.hold_reason}`);
    if (stage === 'submitted') waits.push(holder ? 'review verdict' : 'independent reviewer');
    if (stage === 'accepted') waits.push('landing on main');
    return [item.item_id, { item: item.item_id, stage, holder, heldBy: item.item_hold_by ?? laneHold?.hold_by ?? null, waits,
      lastActivity, idleMinutes: Math.max(0, Math.floor((new Date(now) - new Date(lastActivity)) / 60_000)),
      idleBasis: observed?.available ? 'board and observed worktree activity' : 'board activity; worktree activity unknown' }];
  }));
}

/** Read one item's actual workflow stage without estimating code completion. */
export function itemProgress(board, id, options) { return workProgress(board, options).get(id) ?? null; }

/**
 * Keep the human view a rendering of the same native fields exposed in JSON.
 * A line names only what is set: no holder, no waits and the default idle basis stay in JSON, so a bounded read stays short.
 */
export function progressLine(progress) {
  const basis = progress.idleBasis === 'board activity; worktree activity unknown' ? '' : ` (${progress.idleBasis})`;
  return `progress: ${progress.stage}${progress.holder ? `; holder ${progress.holder}` : ''}${progress.heldBy ? `; held by ${progress.heldBy}` : ''}${progress.waits.length ? `; waits ${progress.waits.join(', ')}` : ''}; idle ${progress.idleMinutes}m${basis}`;
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
