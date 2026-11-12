/** Window projections of the canonical lifecycle observer; absent evidence is never a zero [R1,R2]. */
import { Refused } from '../../../../kernel/browser.js';
import { proofEventDetail } from '../../../../kernel/browser.js';
import { NEXT_IDLE_ENGINE } from '../../../../state/light.js';
import { flowWindowBounds } from '../../../../seats/browser.js';
export { flowWindowBounds } from '../../../../seats/browser.js';

const MINUTE = 60_000;
export const WINDOW_STAGES = ['build', 'reviewWait', 'review', 'sendBackIdle', 'mergeWait'];
const TARGETS = { build: 240, reviewWait: 30, review: 60, sendBackIdle: 30, mergeWait: 60 };
const LABELS = { build: 'building', reviewWait: 'waiting for a reviewer', review: 'in review',
  sendBackIdle: 'sent back, idle', mergeWait: 'waiting to land' };

/** Enable interval observations only for an explicitly requested window, not persistent proof counters. */
export function newWindowTrace() {
  return { cursor: null, entries: [], intervals: [], missing: [], submissions: 0, rejections: 0 };
}

/** Observe a transition already accepted by moveFlowItem, without replaying another state machine. */
export function observeFlowStage(item, stage, at, by) {
  const trace = item.windowTrace;
  if (!trace || item.mergeAt !== undefined) return;
  const prior = trace.cursor;
  if (prior?.stage === stage) return;
  if (prior && Number.isFinite(at) && at >= prior.start) {
    trace.intervals.push({ ...prior, end: at, completedBy: by });
  } else if (prior && !trace.missing.includes(prior.stage)) trace.missing.push(prior.stage);
  trace.cursor = stage ? { stage, start: at, by } : null;
  if (trace.cursor) trace.entries.push({ ...trace.cursor });
}

/** A verdict without a recorded reservation cannot divide waiting from review work. */
export function observeFlowVerdict(item, by) {
  const trace = item.windowTrace;
  if (!trace || trace.cursor?.stage === 'review' && trace.cursor.by === by) return;
  for (const stage of ['reviewWait', 'review']) if (!trace.missing.includes(stage)) trace.missing.push(stage);
  trace.cursor = null;
}

/** Preserve a missing required boundary without substituting a different move's timestamp. */
export function observeFlowGap(item) {
  const trace = item.windowTrace;
  if (!trace?.cursor) return;
  if (!trace.missing.includes(trace.cursor.stage)) trace.missing.push(trace.cursor.stage);
  trace.cursor = null;
}

/** Freeze nested observations along with the existing immutable prepared lifecycle. */
export function frozenWindowTrace(trace) {
  return Object.freeze({ ...trace, cursor: trace.cursor ? Object.freeze({ ...trace.cursor }) : null,
    entries: Object.freeze(trace.entries.map(row => Object.freeze({ ...row }))),
    intervals: Object.freeze(trace.intervals.map(row => Object.freeze({ ...row }))),
    missing: Object.freeze([...trace.missing]) });
}

/** Accept positive durations with an explicit unit; timestamps continue to use the separate --since option. */
export function flowWindowMinutes(value) {
  const match = /^(\d+(?:\.\d+)?)(m|h|d)$/u.exec(String(value));
  const minutes = match ? Number(match[1]) * { m: 1, h: 60, d: 1440 }[match[2]] : NaN;
  if (!(minutes > 0) || !Number.isFinite(minutes)) {
    throw new Refused('USAGE', 'use pullboard stats --window with a positive duration, for example --window 6h, --window 30m or --window 1d');
  }
  return minutes;
}

/** The reference uses discrete quarter indices and the arithmetic median, including even sample counts. */
function quartiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const middle = Math.floor(count / 2);
  return { fastQuarterMinutes: count ? sorted[Math.min(count - 1, Math.floor(count / 4))] : null,
    medianMinutes: count ? count % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null,
    slowQuarterMinutes: count ? sorted[Math.min(count - 1, Math.floor(count * 3 / 4))] : null,
    worstMinutes: count ? sorted.at(-1) : null };
}

