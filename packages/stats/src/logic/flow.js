import { reportEvent } from './flow/report.js';
import { affectedReportItems } from './flow/report.js';
import { indexReportItem } from './flow/report.js';
import { prepareReportMove } from './flow/report.js';
import { newReportPolicy } from './flow/report.js';
import { advanceReport } from './flow/report.js';
import { recordReport } from './flow/report.js';
import { recordReportPolicy } from './flow/report.js';
import { projectReport } from './flow/report.js';
import { projectReportWindows } from './flow/report.js';
import { safeReportPolicy } from './flow/report.js';
import { proofEventDetail } from '../../../kernel/browser.js';
import {
  newWindowTrace,
  observeFlowStage,
  observeFlowVerdict,
  observeFlowGap,
  frozenWindowTrace,
  projectFlowWindow,
  comparisonBounds,
  projectWindowComparison,
} from './flow/window.js';
/** Flow times, queues and recommendations from recorded lifecycle evidence [R1,R2]. */
const MINUTE = 60_000;
const STAGES = ['build', 'reviewWait', 'review', 'mergeWait'];
const LABELS = { build: 'build', reviewWait: 'review wait', review: 'review', mergeWait: 'merge wait' };

/** Summarize measured minutes; an absent interval is never an invented zero. */
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const totalMinutes = sorted.reduce((sum, value) => sum + value, 0);
  const middle = Math.floor(count / 2);
  return { count, totalMinutes, averageMinutes: count ? totalMinutes / count : null,
    medianMinutes: count ? count % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null };
}

/** Keep only nonnegative, recorded start/end intervals. */
function interval(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? (end - start) / MINUTE : null;
}

/** Identify role-bearing moves without guessing a role from an agent's lane. */
export function roleOf(kind, detail) {
  if (['reserve', 'accept', 'reject', 'verify'].includes(kind) || kind === 'release' && detail.review) return 'verifier';
  if (['claim', 'submit'].includes(kind) || kind === 'release' && !detail.review) return 'builder';
  return null;
}

/** Return an expired claim to its open queue at the recorded lease boundary. */
function expireClaim(item, at) {
  if (item.state === 'claimed' && Number.isFinite(item.leaseUntil) && item.leaseUntil <= at) {
    observeFlowStage(item, null, item.leaseUntil, 'clock');
    item.state = 'open';
    item.openAt = item.leaseUntil;
    if (item.report) item.report.returned = true;
  }
}

