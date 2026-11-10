/** Where an item's clock time goes: every landed item's add-to-merge span split into named phases that sum to it [R1,R2,C7]. */
import { Refused } from '../../../kernel/light.js';
import { proofEventDetail } from '../../../kernel/browser.js';

export const TIME_PHASES = ['queued', 'building', 'tool', 'thinking', 'static', 'doctrine', 'check', 'test', 'conflict', 'unattributedChecks',
  'reviewWait', 'reviewing', 'rejectWaitingBuilder', 'rejectRebuilding', 'idleHold', 'landing'];
const GATE = ['static', 'doctrine', 'check', 'test', 'conflict', 'unattributedChecks'];

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
    case 'submit': state.claimed = false; state.rejected = false; return 'reviewWait';
    case 'reserve': return 'reviewing';
    case 'accept': return 'landing';
    case 'reject': state.rejected = true; return 'rejectWaitingBuilder';
    case 'release': if (detail.review) return 'reviewWait'; state.claimed = false; return state.rejected ? 'rejectWaitingBuilder' : 'queued';
    case 'reopen': case 'withdraw': case 'lapse': case 'escalate':
      state.claimed = false; return state.rejected ? 'rejectWaitingBuilder' : 'queued';
    case 'refreeze': if (detail.retainedClaim) return null; state.claimed = false; return state.rejected ? 'rejectWaitingBuilder' : 'queued';
    default: return null;
  }
}