/** Classify an observed tail; reviewer eligibility stays explicitly unknown without a recorded observation. */
function tailItem(item, stage, minutes) {
  const trace = item.windowTrace;
  const cause = stage === 'build' ? trace.submissions >= 3 ? 'rework' : 'long-build'
    : { reviewWait: 'reviewer-wait', review: 'slow-review', sendBackIdle: 'send-back-idle', mergeWait: 'landing-queue' }[stage];
  return { id: item.id, minutes, cause, submissions: trace.submissions, rejections: trace.rejections,
    ...(stage === 'reviewWait' ? { eligibility: 'unmeasured' } : {}) };
}

/** Sum only closed intervals; an omitted or incomplete stage is not a measured zero-minute visit. */
function stageMinutes(item, stage) {
  const trace = item.windowTrace;
  if (!trace || trace.missing.includes(stage)) return null;
  const rows = trace.intervals.filter(row => row.stage === stage && row.end <= item.mergeAt);
  return rows.length ? rows.reduce((sum, row) => sum + (row.end - row.start) / MINUTE, 0) : null;
}

/** Close a still-held cursor at its recorded expiry for observation-only traffic counts. */
function trafficTrace(item, now) {
  const trace = item.windowTrace;
  if (!trace?.cursor) return trace;
  const { stage } = trace.cursor;
  const until = stage === 'build' ? item.leaseUntil : stage === 'review' ? item.reserve?.until : NaN;
  if (!Number.isFinite(until) || until > now || until < trace.cursor.start) return trace;
  const entries = stage === 'review' ? [...trace.entries, { stage: 'reviewWait', start: until, by: 'clock' }] : trace.entries;
  return { ...trace, entries, intervals: [...trace.intervals, { ...trace.cursor, end: until, completedBy: 'clock' }] };
}

/** Count visits in the window, including unfinished work, and only name seats observed doing that work. */
function stageTraffic(items, stage, since, now) {
  let arrivals = 0, completions = 0;
  const seats = new Set();
  for (const item of items) {
    const trace = trafficTrace(item, now);
    for (const row of trace?.entries ?? []) {
      if (row.stage !== stage || row.start < since || row.start > now) continue;
      arrivals += 1;
      if (['build', 'review'].includes(stage) && row.by && !['clock', 'board', 'person'].includes(row.by)) seats.add(row.by);
    }
    for (const row of trace?.intervals ?? []) {
      if (row.stage !== stage || row.end < since || row.end > now) continue;
      completions += 1;
      if (row.completedBy && !['clock', 'board', 'person'].includes(row.completedBy)) seats.add(row.completedBy);
    }
  }
  return { arrivals, completions, seats: [...seats].sort() };
}

/** Project landed item totals and stage traffic from the same prepared canonical lifecycle facts. */
export function projectFlowWindow(prepared, minutes, now) {
  const bounds = flowWindowBounds(minutes, now);
  const since = now - minutes * MINUTE;
  const landed = prepared.items.filter(item => item.mergeAt >= since && item.mergeAt <= now);
  const stages = Object.fromEntries(WINDOW_STAGES.map(stage => {
    const measured = landed.map(item => ({ item, minutes: stageMinutes(item, stage) })).filter(row => row.minutes !== null);
    const values = measured.map(row => row.minutes);
    return [stage, { count: values.length, ...quartiles(values), totalMinutes: values.reduce((sum, value) => sum + value, 0),
      unmeasuredCompleted: landed.length - values.length, targetMinutes: TARGETS[stage],
      overTargetMinutes: values.reduce((sum, value) => sum + Math.max(0, value - TARGETS[stage]), 0),
      ...stageTraffic(prepared.items, stage, since, now),
      tail: measured.sort((a, b) => b.minutes - a.minutes || a.item.id - b.item.id).slice(0, 3)
        .map(row => tailItem(row.item, stage, row.minutes)) }];
  }));
  const constraint = WINDOW_STAGES.reduce((largest, stage) => stages[stage].overTargetMinutes > (largest ? stages[largest].overTargetMinutes : 0) ? stage : largest, null);
  return { ...bounds,
    landedItems: landed.length,
    arrivals: { added: prepared.dailyEvents.filter(event => event.kind === 'added' && event.at >= since && event.at <= now).length, landed: landed.length },
    stages, constraint: { stage: constraint, overTargetMinutes: constraint ? stages[constraint].overTargetMinutes : 0 } };
}