/** Replay one lifecycle move; its first claim and first merge survive rework and repeated receipts. */
export function moveFlowItem(item, event, detail, at) {
  expireClaim(item, at);
  if (item.windowTrace?.cursor?.stage === 'review' && Number.isFinite(item.reserve?.until) && (item.reserve.until < at || item.reserve.until === at && !['accept', 'reject'].includes(event.event_kind))) {
    observeFlowStage(item, 'reviewWait', item.reserve.until, 'clock');
  }
  switch (event.event_kind) {
    case 'add':
      item.lane = detail.lane ?? 'unknown'; item.state = 'open'; item.openAt = at; break;
    case 'claim':
      observeFlowStage(item, 'build', at, event.event_by);
      item.firstClaim ??= at; item.claimAt = at; item.state = 'claimed';
      item.leaseUntil = Date.parse(detail.leaseUntil); break;
    case 'renew': item.leaseUntil = Date.parse(detail.leaseUntil); break;
    case 'submit':
      if (item.windowTrace && item.mergeAt === undefined) {
        item.windowTrace.submissions += 1;
        if (item.windowTrace.cursor?.stage !== 'build' && !item.windowTrace.missing.includes('build')) item.windowTrace.missing.push('build');
      }
      observeFlowStage(item, 'reviewWait', at, event.event_by);
      item.submitAt = at; item.commit = detail.commit; item.verdictAt = null; item.acceptAt = null;
      item.reserve = null; item.finalReserveAt = null; item.state = 'submitted'; break;
    case 'reserve':
      observeFlowStage(item, 'review', at, event.event_by);
      item.reserve = { at, by: event.event_by, until: Date.parse(detail.until) }; break;
    case 'release':
      observeFlowStage(item, detail.review || item.state === 'submitted' ? 'reviewWait' : 'sendBackIdle', at, event.event_by);
      if (detail.review || item.state === 'submitted') item.reserve = null;
      else { item.state = 'open'; item.openAt = at; }
      break;
    case 'accept':
    case 'reject': {
      if (!item.commit || detail.commit !== item.commit) break;
      if (item.state === 'submitted') observeFlowVerdict(item, event.event_by);
      observeFlowStage(item, event.event_kind === 'accept' ? 'mergeWait' : 'sendBackIdle', at, event.event_by);
      if (event.event_kind === 'reject' && item.windowTrace && item.mergeAt === undefined) item.windowTrace.rejections += 1;
      item.verdictAt = at;
      item.finalReserveAt = item.reserve?.by === event.event_by &&
        (!Number.isFinite(item.reserve.until) || item.reserve.until >= at) ? item.reserve.at : null;
      item.reserve = null;
      if (event.event_kind === 'accept') { item.state = 'accepted'; item.acceptAt = at; }
      else { item.state = 'open'; item.openAt = at; }
      break;
    }
    case 'merged':
      if (item.windowTrace?.cursor?.stage !== 'mergeWait') observeFlowGap(item);
      observeFlowStage(item, null, at, event.event_by);
      item.mergeAt ??= at; item.state = 'merged'; break;
    case 'refreeze':
      if (detail.retainedClaim) break;
      // Ordinary refreezes return work; a retained live claim keeps its original build interval.
    case 'reopen':
    case 'escalate':
    case 'lapse':
      observeFlowStage(item, 'sendBackIdle', at, event.event_by);
      item.state = 'open'; item.openAt = at; item.reserve = null; break;
    case 'withdraw': observeFlowStage(item, null, at, event.event_by); item.state = 'withdrawn'; break;
  }
}

/** Select the current final attempt's measured stages without charging released reviews as review work. */
function itemStages(item, now) {
  const reserveAt = item.verdictAt !== null && item.verdictAt !== undefined ? item.finalReserveAt :
    item.reserve && (!Number.isFinite(item.reserve.until) || item.reserve.until >= now) ? item.reserve.at : null;
  return {
    build: { end: item.submitAt, minutes: interval(item.firstClaim, item.submitAt) },
    reviewWait: { end: reserveAt, minutes: interval(item.submitAt, reserveAt) },
    review: { end: item.verdictAt, minutes: interval(reserveAt, item.verdictAt) },
    mergeWait: { end: item.mergeAt, minutes: interval(item.acceptAt, item.mergeAt) },
  };
}

/** Count current queues and name the longest wait, with item id as the deterministic tie breaker. */
function queuesFrom(items, now) {
  const queues = Object.fromEntries(['open', 'claimed', 'submitted', 'accepted'].map(state => [state, { size: 0, oldest: null }]));
  const unreviewed = { size: 0, oldest: null };
  const openByLane = new Map();
  const accepted = [];
  for (const item of items) {
    const current = item.state === 'claimed' && Number.isFinite(item.leaseUntil) && item.leaseUntil <= now
      ? { ...item, state: 'open', openAt: item.leaseUntil }
      : item;
    const queue = queues[current.state];
    if (!queue) continue;
    queue.size += 1;
    const start = { open: current.openAt, claimed: current.claimAt, submitted: current.submitAt, accepted: current.acceptAt }[current.state];
    const ageMinutes = interval(start, now);
    if (ageMinutes !== null && (!queue.oldest || ageMinutes > queue.oldest.ageMinutes ||
      ageMinutes === queue.oldest.ageMinutes && current.id < queue.oldest.id)) queue.oldest = { id: current.id, since: new Date(start).toISOString(), ageMinutes };
    if (current.state === 'submitted' && (!current.reserve || Number.isFinite(current.reserve.until) && current.reserve.until <= now)) {
      unreviewed.size += 1;
      if (ageMinutes !== null && (!unreviewed.oldest || ageMinutes > unreviewed.oldest.ageMinutes ||
        ageMinutes === unreviewed.oldest.ageMinutes && current.id < unreviewed.oldest.id)) {
        unreviewed.oldest = { id: current.id, since: new Date(start).toISOString(), ageMinutes };
      }
    }
    if (current.state === 'open') openByLane.set(current.lane, (openByLane.get(current.lane) ?? 0) + 1);
    if (current.state === 'accepted') accepted.push(current.id);
  }
  return { queues, unreviewed, openByLane, accepted: accepted.sort((a, b) => a - b) };
}

