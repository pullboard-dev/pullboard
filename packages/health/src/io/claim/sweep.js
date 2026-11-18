/** Background claim maintenance: the Git observations no board command makes for another seat [B4,N2]. */
import { captureLapsedClaims } from '../stale/state/capture.js';
import { recordClaimWorktrees } from '../../../../activity/index.js';
import { listItems } from '../../../../store/index.js';
import { listAgents } from '../../../../store/index.js';
import { events } from '../../../../store/index.js';
import { atomic } from '../../../../store/index.js';
import { getItem } from '../../../../store/index.js';
import { insertShout } from '../../../../store/index.js';
import { closeFinishedAsks } from '../../../../store/index.js';
import { withLocalSeatPresence } from '../../../../store/index.js';
import { planClaimWatchdog } from '../../../../seats/index.js';
import { WATCHDOG_GRACE_MS } from '../../../../seats/index.js';
import { staleStateSnapshot } from '../stale/state/snapshot.js';
import { observeStaleWork } from '../stale/observation/work.js';

/** Parse a native event detail without letting one malformed legacy row stop scheduled maintenance. */
function eventDetail(event) {
  try { return JSON.parse(event.event_detail); }
  catch { return null; }
}

/** Return the latest event timestamp after the current claim for one holder and a set of progress kinds. */
function latestProgress(events, claim, owner, kinds) {
  return events.filter(event => event.event_id > claim.event_id && event.event_by === owner && kinds.has(event.event_kind))
    .at(-1)?.event_at ?? null;
}

/** Insert the nudge under the board writer lock so overlapping scheduled sweeps cannot send it twice. */
function insertClaimWatchdogNudge(board, message) {
  const cause = message.detail.cause;
  return atomic(board, () => {
    const item = getItem(board, message.detail.item);
    if (item.item_status !== 'claimed' || item.item_owner !== message.to) return null;
    const previous = board.db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_kind='shout' AND json_extract(event_detail,'$.cause')=? LIMIT 1")
      .get(message.detail.item, cause);
    return previous ? null : insertShout(board, message);
  });
}

/**
 * Send one durable nudge for a live idle claim during the scheduled sentinel sweep.
 * The same sweep's native stale-state pass returns an unchanged claim at the 40-minute boundary, ten minutes after this nudge.
 */
export function runScheduledClaimWatchdog(ctx, board, snapshot, ports = {}, model = 'unknown') {
  if (!snapshot || !Array.isArray(snapshot.claims)) return { nudge: [], release: [], keep: [], cleared: [] };
  const seats = ports.seats?.() ?? withLocalSeatPresence(board, listAgents(board));
  const seatById = new Map(seats.map(seat => [seat.agent_id, seat]));
  const allEvents = ports.events ?? (id => events(board, { itemId: id }));
  const readItem = ports.getItem ?? getItem;
  const shout = ports.shout ?? (message => insertClaimWatchdogNudge(board, message));
  const claims = [];
  const nudged = new Map();
  const claimByItem = new Map();
  for (const row of snapshot.claims) {
    const item = readItem(board, row.id);
    if (item.item_status !== 'claimed' || item.item_owner !== row.actor) continue;
    const history = allEvents(row.id);
    const claim = history.findLast(event => event.event_kind === 'claim' && event.event_by === row.actor);
    if (!claim) continue;
    const observation = ports.work ? ports.work(board, row.actor) : { available: row.evidence?.complete === true, commitAt: row.commitAt };
    if (observation?.available !== true || !observation.commitAt) continue;
    const seat = seatById.get(row.actor);
    const marker = `sentinel:claim-watchdog:${claim.event_id}`;
    const previous = history.findLast(event => {
      const detail = eventDetail(event);
      return event.event_kind === 'shout' && event.event_by === 'sentinel' && detail?.cause === marker;
    });
    if (previous) nudged.set(row.id, previous.event_at);
    claims.push({ item: row.id, owner: row.actor, seatLive: seat?.presence === 'live',
      lastCommitAt: observation.commitAt,
      lastSubmitAt: latestProgress(history, claim, row.actor, new Set(['submit'])),
      lastGateAt: latestProgress(history, claim, row.actor, new Set(['proof-run', 'submit-handoff'])),
      claimedAt: claim.event_at });
    claimByItem.set(row.id, { row, claim, marker });
  }
  const now = ctx.clock.now().getTime();
  const plan = planClaimWatchdog(claims, nudged, now);
  for (const row of plan.nudge) {
    const current = claimByItem.get(row.item);
    if (!current || readItem(board, row.item).item_owner !== row.owner) continue;
    const graceMinutes = WATCHDOG_GRACE_MS / 60_000;
    shout({ from: 'sentinel', to: row.owner,
      text: `Your live claim on #${row.item} has had no commit, submit, or gate for 30 minutes. Please make progress; if it remains idle, the scheduled watchdog returns it to next after a ${graceMinutes}-minute grace period.`,
      lanes: [], detail: { item: row.item, cause: current.marker, model } });
  }
  return plan;
}

/** Capture every live claim for the watchdog, including claims already notified by stale-state maintenance. */
function captureClaimWatchdogSnapshot(ctx, board, ports = {}) {
  const items = (ports.items ?? listItems(board)).filter(item => item.item_status === 'claimed' && item.item_owner);
  return (ports.staleStateSnapshot ?? staleStateSnapshot)(board, ctx.config, { now: ctx.clock.now(), items, claimsOnly: true,
    blocker: () => false, workObservation: actor => (ports.observeStaleWork ?? observeStaleWork)(board, actor) });
}