/** Render the measured window without substituting zero for absent quartiles or undocumented eligibility. */
export function flowWindowLines(flowWindow) {
  const time = value => value === null ? 'unmeasured' : `${Number(value.toFixed(2))} min`;
  return [`flow window: ${flowWindow.since} to ${flowWindow.until} · ${flowWindow.arrivals.added} added · ${flowWindow.landedItems} landed`,
    ...WINDOW_STAGES.flatMap(stage => {
      const row = flowWindow.stages[stage];
      return [`${LABELS[stage]}: ${row.count} measured · fast quarter ${time(row.fastQuarterMinutes)} · median ${time(row.medianMinutes)} · slow quarter ${time(row.slowQuarterMinutes)} · worst ${time(row.worstMinutes)} · ${row.unmeasuredCompleted} unmeasured`,
        `  ${row.arrivals} arrivals · ${row.completions} completions · seats ${row.seats.join(', ') || 'none observed'} · ${time(row.overTargetMinutes)} over ${time(row.targetMinutes)} target`,
        ...row.tail.map(item => `  #${item.id}: ${time(item.minutes)} · ${item.cause}${item.eligibility ? ' (eligibility unmeasured; check eligible reviewers)' : ''}`)];
    }),
    `constraint: ${flowWindow.constraint.stage ? LABELS[flowWindow.constraint.stage] : 'none measured over target'} · ${time(flowWindow.constraint.overTargetMinutes)} over target`];
}

const HOUR = 3_600_000;
const IDLE_REASONS = ['nothing-eligible', 'held', 'review-family', 'main-red', 'focus', 'unknown'];
const COMPARE_STAGES = { build: 'build', rework: 'rework', reviewWait: 'reviewWait', review: 'review', land: 'mergeWait' };

/** Adjacent count windows are open at the start and closed at the end, so no boundary move is counted twice. */
export function comparisonBounds(minutes, now) {
  const current = flowWindowBounds(minutes, now);
  const previous = flowWindowBounds(minutes, now - minutes * MINUTE);
  return [previous, current].map(bounds => ({ ...bounds, start: Date.parse(bounds.since), end: Date.parse(bounds.until) }));
}

/** A missing denominator is unmeasured, never a fictitious zero or infinity. */
function comparisonRatio(value, denominator) { return denominator > 0 && value !== null ? value / denominator : null; }

/** The event kinds that open, renew, close or explain a seat's held work, the only ones a seat window replays. */
const SEAT_KINDS = new Set(['claim', 'renew', 'reserve', 'submit', 'lapse', 'withdraw', 'reopen', 'release', 'accept', 'reject', 'patch', 'next-idle']);
/** The event kinds a comparison window counts. */
const COUNTED_KINDS = new Set(['submit', 'reject', 'shout']);
/** Each indexed history's facts, by its first event row: the indexes of the histories that row starts, newest first. */
const indexes = new WeakMap();

/**
 * Index a history once and extend the index as the history grows, so each window replays only the events that move
 * a seat or a count [C7]. Why: a build compares two windows, and each walked every event of the board's history
 * twice, parsing its time and detail; on a board of hundreds of thousands of events that was most of a build.
 *
 * Each seat-work event keeps the latest and earliest finite time among the other events since the one before it,
 * so an expired hold closes exactly where the walk of every event closed it; a gap that straddles a window's end
 * is walked from the history itself.
 *
 * @param {any[]} history Events in event id order; an index serves only a history its rows are a prefix of.
 */
function historyIndex(history) {
  const first = history[0];
  if (!first) return { length: 0, history, joins: [], seatEvents: [], counted: [], agentTimes: new Map() };
  const kept = indexes.get(first) ?? [];
  let index = kept.find(candidate => candidate.length <= history.length && history[candidate.length - 1] === candidate.last);
  if (!index) {
    index = { length: 0, last: null, history, joins: [], seatEvents: [], counted: [], agentTimes: new Map(), gap: { from: 0, max: -Infinity, min: Infinity } };
    kept.unshift(index);
    while (kept.length > 2) kept.pop();
    indexes.set(first, kept);
  }
  for (let position = index.length; position < history.length; position++) {
    const event = history[position];
    const at = Date.parse(event.event_at);
    const finite = Number.isFinite(at);
    if (finite) {
      const times = index.agentTimes.get(event.event_by);
      if (times) times.push(at); else index.agentTimes.set(event.event_by, [at]);
    }
    if (event.event_kind === 'join') index.joins.push({ event, at });
    if (COUNTED_KINDS.has(event.event_kind)) index.counted.push({ event, at });
    if (SEAT_KINDS.has(event.event_kind)) {
      index.seatEvents.push({ event, at, position, gap: index.gap });
      index.gap = { from: position + 1, max: -Infinity, min: Infinity };
    } else if (finite) {
      if (at > index.gap.max) index.gap.max = at;
      if (at < index.gap.min) index.gap.min = at;
    }
  }
  index.length = history.length;
  index.last = history.at(-1);
  index.history = history;
  return index;
}