/** Attribute last-hour activity using the latest recorded role, including a prior role when only shouts are recent. */
function activeFrom(actors, now) {
  const agents = [...actors].filter(actor => actor.lastAt >= now - 60 * MINUTE && actor.lastAt <= now)
    .map(({ id, lane, role }) => ({ id, lane, role })).sort((a, b) => a.id.localeCompare(b.id));
  const roles = { builder: 0, verifier: 0, coordinator: 0, unknown: 0 };
  const lanes = new Map();
  for (const actor of agents) {
    roles[actor.role] += 1;
    lanes.set(actor.lane, (lanes.get(actor.lane) ?? 0) + 1);
  }
  return { total: agents.length, agents, roles, lanes: Object.fromEntries([...lanes].sort(([a], [b]) => a.localeCompare(b))) };
}

/** Recommend exactly one documented action for the largest measured completed-cycle stage. */
function recommendation(stage, { activeAgents, queues, openByLane, accepted, counts, stages }) {
  if (stage === 'reviewWait') {
    if (activeAgents.roles.verifier < activeAgents.roles.builder / 4) return 'add a verifier';
    return queues.submitted.oldest ? `review the oldest submission first (#${queues.submitted.oldest.id})` :
      'review the oldest submission first (none waiting)';
  }
  if (stage === 'build') {
    if (counts.rejectionShare > 0.3) return `tighten criteria or briefs: ${counts.rejections} of ${counts.submissions} submissions were sent back`;
    const lane = [...openByLane].sort(([a, first], [b, second]) => second - first || a.localeCompare(b))[0]?.[0];
    return lane ? `add a builder in ${lane}` : 'add a builder when open work is available';
  }
  if (stage === 'review') return `reviews are slow (median ${duration(stages.review.medianMinutes)}): check how long the frozen checks take`;
  const named = accepted.slice(0, 3).map(id => `#${id}`).join(', ');
  const more = accepted.length > 3 ? ` +${accepted.length - 3} more` : '';
  return accepted.length ? `land the accepted items: ${named}${more}` : 'land the accepted items (none waiting)';
}

/** An empty lifecycle fold: the state prepareFlowHistory accumulates event by event. */
function newFlowFold(traceWindow, agentIds) {
  return { items: new Map(), actors: new Map(), dailyEvents: [], reportPolicy: newReportPolicy(), traceWindow, agentIds };
}

