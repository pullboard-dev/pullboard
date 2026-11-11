/** Bridge private provider attribution to authenticated numeric board moves [N2]. */
import { queueUsageCheckpoint } from './due.js';
import { usageCheckpointInline } from './due.js';
import { USAGE_BATCH_LIMIT } from './usage.js';
import { publicUsage } from './usage.js';
import { usageCheckpoint } from './ledger.js';
import { sharedSessionTotals } from './shared.js';
import { storedSeatUsage } from '../cost.js';

/** Recover missed local checkpoints as unknown usage bounded by actual ordered claim/end times, as of one board event. */
function lifecycleIntervals(board, agent, now, lastEventId) {
  const events = board.db.prepare("SELECT event_id,event_at,event_kind,item_id,event_detail FROM event WHERE event_by=? AND event_kind IN ('claim','renew','submit','release') AND event_id<=? ORDER BY event_id").all(agent, lastEventId);
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

/**
 * Publish all private revisions not yet acknowledged, including allocations already closed by submit/release.
 * A deferred checkpoint passes the move's own time, last board event and session environment, so it
 * attributes exactly what the in-line checkpoint would have at that move.
 */
export async function publishUsage(ctx, board, { agent, item, operation }, { ordered, now = ctx.clock.now().getTime(), lastEventId = Number.MAX_SAFE_INTEGER, environment = process.env } = {}) {
  const history = lifecycleIntervals(board, agent, now, lastEventId);
  const changes = usageCheckpoint(ctx.info, { agent, item, operation, model: board.nativePorts.agentModel(board, agent), now, environment,
    existing: storedSeatUsage(board, agent), existingShared: sharedSessionTotals(board), intervals: history.intervals,
    newClaim: operation === 'claim' && history.latest?.event_kind === 'claim' && history.latest.item_id === item });
  // A claim only opens its private anchor: its own zero-length interval publishes at submit, release or refresh.
  // Attribution above reads private files before ordering; the actual writer records only numeric revisions.
  const pendingItems = changes.items.filter(change => operation !== 'claim' || change.item !== item);
  const items = pendingItems.slice(0, USAGE_BATCH_LIMIT)
    .map(change => ({ ...change, records: publicUsage(change.records) }));
  const sharedSessions = changes.sharedSessions.slice(0, USAGE_BATCH_LIMIT - items.length)
    .map(change => ({ ...change, records: publicUsage(change.records) }));
  const published = items.length + sharedSessions.length;
  if (published) await ordered(ctx, board, 'recordUsageBatch', [{ agentId: agent, items, sharedSessions }]);
  const pending = pendingItems.length + changes.sharedSessions.length - published;
  if (pending) ctx.io.err(`pullboard: USAGE_PENDING: published ${published} usage revisions in one batch; ${pending} remain for the next native claim, submit or release.`);
}

/** Name only fixed attribution stages; provider paths, identities and exception messages stay private. */
function checkpointStage(error) {
  if (error?.code === 'USAGE_LEDGER') return 'private-ledger';
  if (error?.code === 'USAGE_OVERFLOW') return 'attribution-totals';
  return 'checkpoint';
}

/**
 * After a claim/submit/release, only record that a checkpoint is due; the detached worker reads the logs.
 * A secondary usage failure must never report a successfully ordered claim/submit/release as failed.
 */
export async function checkpointAfterMove(ctx, board, request, services) {
  try {
    if (services.worker && !usageCheckpointInline()) queueUsageCheckpoint(ctx.info, board, request, { worker: services.worker, now: ctx.clock.now().getTime() });
    else await publishUsage(ctx, board, request, services);
  }
  catch (error) {
    ctx.io.err(`pullboard: USAGE_PENDING: [stage=${checkpointStage(error)}] the lifecycle move was recorded, but its usage checkpoint is pending; the next native claim, submit or release will retry. Missing native attribution stays unknown.`);
  }
}