/** The latest time, at most `end`, among the other events between two seat-work events. */
function gapReach(index, gap, to, end) {
  if (gap.max <= end) return gap.max;
  if (gap.min > end) return -Infinity;
  let reach = -Infinity;
  for (let position = gap.from; position < to; position++) {
    const at = Date.parse(index.history[position].event_at);
    if (Number.isFinite(at) && at <= end && at > reach) reach = at;
  }
  return reach;
}

/** Preserve the Dashboard's event-observed seat cohort and union overlapping work, with building first. */
function seatWindow(history, bounds, gone = new Map()) {
  const joined = new Map(), last = new Map(), work = new Map(), segments = [], observations = new Map();
  const index = historyIndex(history);
  for (const { event, at } of index.joins) {
    if (!(at <= bounds.end) || joined.has(event.event_by) || ['coordinator', 'board', 'person', 'clock'].includes(event.event_by)) continue;
    const detail = proofEventDetail(event);
    if (detail.lane && detail.lane !== 'coordinator') joined.set(event.event_by, at);
  }
  for (const agent of joined.keys()) {
    let latest = -Infinity;
    for (const at of index.agentTimes.get(agent) ?? []) if (at <= bounds.end && at > latest) latest = at;
    if (latest > -Infinity) last.set(agent, latest);
  }
  /** Close a real held interval only at its recorded transition or lease boundary. */
  function close(key, at) {
    const held = work.get(key);
    if (!held) return;
    const end = Math.min(at, held.until);
    if (end > held.start) segments.push({ ...held, end });
    work.delete(key);
  }
  /** Close every hold an event at `at` finds expired. */
  function expire(at) {
    while (deadlines.length && deadlines[0].until <= at) {
      const { key, held, until } = popDeadline();
      if (work.get(key) === held && held.until === until) close(key, until);
    }
  }
  /**
   * Every hold's deadline, earliest first, so expiring holds costs only the holds that expire. A renewed hold
   * pushes its new deadline; the old entry no longer matches and is dropped when it surfaces.
   */
  const deadlines = [];
  /** Track a hold's current deadline. */
  function pushDeadline(key, held) {
    const entry = { key, held, until: held.until };
    let at = deadlines.push(entry) - 1;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (deadlines[parent].until <= entry.until) break;
      deadlines[at] = deadlines[parent]; deadlines[parent] = entry; at = parent;
    }
  }
  /** Take the earliest deadline. */
  function popDeadline() {
    const top = deadlines[0], last = deadlines.pop();
    if (deadlines.length) {
      deadlines[0] = last;
      let at = 0;
      for (;;) {
        const left = 2 * at + 1, right = left + 1;
        let least = at;
        if (left < deadlines.length && deadlines[left].until < deadlines[least].until) least = left;
        if (right < deadlines.length && deadlines[right].until < deadlines[least].until) least = right;
        if (least === at) break;
        [deadlines[at], deadlines[least]] = [deadlines[least], deadlines[at]];
        at = least;
      }
    }
    return top;
  }
  /** Record the cause next actually observed; invalid or older observations explicitly mean unknown. */
  function idle(event, at, detail) {
    const reason = detail.version === 1 && Number.isSafeInteger(detail.engine) && detail.engine >= NEXT_IDLE_ENGINE
      && IDLE_REASONS.includes(detail.reason) ? detail.reason : 'unknown';
    const rows = observations.get(event.event_by) ?? [];
    rows.push({ at, reason }); observations.set(event.event_by, rows);
  }
  for (const { event, at, position, gap } of index.seatEvents) {
    if (work.size) {
      const reach = gapReach(index, gap, position, bounds.end);
      if (reach > -Infinity) expire(reach);
    }
    if (!Number.isFinite(at) || at > bounds.end) continue;
    const detail = proofEventDetail(event), id = event.item_id, by = event.event_by;
    expire(at);
    if (event.event_kind === 'next-idle') idle(event, at, detail);
    if (['claim', 'reserve'].includes(event.event_kind)) {
      const rows = observations.get(by) ?? [];
      rows.push({ at, reason: 'unknown' }); observations.set(by, rows);
    }
    if (id === null || id === undefined) continue;
    if (['claim', 'renew', 'reserve'].includes(event.event_kind)) {
      const kind = event.event_kind === 'reserve' ? 'review' : 'build', key = `${kind}:${id}`, held = work.get(key);
      const until = Date.parse(kind === 'review' ? detail.until : detail.leaseUntil);
      if (held?.actor !== by) {
        close(key, at);
        const opened = { actor: by, kind, start: at, until: Number.isFinite(until) ? until : at };
        work.set(key, opened); pushDeadline(key, opened);
      } else if (Number.isFinite(until)) { held.until = until; pushDeadline(key, held); }
    }
    if (['submit', 'lapse', 'withdraw', 'reopen'].includes(event.event_kind) || event.event_kind === 'release' && !detail.review) close(`build:${id}`, at);
    if (['accept', 'reject', 'reopen', 'withdraw', 'patch'].includes(event.event_kind) || event.event_kind === 'release' && detail.review) close(`review:${id}`, at);
  }
  for (const [key] of [...work]) close(key, bounds.end);
  let budget = 0, occupied = 0, seats = 0;
  const reasons = Object.fromEntries(IDLE_REASONS.map(reason => [reason, 0]));
  const unknownSeats = new Set(segments.filter(row => !joined.has(row.actor) && row.start < bounds.end && row.end > bounds.start).map(row => row.actor));
  // Each actor's holds that reach into the window, grouped once rather than filtered from every hold per seat.
  const inWindow = new Map();
  for (const row of segments) {
    if (!(row.start < bounds.end && row.end > bounds.start)) continue;
    const rows = inWindow.get(row.actor);
    if (rows) rows.push(row); else inWindow.set(row.actor, [row]);
  }
  for (const [agent, joinAt] of joined) {
    const start = Math.max(bounds.start, joinAt);
    // A seat whose session ended stops counting where it went gone: its quiet time afterwards is nobody's idle time.
    const end = Math.min(bounds.end, gone.get(agent) ?? Infinity);
    const stays = (inWindow.get(agent) ?? []).filter(row => row.end > start);
    if (!(end > start) || !(last.get(agent) > bounds.start) && !stays.length) continue;
    seats++; budget += Math.max(0, end - start);
    const observed = (observations.get(agent) ?? []).sort((a, b) => a.at - b.at);
    const points = [...new Set([start, end, ...stays.flatMap(row => [Math.max(start, row.start), Math.min(end, row.end)]),
      ...observed.filter(row => row.at > start && row.at < end).map(row => row.at)])].sort((a, b) => a - b);
    let observation = 0, reason = 'unknown';
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1], b = points[index];
      while (observation < observed.length && observed[observation].at <= a) reason = observed[observation++].reason;
      const active = stays.filter(row => row.start < b && row.end > a);
      if (active.find(row => row.kind === 'build') || active.length) occupied += b - a;
      else reasons[reason] += b - a;
    }
  }
  const idleMilliseconds = Math.max(0, budget - occupied), measured = unknownSeats.size === 0;
  return { observedSeats: seats, unmeasuredSeats: unknownSeats.size,
    agentHours: measured ? budget / HOUR : null, idleHours: measured ? idleMilliseconds / HOUR : null,
    idleShare: measured ? comparisonRatio(idleMilliseconds, budget) : null,
    idleReasonHours: Object.fromEntries(IDLE_REASONS.map(reason => [reason, measured ? reasons[reason] / HOUR : null])),
    idleReasons: Object.fromEntries(IDLE_REASONS.map(reason => [reason, measured ? comparisonRatio(reasons[reason], budget) : null])) };
}