/** Fold one event into the lifecycle state, in event order. */
function foldFlowEvent(fold, event, comparisonWindows) {
  const { items, actors, dailyEvents, reportPolicy, traceWindow, agentIds } = fold;
  const detail = proofEventDetail(event);
  const at = Date.parse(event.event_at);
  const id = event.event_by;
  if (agentIds ? agentIds.has(id) : !['board', 'person', 'clock'].includes(id)) {
    if (!actors.has(id)) actors.set(id, { id, lane: 'unknown', role: 'unknown', lastAt: at });
    const actor = actors.get(id);
    if (event.event_kind === 'join' && detail.lane) actor.lane = detail.lane;
    actor.role = id === 'coordinator' ? 'coordinator' : roleOf(event.event_kind, detail) ?? actor.role;
    actor.lastAt = at;
  }
  const reporting = reportEvent(event, detail);
  for (const id of reporting ? affectedReportItems(reportPolicy, event, detail) : []) {
    const affected = items.get(id);
    if (affected) advanceReport(affected, reportPolicy, at, comparisonWindows);
  }
  if (reporting) recordReportPolicy(reportPolicy, event, detail, items.get(event.item_id));
  if (event.item_id === null || event.item_id === undefined) return;
  if (!items.has(event.item_id)) items.set(event.item_id, { id: event.item_id, lane: 'unknown', ...(traceWindow ? { windowTrace: newWindowTrace() } : {}) });
  const item = items.get(event.item_id);
  if (event.event_kind === 'add') dailyEvents.push({ at, kind: 'added' });
  if (event.event_kind === 'merged' && item.mergeAt === undefined) dailyEvents.push({ at, kind: 'merged' });
  if (reporting) { advanceReport(item, reportPolicy, at, comparisonWindows); prepareReportMove(item, event, detail); }
  if (reporting) moveFlowItem(item, event, detail, at);
  if (reporting) { recordReport(item, event, detail); indexReportItem(reportPolicy, item); }
}

/** A deep copy of a fold, so a kept fold can be extended or replayed further without changing it. */
function copiedFold(fold) {
  const { traceWindow, agentIds, ...state } = fold;
  const copy = structuredClone(state);
  safeReportPolicy(copy.reportPolicy);
  return { ...copy, traceWindow, agentIds };
}

/** The immutable prepared lifecycle a fold describes; the fold itself is left as it was. */
function frozenFold(fold) {
  const { items, actors, dailyEvents, reportPolicy } = copiedFold(fold);
  const frozenItems = [...items.values()].map((item) => Object.freeze({
    ...item,
    ...(item.report ? { report: frozenReport(item.report) } : {}),
    ...(item.windowTrace ? { windowTrace: frozenWindowTrace(item.windowTrace) } : {}),
    ...(item.reserve ? { reserve: Object.freeze({ ...item.reserve }) } : {}),
  }));
  const frozenActors = [...actors.values()].map((actor) => Object.freeze({ ...actor }));
  const frozenDailyEvents = dailyEvents.map((event) => Object.freeze(event));
  return Object.freeze({ reportPolicy: frozenReport(reportPolicy), items: Object.freeze(frozenItems), actors: Object.freeze(frozenActors), dailyEvents: Object.freeze(frozenDailyEvents) });
}

/** Each history's kept folds, by its first event row: why a build that only appended events folds only those [C7]. */
const keptFolds = new WeakMap();

/**
 * The kept fold of a history under one option set, when the fold's rows are still this history's prefix, or a new
 * empty one. A history's rows never change once recorded, so folding the rows after the kept ones is folding it all.
 */
function keptFold(history, key, make) {
  const first = history[0];
  if (!first) return { fold: make(), position: 0, maxAt: -Infinity, last: null, key };
  const kept = keptFolds.get(first) ?? [];
  let entry = kept.find(candidate => candidate.key === key && candidate.position <= history.length
    && (candidate.position === 0 || history[candidate.position - 1] === candidate.last));
  if (!entry) {
    entry = { fold: make(), position: 0, maxAt: -Infinity, last: null, key };
    kept.unshift(entry);
    while (kept.length > 4) kept.pop();
    keptFolds.set(first, kept);
  }
  return entry;
}

/** Compile immutable lifecycle facts once so API cache hits only need a time-specific projection. */
export function prepareFlowHistory(history, { window: traceWindow = false, comparisonWindows, agentIds } = {}) {
  if (comparisonWindows) {
    const fold = newFlowFold(traceWindow, agentIds);
    for (const event of history) foldFlowEvent(fold, event, comparisonWindows);
    return frozenFold(fold);
  }
  const key = `prepared:${traceWindow}:${agentIds ? [...agentIds].sort().join('\0') : '*'}`;
  const entry = keptFold(history, key, () => newFlowFold(traceWindow, agentIds));
  for (; entry.position < history.length; entry.position++) foldFlowEvent(entry.fold, history[entry.position], undefined);
  entry.last = history.at(-1) ?? null;
  return frozenFold(entry.fold);
}