/**
 * Tell the coordinator once per five-minute window that claims were kept because most seats went quiet together.
 * Why once: the sweep runs every ten minutes and a stalled machine is one event, not one per sweep.
 */
function announceMachineStall(board, stall, shout = message => insertShout(board, message), model = 'unknown') {
  const window = String(Math.floor(Date.parse(stall.observedAt) / 300_000));
  const sent = atomic(board, () => {
    const key = 'machine_stall_window';
    if (board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key)?.meta_value === window) return false;
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value').run(key, window);
    return true;
  });
  if (sent) shout({ from: 'sentinel', to: 'coordinator', text: stall.lateByMs
      ? `Machine stall: the sentinel tick ran ${Math.round(stall.lateByMs / 60_000)} minutes late with ${stall.quiet} of ${stall.claimed} claimed seats quiet, so no claim was released for no heartbeat in this window.`
      : `Machine stall: ${stall.quiet} of ${stall.claimed} claimed seats missed their heartbeats together, so no claim was released for no heartbeat in this window.`, lanes: [], detail: { cause: 'MACHINE_STALL', model, ...stall } });
}

/**
 * Record this sweep's start and return the time since the previous one, 0 when none is recorded.
 * Why: a sweep that starts far later than its cadence means the machine stalled, and every seat looks quiet for it (#3712).
 */
function noteSweepTick(board, now) {
  const key = 'claim_sweep_at';
  return atomic(board, () => {
    const previous = Date.parse(board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key)?.meta_value ?? '');
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value').run(key, new Date(now).toISOString());
    return Number.isFinite(previous) ? Math.max(0, now - previous) : 0;
  });
}

/**
 * Record every claimed worktree's changed files, then apply the idle, stalled and returned-claim checks that read
 * those worktrees. Why here: the person's rule (#2427) is that a board command does only its own job, so this runs
 * from `sentinel run` (the View schedules it every ten minutes), never on claim, release or next.
 */
export async function sweepClaims(ctx, board, actor, ordered, ports = {}) {
  const items = ports.items ?? listItems(board);
  const agents = ports.agents ?? listAgents(board);
  (ports.recordClaimWorktrees ?? recordClaimWorktrees)(board, items, agents, { now: ctx.clock.now() });
  ctx.sweepGapMs = noteSweepTick(board, ctx.clock.now().getTime());
  const snapshot = (ports.captureLapsedClaims ?? captureLapsedClaims)(ctx, board, actor);
  // The sentinel posts as itself, so each shout records the model of the seat whose sweep sent it [I13].
  const model = agents.find(agent => agent.agent_id === actor)?.agent_model ?? 'unknown';
  if (ctx.machineStall) announceMachineStall(board, ctx.machineStall, ports.shout, model);
  if (snapshot) {
    const io = { ...ctx.io, personRequest: undefined, personRequestMoveId: undefined, relayCommand: undefined, requestedCommand: undefined };
    try { await ordered({ ...ctx, io }, board, 'maintainStaleState', [{ agentId: actor, snapshot, health: ctx.config.health ?? {}, claimsOnly: true }]); }
    catch (error) {
      // A board that moved while this pass looked is observed again on the next pass.
      if (error.code !== 'STALE_STATE_CHANGED') throw error;
    }
  }
  // The View's ten-minute sentinel cadence calls this sweep outside builder seats; its stale-state move above owns the 40-minute release.
  const watchdogSnapshot = (ports.captureClaimWatchdogSnapshot ?? captureClaimWatchdogSnapshot)(ctx, board, ports);
  (ports.runScheduledClaimWatchdog ?? runScheduledClaimWatchdog)(ctx, board, watchdogSnapshot, ports.watchdogPorts, model);
  // Asks left open on items that already landed or were withdrawn close once; a later pass finds none [B21,C7].
  try { (ports.closeFinishedAsks ?? closeFinishedAsks)(board, { agentId: actor }); } catch { /* the next pass tries again */ }
  return snapshot;
}

/**
 * Expire lapsed claims and nothing else: read board rows and seat presence, no Git, then one ordered stale-state move.
 * Why: the sentinel must cover lapsed claims on its own before the inline call before each write is removed (#3002); the
 * View runs this every minute behind health.lapsedSweep, so a lapsed lease is expired within two minutes with no command run [C7,#8923].
 * @returns {Promise<object|null>} The snapshot the pass acted on, or null when no claim had lapsed.
 */
export async function sweepLapsedClaims(ctx, board, actor, ordered, ports = {}) {
  const snapshot = (ports.captureLapsedClaims ?? captureLapsedClaims)(ctx, board, actor, { lapsedOnly: true });
  if (!snapshot) return null;
  const io = { ...ctx.io, personRequest: undefined, personRequestMoveId: undefined, relayCommand: undefined, requestedCommand: undefined };
  try { await ordered({ ...ctx, io }, board, 'maintainStaleState', [{ agentId: actor, snapshot, health: ctx.config.health ?? {}, claimsOnly: true }]); }
  catch (error) {
    // A board that moved while this pass looked is observed again on the next pass.
    if (error.code !== 'STALE_STATE_CHANGED') throw error;
  }
  return snapshot;
}