/** Project traffic and recorded stage time from the same event prefix, without consulting mutable item rows. */
function comparisonWindow(history, prepared, bounds, stageReport, gone) {
  const selected = historyIndex(history).counted.filter(({ at }) => at > bounds.start && at <= bounds.end).map(({ event }) => event);
  const submissions = selected.filter(event => event.event_kind === 'submit');
  const submittedItems = new Set(submissions.map(event => event.item_id).filter(id => id !== null && id !== undefined)).size;
  const landed = prepared.items.filter(item => item.mergeAt > bounds.start && item.mergeAt <= bounds.end).length;
  const rejections = selected.filter(event => event.event_kind === 'reject').length;
  const coordinatorShouts = selected.filter(event => event.event_kind === 'shout' && proofEventDetail(event).to === 'coordinator').length;
  const seats = seatWindow(history, bounds, gone);
  const stageMilliseconds = Object.fromEntries(Object.entries(COMPARE_STAGES).map(([name, key]) => [name, stageReport.milliseconds[key]]));
  const measuredStageMilliseconds = Object.values(stageMilliseconds).reduce((sum, value) => sum + value, 0);
  return { since: bounds.since, until: bounds.until, landed, ...seats,
    agentHoursPerLanding: comparisonRatio(seats.agentHours, landed),
    stageHours: Object.fromEntries(Object.entries(stageMilliseconds).map(([key, value]) => [key, value / HOUR])),
    stageShares: Object.fromEntries(Object.entries(stageMilliseconds).map(([key, value]) => [key, comparisonRatio(value, measuredStageMilliseconds)])),
    unknownStageHours: stageReport.unknownMilliseconds / HOUR,
    submissions: submissions.length, submittedItems, submitsPerItem: comparisonRatio(submissions.length, submittedItems),
    rejections, rejectRate: comparisonRatio(rejections, submissions.length), coordinatorShouts,
    shoutsPerLanding: comparisonRatio(coordinatorShouts, landed) };
}