/** Whether a history is in strictly increasing event id order, as the board records it. */
function inEventOrder(history) {
  for (let index = 1; index < history.length; index++) if (!(history[index - 1].event_id < history[index].event_id)) return false;
  return true;
}

/**
 * Compare one complete native event prefix at an explicit observation clock; absent history is not fabricated.
 *
 * A history in event order keeps a fold of its events up to the earliest window's start: those events charge no
 * window time, so each comparison replays only the events since, onto a copy of that fold [C7].
 */
export function compareFlowWindows(history, { now, windowMinutes, complete, gone } = {}) {
  const bounds = comparisonBounds(windowMinutes, now);
  if (complete !== true) return { version: 1, available: false, reason: 'complete event history is required for comparison' };
  const start = Math.min(...bounds.map(range => range.start));
  if (!inEventOrder(history) || !Number.isFinite(start)) {
    const selected = history.filter(event => Number.isFinite(Date.parse(event.event_at)) && Date.parse(event.event_at) <= now)
      .sort((a, b) => a.event_id - b.event_id);
    const prepared = prepareFlowHistory(selected, { comparisonWindows: bounds });
    return projectWindowComparison(selected, prepared, bounds, projectReportWindows(prepared.items, prepared.reportPolicy, now, bounds), gone);
  }
  let entry = keptFold(history, 'compare', () => newFlowFold(false, undefined));
  if (entry.maxAt > start) {
    keptFolds.get(history[0]).splice(keptFolds.get(history[0]).indexOf(entry), 1);
    entry = keptFold(history, 'compare', () => newFlowFold(false, undefined));
  }
  for (; entry.position < history.length; entry.position++) {
    const event = history[entry.position];
    const at = Date.parse(event.event_at);
    if (Number.isFinite(at)) {
      if (at > start) break;
      foldFlowEvent(entry.fold, event, undefined);
      entry.maxAt = Math.max(entry.maxAt, at);
    }
    entry.last = event;
  }
  const fold = copiedFold(entry.fold);
  for (let position = entry.position; position < history.length; position++) {
    const event = history[position];
    const at = Date.parse(event.event_at);
    if (Number.isFinite(at) && at <= now) foldFlowEvent(fold, event, bounds);
  }
  const prepared = frozenFold(fold);
  // The window projections skip events past each window's end, so the whole history stands for the selected one.
  return projectWindowComparison(history, prepared, bounds, projectReportWindows(prepared.items, prepared.reportPolicy, now, bounds), gone);
}