/** Resolve observed stalls within their claim, ending at the holder's next work or a claim boundary. */
function idleSpans(events) {
  const spans = [];
  let holder = null, claimAt = null, pending = null, lastEnd = null;
  const close = at => {
    if (pending !== null && Number.isFinite(at) && at >= pending) spans.push([pending, at]);
    if (Number.isFinite(at)) lastEnd = at;
    pending = null;
  };
  for (const event of events) {
    const at = Date.parse(event.event_at), detail = proofEventDetail(event);
    if (event.event_kind === 'claim') { close(at); holder = event.event_by; claimAt = at; lastEnd = at; continue; }
    if (event.event_kind === 'claim_stalled' && holder && detail.holder === holder) {
      const start = Date.parse(detail.lastActivity), observed = Date.parse(detail.observedAt);
      if (Number.isFinite(start) && Number.isFinite(observed) && Number.isFinite(at)
        && start >= claimAt && start <= observed && observed <= at) {
        const bounded = Math.max(start, lastEnd ?? start);
        if (bounded <= observed) pending = pending === null ? bounded : Math.min(pending, bounded);
      }
      continue;
    }
    const boundary = ['submit', 'release', 'lapse', 'withdraw', 'reopen', 'escalate'].includes(event.event_kind) || event.event_kind === 'refreeze' && !detail.retainedClaim;
    const activity = event.event_by === holder && ['commit', 'proof-run', 'fact', 'submit'].includes(event.event_kind);
    if (boundary || activity) close(at);
    if (boundary || event.event_kind === 'submit') { holder = null; claimAt = null; }
  }
  return spans;
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

/** Read native measurement text tagged seat-time, retaining older exported seat-time envelopes. */
function recordedSeatTime(detail) {
  let value = detail;
  if (detail.kind === 'measurement') {
    try { value = JSON.parse(detail.text); } catch { return null; }
  }
  if (!value || value.kind !== 'seat-time') return null;
  return {
    toolMs: Number.isFinite(value.toolMs) && value.toolMs >= 0 ? value.toolMs : 0,
    thinkingMs: Number.isFinite(value.thinkingMs) && value.thinkingMs >= 0 ? value.thinkingMs : 0,
  };
}

/** Require a retained source identity before attributing a check to its named phase. */
function receiptCommit(receipt) {
  const commit = receipt.commit ?? receipt.executionSource?.commit ?? receipt.source?.commit;
  return typeof commit === 'string' && /^[a-f0-9]{40,64}$/u.test(commit) ? commit : null;
}

/** Walk one item's events from add to merge; every millisecond lands in exactly one phase. */
function breakdown(events, receipts = []) {
  const phases = Object.fromEntries(TIME_PHASES.map(phase => [phase, 0]));
  const state = { claimed: false, rejected: false };
  const facts = { toolMs: 0, thinkingMs: 0 };
  const idle = idleSpans(events);
  let phase = null, since = null, gate = null, claimAt = null, pendingBuild = 0;
  for (const event of events) {
    const at = Date.parse(event.event_at), detail = proofEventDetail(event);
    const seatTime = event.event_kind === 'fact' ? recordedSeatTime(detail) : null;
    if (seatTime) {
      facts.toolMs += seatTime.toolMs; facts.thinkingMs += seatTime.thinkingMs;
      continue;
    }
    const receipt = event.event_kind === 'proof-run' ? detail.receipt : null;
    if (receipt && Number.isSafeInteger(receipt.durationMs) && receipt.durationMs >= 0) {
      // Production proof receipts carry the run's duration; a check run is the check phase, a submit gate run is the test phase.
      const identified = receiptCommit(receipt) !== null;
      const name = !identified && ['check', 'submit'].includes(receipt.kind) ? 'unattributedChecks'
        : receipt.kind === 'check' || receipt.kind === 'submit' && receipt.submitPhase === 'criterion'
          ? 'check' : receipt.kind === 'submit' && receipt.submitPhase === 'proof' ? 'test'
            : receipt.kind === 'submit' ? 'unattributedChecks' : null;
      if (name) { gate ??= {}; gate[name] = (gate[name] ?? 0) + receipt.durationMs; }
      continue;
    }
    if (event.event_kind === 'claim') claimAt = at;
    if (event.event_kind === 'submit' && Number.isFinite(claimAt)) {
      for (const receipt of receipts) {
        const finished = Date.parse(receipt.at);
        if (!['static', 'doctrine', 'conflict'].includes(receipt.kind) || !Number.isFinite(finished)
          || finished < claimAt || finished > at) continue;
        const duration = ['waitMs', 'admissionMs', 'setupMs', 'runMs', 'evidenceMs']
          .reduce((sum, key) => sum + (Number.isFinite(receipt[key]) && receipt[key] >= 0 ? receipt[key] : 0), 0);
        gate ??= {};
        const name = receiptCommit(receipt) ? receipt.kind : 'unattributedChecks';
        gate[name] = (gate[name] ?? 0) + duration;
      }
    }
    if (phase && Number.isFinite(at) && at >= since) {
      let ms = at - since;
      if (phase === 'building' || phase === 'rejectRebuilding') {
        const stalled = idle.reduce((sum, [start, end]) => sum + Math.max(0, Math.min(at, end) - Math.max(since, start)), 0);
        phases.idleHold += stalled;
        ms -= stalled;
        pendingBuild += ms;
        if (event.event_kind === 'submit') {
          carve(pendingBuild, detail.gatePhases ?? gate, facts, phases, phase);
          pendingBuild = 0;
        }
      } else phases[phase] += ms;
      since = at;
    }
    if (event.event_kind === 'merged') break;
    const next = phaseAfter(event, detail, state);
    if (next && next !== phase && (phase === 'building' || phase === 'rejectRebuilding') && pendingBuild) {
      phases[phase] += pendingBuild;
      pendingBuild = 0;
    }
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
export function timeStats(history, { now, days = 7, receipts = [] }) {
  const window = timeWindowDays(days) * 86400000;
  const ordered = [...history].sort((a, b) => a.event_id - b.event_id);
  const commits = new Map();
  for (const event of ordered) {
    if (event.event_kind !== 'submit' || !Number.isSafeInteger(event.item_id)) continue;
    const commit = proofEventDetail(event).commit;
    if (typeof commit !== 'string' || !/^[a-f0-9]{40,64}$/u.test(commit)) continue;
    if (!commits.has(commit)) commits.set(commit, new Set());
    commits.get(commit).add(event.item_id);
  }
  const attributed = receipts.map(receipt => {
    if (Number.isSafeInteger(receipt.item)) return receipt;
    const commit = receiptCommit(receipt);
    const items = commits.get(commit);
    return items?.size === 1 ? { ...receipt, item: [...items][0] } : receipt;
  });
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
    const phases = breakdown(events, attributed.filter(receipt => receipt.item === id));
    items.push({ id, landedAt: new Date(at).toISOString(), clockMs: at - Date.parse(added.event_at), phases });
  }
  items.sort((a, b) => a.id - b.id);
  const phases = Object.fromEntries(TIME_PHASES.map(phase => {
    const values = items.map(item => item.phases[phase]);
    return [phase, { medianMs: median(values), totalMs: values.reduce((sum, value) => sum + value, 0) }];
  }));
  const unassigned = attributed.filter(receipt => ['static', 'doctrine', 'conflict'].includes(receipt.kind)
    && !Number.isSafeInteger(receipt.item) && Date.parse(receipt.at) >= now - window && Date.parse(receipt.at) <= now);
  const unattributedReceipts = unassigned.length;
  const unattributedGateMs = unassigned.reduce((total, receipt) => total + ['waitMs', 'admissionMs', 'setupMs', 'runMs', 'evidenceMs']
      .reduce((sum, key) => sum + (Number.isFinite(receipt[key]) && receipt[key] >= 0 ? receipt[key] : 0), 0), 0);
  const unattributedProofs = items.reduce((count, item) => count + byItem.get(item.id).filter(event => {
    if (event.event_kind !== 'proof-run') return false;
    const receipt = proofEventDetail(event).receipt;
    return receipt?.kind === 'submit' && !['criterion', 'proof'].includes(receipt.submitPhase);
  }).length, 0);
  return { since: new Date(now - window).toISOString(), until: new Date(now).toISOString(), landed: items.length, items, phases, unattributedReceipts, unattributedGateMs, unattributedProofs,
    clockMs: items.reduce((sum, item) => sum + item.clockMs, 0) };
}

/** Human lines: median and total minutes for every phase, including phases with no recorded time. */
export function timeLines(stats) {
  const minutes = ms => (ms / 60000).toFixed(1);
  const lines = [`${stats.landed} items landed ${stats.since} to ${stats.until}; ${minutes(stats.clockMs)} clock minutes`];
  if (stats.unattributedReceipts) lines.push(`unattributed checks: ${minutes(stats.unattributedGateMs)} min across ${stats.unattributedReceipts} receipts without item attribution (outside item totals)`);
  if (stats.unattributedProofs) lines.push(`${stats.unattributedProofs} submit proof receipts lack phase attribution`);
  for (const phase of TIME_PHASES) {
    const row = stats.phases[phase];
    lines.push(`${phase === 'unattributedChecks' ? 'unattributed checks' : phase}: median ${minutes(row.medianMs)} min, total ${minutes(row.totalMs)} min`);
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
  return JSON.stringify({ version: 1, at: stats.until, reason, ...(label ? { label } : {}), since: stats.since, landed: stats.landed, clockMs: stats.clockMs,
    unattributedReceipts: stats.unattributedReceipts, unattributedGateMs: stats.unattributedGateMs, unattributedProofs: stats.unattributedProofs, phases });
}

/** Whether a weekly checkpoint is due: none yet, or the last one is at least seven days old. */
export function weeklyDue(historyText, now) {
  const last = historyText.split('\n').filter(Boolean).map(line => { try { const row = JSON.parse(line); return row.reason === 'weekly' ? Date.parse(row.at) : NaN; } catch { return NaN; } }).filter(Number.isFinite).at(-1);
  return last === undefined || now - last >= 7 * 86400000;
}