/** Changes retain null for either unmeasured side; nested reason and stage figures use identical units. */
function comparisonChange(current, previous) {
  if (current === null || previous === null) return null;
  if (typeof current === 'number' && typeof previous === 'number') return current - previous;
  if (current && previous && typeof current === 'object' && typeof previous === 'object') {
    return Object.fromEntries(Object.keys(current).filter(key => !['since', 'until'].includes(key))
      .map(key => [key, comparisonChange(current[key], previous[key])]));
  }
  return null;
}

/** One canonical two-window JSON contract is shared by stats, the coordinator line and Dashboard composition. */
export function projectWindowComparison(history, prepared, bounds, stageReports, gone) {
  const [previous, current] = bounds.map((rangeBounds, index) => comparisonWindow(history, prepared, rangeBounds, stageReports[index], gone));
  return { version: 1, available: true, durationMinutes: bounds[1].durationMinutes,
    bounds: '(since,until]', current, previous, change: comparisonChange(current, previous) };
}

/** Render every comparison measure with an absolute change in its own units, never a guessed relative rate. */
export function comparisonLines(comparison) {
  if (!comparison.available) return [`window comparison unavailable: ${comparison.reason}`];
  const { current, previous, change } = comparison;
  /** Percentages use percentage-point changes; missing observations remain visibly unmeasured. */
  const format = (value, share = false) => value === null ? 'unmeasured' : share ? `${(value * 100).toFixed(1)}%` : value.toFixed(2);
  /** Absolute percentage-point deltas are not relative percentage changes. */
  const delta = (value, share) => value === null ? 'unmeasured' : share ? `${(value * 100).toFixed(1)} percentage points` : value.toFixed(2);
  const lines = [`window comparison: ${current.since} to ${current.until} versus ${previous.since} to ${previous.until}`];
  const rows = [
    ['landed', 'landed'], ['agent-hours', 'agentHours'], ['agent-hours/landing', 'agentHoursPerLanding'],
    ['idle share', 'idleShare', true], ['submits/item', 'submitsPerItem'], ['reject rate', 'rejectRate', true],
    ['coordinator shouts/landing', 'shoutsPerLanding'],
  ];
  for (const [label, key, share] of rows) lines.push(`${label}: ${format(current[key], share)} (previous ${format(previous[key], share)}; change ${delta(change[key], share)})`);
  for (const [name, shares] of [['idle reason', 'idleReasons'], ['stage share', 'stageShares']]) {
    for (const key of Object.keys(current[shares])) lines.push(`${name} ${key}: ${format(current[shares][key], true)} (previous ${format(previous[shares][key], true)}; change ${delta(change[shares][key], true)})`);
  }
  return lines;
}