/** Project current queues and time windows from compiled facts without mutating the cached snapshot. */
export function projectFlowStats(prepared, boundary, now, counts, { windowMinutes, executionCapacity } = {}) {
  const selected = at => !boundary || at >= Date.parse(boundary);
  const daily = new Map();
  for (const event of prepared.dailyEvents) {
    if (!selected(event.at)) continue;
    const date = new Date(event.at).toISOString().slice(0, 10);
    if (!daily.has(date)) daily.set(date, { date, added: 0, merged: 0 });
    daily.get(date)[event.kind] += 1;
  }
  const samples = Object.fromEntries(STAGES.map(stage => [stage, []]));
  const cycleTotals = Object.fromEntries(STAGES.map(stage => [stage, 0]));
  let completedItems = 0;
  let fullyMeasuredCycles = 0;
  const unmeasured = Object.fromEntries(STAGES.map(stage => [stage, 0]));
  for (const item of prepared.items) {
    const measured = itemStages(item, now);
    for (const stage of STAGES) {
      const sample = measured[stage];
      if (sample.minutes !== null && selected(sample.end)) samples[stage].push(sample.minutes);
    }
    if (!Number.isFinite(item.mergeAt) || !selected(item.mergeAt)) continue;
    completedItems += 1;
    for (const stage of STAGES) if (measured[stage].minutes === null) unmeasured[stage] += 1;
    if (STAGES.some(stage => measured[stage].minutes === null)) continue;
    fullyMeasuredCycles += 1;
    for (const stage of STAGES) cycleTotals[stage] += measured[stage].minutes ?? 0;
  }
  const stages = Object.fromEntries(STAGES.map(stage => [stage, { ...summarize(samples[stage]), unmeasuredCompleted: unmeasured[stage] }]));
  const queueData = queuesFrom(prepared.items, now);
  const activeAgents = activeFrom(prepared.actors, now);
  const stage = STAGES.reduce((largest, next) => cycleTotals[next] > cycleTotals[largest] ? next : largest);
  const totalCycleMinutes = Object.values(cycleTotals).reduce((sum, value) => sum + value, 0);
  const bottleneck = fullyMeasuredCycles ? {
    stage, share: totalCycleMinutes ? cycleTotals[stage] / totalCycleMinutes : 0,
    completedItems, fullyMeasuredCycles, totalCycleMinutes, lowConfidence: fullyMeasuredCycles < completedItems / 2,
    message: `${LABELS[stage]} has the largest share of cycle time; bottleneck from ${fullyMeasuredCycles} fully measured cycles of ${completedItems}`,
    recommendation: recommendation(stage, { ...queueData, activeAgents, counts, stages }),
  } : { stage: null, share: null, completedItems, fullyMeasuredCycles: 0, totalCycleMinutes: 0, lowConfidence: completedItems > 0,
    message: completedItems ? `not enough measured flow to name a bottleneck (${completedItems} items completed since ${boundary ?? 'the beginning'}, none with every stage measured)` :
      `not enough flow to name a bottleneck (0 items completed since ${boundary ?? 'the beginning'})`, recommendation: null };
  const flowWindow = windowMinutes === undefined ? undefined : {
    ...projectFlowWindow(prepared, windowMinutes, now),
    ...(executionCapacity ? { executionCapacity } : {}),
  };
  const report = projectReport(prepared.reportItems ?? prepared.items, prepared.reportPolicy, now);
  return { report, ...(flowWindow === undefined ? {} : { window: flowWindow }), asOf: new Date(now).toISOString(), stages, queues: queueData.queues, unreviewed: queueData.unreviewed, daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    submitsPerMerged: completedItems ? counts.submissions / completedItems : 0, activeAgents, bottleneck };
}

/** Derive flow from an immutable history with an injectable observation time for fixtures. */
export function flowStats(history, boundary, now, counts, options = {}) {
  return projectFlowStats(prepareFlowHistory(history, { window: options.windowMinutes !== undefined, agentIds: options.agentIds }), boundary, now, counts, options);
}

