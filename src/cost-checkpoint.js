/** Bridge private provider attribution to authenticated numeric board moves [N2]. */
import { publicUsage } from './cost-read.js';
import { usageCheckpoint } from './cost-ledger.js';
import { sharedSessionTotals } from './cost-shared.js';
import { storedSeatUsage } from './cost.js';
import { agentModel } from './board-query.js';
import { ordered } from './cli.js';

/** Usage writes one lifecycle move may order before the rest wait for the next move (#1867). */
const USAGE_WRITES_PER_MOVE = 4;

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
  // #1867 stopgap: each ordered usage write holds the board lock for seconds, so one move publishes at most
  // USAGE_WRITES_PER_MOVE of them; the rest stay pending and the next claim, submit or release continues.
  const items = changes.items.filter(change => operation !== 'claim' || change.item !== item);
  const writes = [...items.map(change => ['recordUsage', { ...change, records: publicUsage(change.records) }]),
    ...changes.sharedSessions.map(change => ['recordSharedUsage', { agentId: agent, ...change, records: publicUsage(change.records) }])];
  for (const [move, payload] of writes.slice(0, USAGE_WRITES_PER_MOVE)) await ordered(ctx, board, move, [payload]);
  if (writes.length > USAGE_WRITES_PER_MOVE) ctx.io.err(`pullboard: USAGE_PENDING: published ${USAGE_WRITES_PER_MOVE} of ${writes.length} usage revisions; ${writes.length - USAGE_WRITES_PER_MOVE} remain for the next native claim, submit or release.`);
}

/** A secondary usage failure must never report a successfully ordered claim/submit/release as failed. */
export async function checkpointAfterMove(ctx, board, request) {
  try { await publishUsage(ctx, board, request); }
  catch {
    ctx.io.err('pullboard: USAGE_PENDING: the lifecycle move was recorded, but its usage checkpoint is pending; the next native claim, submit or release will retry. Missing native attribution stays unknown.');
  }
}
