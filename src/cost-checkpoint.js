/** Bridge private provider attribution to authenticated numeric board moves [N2]. */
import { publicUsage } from './cost-read.js';
import { usageCheckpoint } from './cost-ledger.js';
import { sharedSessionTotals } from './cost-shared.js';
import { storedSeatUsage } from './cost.js';
import { agentModel } from './board-query.js';
import { ordered } from './cli.js';

/** Recover missed local checkpoints as unknown usage bounded by actual ordered claim/end times. */
function lifecycleIntervals(board, agent, now) {
  const events = board.db.prepare("SELECT event_id,event_at,event_kind,item_id,event_detail FROM event WHERE event_by=? AND event_kind IN ('claim','renew','submit','release') ORDER BY event_id").all(agent);
  const intervals = [];
  let current;
  for (const event of events) {
    const at = Date.parse(event.event_at);
    const detail = JSON.parse(event.event_detail);
    if (event.event_kind === 'claim') {
      if (current) current.end = Math.min(at, current.deadline ?? at);
      current = { key: event.event_id, item: event.item_id, start: at, end: null, model: detail.model, deadline: Number.isFinite(Date.parse(detail.leaseUntil)) ? Date.parse(detail.leaseUntil) : Infinity };
      intervals.push(current);
    } else if (event.event_kind === 'renew' && current?.item === event.item_id) current.deadline = Number.isFinite(Date.parse(detail.leaseUntil)) ? Date.parse(detail.leaseUntil) : Infinity;
    else if (current?.item === event.item_id) { current.end = Math.min(at, current.deadline ?? at); current = null; }
  }
  if (current && Number.isFinite(current.deadline) && current.deadline <= now) current.end = current.deadline;
  return { intervals, latest: events.at(-1) };
}

/** Publish all private revisions not yet acknowledged, including allocations already closed by submit/release. */
export async function publishUsage(ctx, board, { agent, item, operation }) {
  const now = ctx.clock.now().getTime();
  const history = lifecycleIntervals(board, agent, now);
  const changes = usageCheckpoint(ctx.info, { agent, item, operation, model: agentModel(board, agent), now,
    existing: storedSeatUsage(board, agent), existingShared: sharedSessionTotals(board), intervals: history.intervals,
    newClaim: operation === 'claim' && history.latest?.event_kind === 'claim' && history.latest.item_id === item });
  // A claim only opens its private anchor: its own zero-length interval publishes at submit, release or refresh.
  for (const change of changes.items) if (operation !== 'claim' || change.item !== item) await ordered(ctx, board, 'recordUsage', [{ ...change, records: publicUsage(change.records) }]);
  for (const change of changes.sharedSessions) await ordered(ctx, board, 'recordSharedUsage', [{ agentId: agent, ...change, records: publicUsage(change.records) }]);
}

/** A secondary usage failure must never report a successfully ordered claim/submit/release as failed. */
export async function checkpointAfterMove(ctx, board, request) {
  try { await publishUsage(ctx, board, request); }
  catch {
    ctx.io.err('pullboard: USAGE_PENDING: the lifecycle move was recorded, but its usage checkpoint is pending; the next native claim, submit or release will retry. Missing native attribution stays unknown.');
  }
}