/** Format elapsed minutes in rounded human units while JSON retains its original numeric precision. */
function duration(value) {
  if (value === null) return 'unmeasured';
  const rounded = Math.round(value);
  if (rounded < 60) return `${rounded} min`;
  if (rounded < 24 * 60) return `${Math.floor(rounded / 60)} h ${rounded % 60} min`;
  const hours = Math.floor(rounded / 60);
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** Keep dimensionless counts and percentages compact without changing JSON values. */
function number(value) { return value === null ? 'unmeasured' : String(Number(value.toFixed(2))); }

/** Render all flow dimensions and the evidence behind the single recommended action. */
export function flowLines(flow) {
  const lines = STAGES.map(stage => {
    const row = flow.stages[stage];
    return `${LABELS[stage]}: average ${duration(row.averageMinutes)} · median ${duration(row.medianMinutes)} · ${row.count} measured; ${row.unmeasuredCompleted} of ${flow.bottleneck.completedItems} completed items unmeasured`;
  });
  for (const [state, queue] of Object.entries(flow.queues)) {
    lines.push(`${state} queue: ${queue.size} · oldest ${queue.oldest ? `#${queue.oldest.id} (${duration(queue.oldest.ageMinutes)})` : 'none'}`);
  }
  lines.push(`per day: ${flow.daily.map(row => `${row.date}: ${row.added} added, ${row.merged} merged`).join('; ') || 'none'}`);
  lines.push(`${number(flow.submitsPerMerged)} submissions per merged item`);
  lines.push(`active in the last hour: ${flow.activeAgents.total} agents · roles ${Object.entries(flow.activeAgents.roles).map(([role, count]) => `${role} ${count}`).join(', ')} · lanes ${Object.entries(flow.activeAgents.lanes).map(([lane, count]) => `${lane} ${count}`).join(', ') || 'none'}`);
  const bottleneck = flow.bottleneck;
  lines.push(`bottleneck: ${bottleneck.message}${bottleneck.share === null ? '' : ` (${number(bottleneck.share * 100)}%)`}${bottleneck.lowConfidence ? ' · low confidence' : ''}`);
  if (bottleneck.recommendation) lines.push(`next: ${bottleneck.recommendation}`);
  return lines;
}

/** Render the detailed report without changing the existing compact flow-summary contract. */
export function flowReportLines(flow) {
  const lines = [];
  const percent = value => value === null ? 'unmeasured' : `${number(value * 100)}%`;
  if (flow.report?.items) {
    lines.push('flow report (all-time): waiting for an agent; filed for later; building; review; landing; rework');
    const labels = { ready: 'waiting for an agent', later: 'filed for later', build: 'building', reviewWait: 'waiting for review', review: 'reviewing', mergeWait: 'waiting to land', rework: 'rework' };
    for (const [kind, rows] of [['item', flow.report.items], ['lane', flow.report.lanes], ['milestone', flow.report.milestones]]) {
      for (const row of rows) {
        const name = kind === 'item' ? `#${row.id}` : row.lane ?? row.milestone ?? 'unknown';
        lines.push(`${kind} ${name}: ${Object.entries(row.stages).map(([key, value]) => `${labels[key]} ${duration(value.minutes)} (${value.unknown} unknown)`).join(' · ')}`);
        lines.push(`  first try ${percent(row.firstTry.rate)} (${row.firstTry.accepted}/${row.firstTry.decided}; ${row.firstTry.unknown} unknown); submissions per landed ${number(row.submissionsPerLanded)}`);
        lines.push(`  size buckets: ${Object.entries(row.sizeBuckets).map(([key, value]) => `${key} ${percent(value.rate)} (${value.accepted}/${value.decided}; ${value.unknown} unknown)`).join(' · ')}`);
      }
    }
  } else lines.push('flow report: unavailable until the next writer rebuilds historical accounting');
  return lines;
}

/** Name a tripped documented threshold using the same measured flow and action as stats [N32]. */
export function flowAlertLine(flow) {
  const average = flow.stages.reviewWait.averageMinutes;
  const oldest = flow.unreviewed.oldest;
  const thresholds = [];
  if (average > 60) thresholds.push(`review wait average ${duration(average)} (${flow.stages.reviewWait.count} measured; > ${duration(60)})`);
  if (oldest?.ageMinutes > 180) thresholds.push(`unreviewed #${oldest.id} waiting ${duration(oldest.ageMinutes)} (> ${duration(180)})`);
  if (!thresholds.length) return null;
  const bottleneck = flow.bottleneck;
  const measured = bottleneck.stage === null ? 'bottleneck: not measured yet' :
    `bottleneck: ${LABELS[bottleneck.stage]} (${number(bottleneck.share * 100)}% of ${duration(bottleneck.totalCycleMinutes)} measured cycle time); next: ${bottleneck.recommendation}`;
  return `flow: ${thresholds.join('; ')}; ${measured}`;
}
import { frozenReport } from './flow/report.js';
