/** Bridge private provider attribution to authenticated numeric board moves [N2]. */
import { performance } from 'node:perf_hooks';
import { queueUsageCheckpoint } from './due.js';
import { usageCheckpointInline } from './due.js';
import { USAGE_BATCH_LIMIT } from './usage.js';
import { publicUsage } from './usage.js';
import { usageCheckpoint } from './ledger.js';
import { sharedSessionTotals } from './shared.js';
import { storedSeatUsage } from '../cost.js';

/** The batch the first drain write carries, and the lock-hold budget each batch is sized to stay under (the 1 s bar, with margin). */
const USAGE_WRITE_START = 25;
const USAGE_WRITE_BUDGET_MS = 400;

/** Let other writers take the board between two batches of a drain. */
const pause = () => new Promise(resolve => setTimeout(resolve, 5));

/** Moves that end an item's usage: a merge or a withdrawal closes the claim of every seat that held it. */
const CLOSING_MOVES = new Set(['merged', 'withdraw']);

/**
 * The seats whose usage a closing move owes: the current owner and the seat of the last claim.
 * Why: a forced merge or a withdrawal is made by the coordinator, so the builder's own checkpoint never fires.
 */
function closingSeats(board, item) {
  let owner = null;
  try { owner = board.nativePorts.getItem(board, item)?.item_owner ?? null; } catch { /* an unknown item has no holder */ }
  const last = board.db.prepare("SELECT event_by FROM event WHERE item_id=? AND event_kind='claim' ORDER BY event_id DESC LIMIT 1").get(item);
  return [...new Set([owner, last?.event_by].filter((seat) => typeof seat === 'string' && seat))];
}

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
    else if (current?.item === event.item_id) { current.end = Math.min(at, current.deadline ?? at); current.endKind = event.event_kind; current = null; }
  }
  if (current && Number.isFinite(current.deadline) && current.deadline <= now) current.end = current.deadline;
  return { intervals, latest: events.at(-1) };
}

/**
 * Publish one slice of revisions, isolating any the board refuses; returns how many it refused.
 * Why: the board rolls a whole batch back when one record is invalid, so a single oversized shared group (more than 100 seats)
 * kept every other revision of its seat from ever publishing, and busy days read as little or no agent time [#7578].
 */
export async function writeSlice(ctx, board, agent, slice, ordered) {
  const items = slice.filter(entry => entry.item).map(({ item: change }) => ({ ...change, records: publicUsage(change.records) }));
  const sharedSessions = slice.filter(entry => entry.shared).map(({ shared: change }) => ({ ...change, records: publicUsage(change.records) }));
  try { await ordered(ctx, board, 'recordUsageBatch', [{ agentId: agent, items, sharedSessions }]); return 0; }
  catch (error) {
    if (error?.code !== 'USAGE_RECORD') throw error;
    if (slice.length === 1) return 1;
    const middle = slice.length >> 1;
    return await writeSlice(ctx, board, agent, slice.slice(0, middle), ordered) + await writeSlice(ctx, board, agent, slice.slice(middle), ordered);
  }
}

/**
 * Publish all private revisions not yet acknowledged, including allocations already closed by submit/release.
 * A deferred checkpoint passes the move's own time, last board event and session environment, so it
 * attributes exactly what the in-line checkpoint would have at that move.
 */
export async function publishUsage(ctx, board, { agent, item, operation }, { ordered, now = ctx.clock.now().getTime(), lastEventId = Number.MAX_SAFE_INTEGER, environment = process.env, drain = false } = {}) {
  const history = lifecycleIntervals(board, agent, now, lastEventId);
  // A closing move runs in the coordinator's shell, so it never lends that shell's session to the seat it closes.
  const closing = CLOSING_MOVES.has(operation);
  const changes = usageCheckpoint(ctx.info, { agent, item, operation, model: board.nativePorts.agentModel(board, agent), now, environment: closing ? {} : environment,
    existing: storedSeatUsage(board, agent), existingShared: sharedSessionTotals(board), intervals: history.intervals,
    newClaim: operation === 'claim' && history.latest?.event_kind === 'claim' && history.latest.item_id === item });
  // A claim only opens its private anchor: its own zero-length interval publishes at submit, release or refresh.
  // Attribution above reads private files before ordering; the actual writer records only numeric revisions.
  const pendingItems = changes.items.filter(change => operation !== 'claim' || change.item !== item);
  const publish = [...pendingItems.map(change => ({ item: change })), ...changes.sharedSessions.map(change => ({ shared: change }))];
  // The detached worker drains everything in short writes; a command's own checkpoint stays one batch [C7].
  const limit = drain ? publish.length : Math.min(publish.length, USAGE_BATCH_LIMIT);
  let size = drain ? USAGE_WRITE_START : limit, published = 0, refused = 0;
  while (published < limit) {
    const slice = publish.slice(published, published + Math.min(size, limit - published));
    const started = performance.now();
    refused += await writeSlice(ctx, board, agent, slice, ordered);
    published += slice.length;
    if (!drain) continue;
    // Each batch is its own write under the board lock, so one that nears the budget halves the next and a quick one doubles it;
    // a stopped worker resumes at the first revision the board has not acknowledged, because the next run reads it back.
    const took = performance.now() - started;
    size = took > USAGE_WRITE_BUDGET_MS ? Math.max(1, size >> 1) : took * 2 < USAGE_WRITE_BUDGET_MS ? Math.min(USAGE_BATCH_LIMIT, size * 2) : size;
    await pause();
  }
  if (refused) ctx.io.err(`pullboard: USAGE_REFUSED: the board refused ${refused} usage revision${refused === 1 ? '' : 's'}; the seat's other revisions were published.`);
  const pending = publish.length - published;
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
  // A merge or withdrawal closes usage for each seat that held the item, not for the coordinator that made the move.
  const requests = CLOSING_MOVES.has(request.operation)
    ? closingSeats(board, Number(request.item)).map((agent) => ({ ...request, agent, item: Number(request.item) })) : [request];
  for (const one of requests) {
    try {
      if (services.worker && !usageCheckpointInline()) queueUsageCheckpoint(ctx.info, board, one, { worker: services.worker, now: ctx.clock.now().getTime() });
      else await publishUsage(ctx, board, one, services);
    }
    catch (error) {
      ctx.io.err(`pullboard: USAGE_PENDING: [stage=${checkpointStage(error)}] the lifecycle move was recorded, but its usage checkpoint is pending; the next native claim, submit or release will retry. Missing native attribution stays unknown.`);
    }
  }
}
