/** Where an item's clock time goes: every landed item's add-to-merge span split into named phases that sum to it [R1,R2,C7]. */
import { Refused } from '../../../kernel/core.js';
import { proofEventDetail } from '../../../kernel/index.js';

export const TIME_PHASES = ['queued', 'building', 'tool', 'thinking', 'static', 'doctrine', 'check', 'test', 'conflict',
  'reviewWait', 'reviewing', 'rejectWaitingBuilder', 'rejectRebuilding', 'idleHold', 'landing'];
const GATE = ['static', 'doctrine', 'check', 'test', 'conflict'];

/**
 * Validate the public window: a positive number of days, default 7.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function timeWindowDays(value = 7) {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0 || days > 3650) throw new Refused('USAGE', 'choose a window of 1 to 3650 days: pullboard stats time --days 7');
  return days;
}

/** The phase the time after one event belongs to, given what this item's history held so far. */
function phaseAfter(event, detail, state) {
  switch (event.event_kind) {
    case 'add': return 'queued';
    case 'claim': case 'renew': state.claimed = true; return state.rejected ? 'rejectRebuilding' : 'building';
    case 'submit': state.rejected = false; return 'reviewWait';
    case 'reserve': return 'reviewing';
    case 'accept': return 'landing';
    case 'reject': state.rejected = true; return 'rejectWaitingBuilder';
    case 'release': return detail.review ? 'reviewWait' : state.claimed ? 'idleHold' : 'queued';
    case 'reopen': case 'withdraw': case 'lapse': case 'escalate':
      return state.rejected ? 'rejectWaitingBuilder' : state.claimed ? 'idleHold' : 'queued';
    case 'refreeze': return detail.retainedClaim ? null : state.claimed ? 'idleHold' : 'queued';
    default: return null;
  }
}

/** Split one building interval that ends at a submit: gate phases first, then recorded tool and thinking, rest stays building. */
function carve(ms, gate, facts, into, base) {
  let left = ms;
  for (const phase of GATE) { const take = Math.min(left, Math.max(0, Number(gate?.[phase]) || 0)); into[phase] += take; left -= take; }
  if (base === 'building') {
    const tool = Math.min(left, facts.toolMs); into.tool += tool; left -= tool; facts.toolMs -= tool;
    const thinking = Math.min(left, facts.thinkingMs); into.thinking += thinking; left -= thinking; facts.thinkingMs -= thinking;
  }
  into[base] += left;
}

/** Walk one item's events from add to merge; every millisecond lands in exactly one phase. */
function breakdown(events) {
  const phases = Object.fromEntries(TIME_PHASES.map(phase => [phase, 0]));
  const state = { claimed: false, rejected: false };
  const facts = { toolMs: 0, thinkingMs: 0 };
  let phase = null, since = null, gate = null;
  for (const event of events) {
    const at = Date.parse(event.event_at), detail = proofEventDetail(event);
    if (event.event_kind === 'fact' && detail.kind === 'seat-time') {
      facts.toolMs += Math.max(0, Number(detail.toolMs) || 0); facts.thinkingMs += Math.max(0, Number(detail.thinkingMs) || 0);
      continue;
    }
    const receipt = event.event_kind === 'proof-run' ? detail.receipt : null;
    if (receipt && Number.isSafeInteger(receipt.durationMs) && receipt.durationMs >= 0) {
      // Production proof receipts carry the run's duration; a check run is the check phase, a submit gate run is the test phase.
      const name = receipt.kind === 'check' || receipt.kind === 'submit' && receipt.submitPhase === 'criterion'
        ? 'check' : receipt.kind === 'submit' ? 'test' : null;
      if (name) { gate ??= {}; gate[name] = (gate[name] ?? 0) + receipt.durationMs; }
      continue;
    }
    if (phase && Number.isFinite(at) && at >= since) {
      const ms = at - since;
      if ((phase === 'building' || phase === 'rejectRebuilding') && event.event_kind === 'submit') carve(ms, detail.gatePhases ?? gate, facts, phases, phase);
      else phases[phase] += ms;
      since = at;
    }
    if (event.event_kind === 'merged') break;
    const next = phaseAfter(event, detail, state);
    if (next) { phase = next; since = at; }
    if (event.event_kind === 'submit') gate = null;
  }
  return phases;
}

/** The middle value of a list; the mean of the two middle values for an even count. */
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Phase breakdown of the items that landed in a window, from the event table alone.
 *
 * @param {any[]} history
 * @param {{ now: number, days?: number }} options
 * @returns {{ since: string, until: string, landed: number, items: any[], phases: Record<string, { medianMs: number, totalMs: number }>, clockMs: number }}
 */
export function timeStats(history, { now, days = 7 }) {
  const window = timeWindowDays(days) * 86400000;
  const ordered = [...history].sort((a, b) => a.event_id - b.event_id);
  const byItem = new Map(), landedAt = new Map();
  for (const event of ordered) {
    if (event.item_id == null) continue;
    if (!byItem.has(event.item_id)) byItem.set(event.item_id, []);
    byItem.get(event.item_id).push(event);
    if (event.event_kind === 'merged') landedAt.set(event.item_id, Date.parse(event.event_at));
  }
  const items = [];
  for (const [id, at] of landedAt) {
    if (!(at >= now - window && at <= now)) continue;
    const events = byItem.get(id), added = events.find(event => event.event_kind === 'add');
    if (!added) continue;
    const phases = breakdown(events);
    items.push({ id, landedAt: new Date(at).toISOString(), clockMs: at - Date.parse(added.event_at), phases });
  }
  items.sort((a, b) => a.id - b.id);
  const phases = Object.fromEntries(TIME_PHASES.map(phase => {
    const values = items.map(item => item.phases[phase]);
    return [phase, { medianMs: median(values), totalMs: values.reduce((sum, value) => sum + value, 0) }];
  }));
  return { since: new Date(now - window).toISOString(), until: new Date(now).toISOString(), landed: items.length, items, phases,
    clockMs: items.reduce((sum, item) => sum + item.clockMs, 0) };
}

/** Human lines: median and total minutes per phase, then the share of clock time that is not building. */
export function timeLines(stats) {
  const minutes = ms => (ms / 60000).toFixed(1);
  const lines = [`${stats.landed} items landed ${stats.since} to ${stats.until}; ${minutes(stats.clockMs)} clock minutes`];
  for (const phase of TIME_PHASES) {
    const row = stats.phases[phase];
    if (row.totalMs > 0) lines.push(`${phase}: median ${minutes(row.medianMs)} min, total ${minutes(row.totalMs)} min`);
  }
  return lines;
}

/**
 * One dated line for the append-only stats history.
 *
 * @param {ReturnType<typeof timeStats>} stats
 * @param {{ reason: 'weekly' | 'release', label?: string }} why
 * @returns {string}
 */
export function checkpointLine(stats, { reason, label }) {
  const phases = Object.fromEntries(TIME_PHASES.map(phase => [phase, stats.phases[phase]]));
  return JSON.stringify({ version: 1, at: stats.until, reason, ...(label ? { label } : {}), since: stats.since, landed: stats.landed, clockMs: stats.clockMs, phases });
}

/** Whether a weekly checkpoint is due: none yet, or the last one is at least seven days old. */
export function weeklyDue(historyText, now) {
  const last = historyText.split('\n').filter(Boolean).map(line => { try { return Date.parse(JSON.parse(line).at); } catch { return NaN; } }).filter(Number.isFinite).at(-1);
  return last === undefined || now - last >= 7 * 86400000;
}
