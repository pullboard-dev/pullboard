/** One item's timeline folded from board events, gate and landing jobs and their steps, with every gap named or called UNACCOUNTED [C7,#12143]. */

/** Every stage a timeline row names; later slices import the list instead of copying it. */
export const TIMELINE_STAGES = Object.freeze([
  'filed', 'ready', 'claimed', 'seat-ready', 'finish', 'submitted', 'gate-queued', 'gate-running', 'gate-settled',
  'review-queued', 'reviewing', 'verdict', 'land-queued', 'landing', 'smoke', 'batch-built', 'merged', 'recorded',
  'released', 'rejected', 'reopened', 're-claimed', 'held',
]);

/** Where an item's time is counted. */
export const TIMELINE_BUCKETS = Object.freeze([
  'building', 'waiting for runner', 'testing', 'waiting for review', 'reviewing', 'waiting to land', 'landing', 'rework',
]);

/** The closed list of reasons a stretch may wait; no free text. */
export const WAIT_REASONS = Object.freeze([
  'HELD', 'DEPENDENCY', 'PERSON', 'NO_SEAT', 'BUILDER_SILENT', 'QUEUE_DEPTH', 'NO_RUNNER_SLOT', 'RUNNER_DOWN', 'API_BUSY',
  'SERVE_RESTART', 'STALE_BASE', 'MAIN_RED', 'NO_REVIEWER', 'LANDER_BUSY',
]);

/** The label for a stretch nothing explains. */
export const UNACCOUNTED = 'UNACCOUNTED';
/** A stretch with no open stage and no wait reason longer than this many ms is UNACCOUNTED. */
export const UNACCOUNTED_OVER_MS = 60_000;
/** Job kinds whose rows are gate or landing stages, read through the job_kind_item index. */
export const TIMELINE_JOB_KINDS = Object.freeze({ gate: 'gate', 'gate-shard': 'gate', land: 'land', landing: 'land', 'landing-run': 'land' });

/** Buckets where work is under way; a gap is a stretch outside them. */
const ACTIVE = new Set(['building', 'testing', 'reviewing', 'landing']);
const GATE_RUNNING_STEPS = new Set(['claimed', 'started', 'running']);
const GATE_SETTLED_STEPS = new Set(['green', 'red', 'finished', 'ended', 'result', 'receipt']);
/** Event kinds that become one row each, as [stage, edge]. */
const EVENT_STAGES = { add: ['filed', 'point'], claim: ['claimed', 'start'], release: ['released', 'point'], reopen: ['reopened', 'point'], reject: ['rejected', 'point'], submit: ['submitted', 'point'], reserve: ['reviewing', 'start'], accept: ['verdict', 'point'], pass: ['verdict', 'point'], merged: ['merged', 'point'], hold_item: ['held', 'start'], unhold_item: ['held', 'end'] };

/** A JSON object from a detail or payload, or an empty one when it is damaged. */
function objectOf(value) {
  if (value && typeof value === 'object') return value;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
}

/** A time in ms from an ISO string or a number. */
function msOf(value) { return typeof value === 'number' ? value : Date.parse(value); }

/** One timeline row; the pipeline facts are not recorded yet, so that field is null. */
function row(at, item, stage, edge, actor, reason, ref) {
  return { at, recorded_at: new Date(at).toISOString(), item, stage, edge, actor: actor ?? null, reason: reason ?? null, ref: ref ?? null, pipeline: null };
}

/**
 * Event rows in board order, plus the kinds no stage names.
 * Why: an unmapped kind is reported, never dropped, so a new event kind shows up instead of hiding time.
 */
function eventRows(events) {
  const rows = [], unmapped = new Map();
  let released = false;
  for (const event of events) {
    const detail = objectOf(event.detail), at = msOf(event.at);
    // A mark event names its own stage and edge and the time it marks; a stage outside TIMELINE_STAGES adds no row [C7,#12234].
    if (event.kind === 'mark') {
      const marked = msOf(detail.at);
      if (TIMELINE_STAGES.includes(detail.stage) && Number.isFinite(marked)) rows.push(row(marked, event.item, detail.stage, ['start', 'end', 'point'].includes(detail.edge) ? detail.edge : 'point', event.by, null, detail.ref ?? null));
      continue;
    }
    const mapped = EVENT_STAGES[event.kind];
    if (!mapped) { unmapped.set(event.kind, (unmapped.get(event.kind) ?? 0) + 1); continue; }
    let [stage, edge] = mapped;
    if (event.kind === 'claim' && released) stage = 're-claimed';
    if (['release', 'reject', 'reopen'].includes(event.kind)) released = true;
    const reason = event.kind === 'release' ? detail.reasonCode ?? null : event.kind === 'reject' ? detail.reason ?? null : event.kind === 'hold_item' ? 'HELD' : event.kind === 'accept' || event.kind === 'pass' ? event.kind : null;
    rows.push(row(at, event.item, stage, edge, event.by, event.kind === 'unhold_item' ? 'HELD' : reason, detail.commit ?? null));
  }
  return { rows, unmapped: [...unmapped].map(([kind, count]) => ({ kind, count })).sort((a, b) => a.kind.localeCompare(b.kind)) };
}

/** Gate and landing rows: created is queued, the first claim or run starts the work, the first result ends it. */
function jobRows(item, jobs, steps) {
  const byJob = new Map();
  for (const step of steps) { if (!byJob.has(step.job)) byJob.set(step.job, []); byJob.get(step.job).push(step); }
  const rows = [];
  for (const job of jobs) {
    const family = TIMELINE_JOB_KINDS[job.kind];
    if (!family) continue;
    const list = (byJob.get(job.id) ?? []).slice().sort((a, b) => a.at - b.at);
    const gate = family === 'gate';
    rows.push(row(job.created, item, gate ? 'gate-queued' : 'land-queued', 'start', null, null, job.id));
    const begin = list.find(step => GATE_RUNNING_STEPS.has(step.name));
    if (begin) rows.push(row(begin.at, item, gate ? 'gate-running' : 'landing', 'start', objectOf(begin.payload).runner ?? null, null, job.id));
    const end = list.find(step => GATE_SETTLED_STEPS.has(step.name));
    if (end) {
      const payload = objectOf(end.payload), outcome = end.name === 'green' || end.name === 'red' ? end.name : payload.outcome ?? payload.state ?? null;
      rows.push(row(end.at, item, gate ? 'gate-settled' : 'landing', 'end', null, gate ? outcome : null, job.id));
    }
  }
  return rows;
}

/** Whether a settled outcome sends the work back to its builder. */
const returned = outcome => outcome === 'red' || outcome === 'stale';

/**
 * Which bucket (or wait reason) each stretch between two rows belongs to, walking the rows in order.
 * A gate or landing job counts only while it is open, so parallel shards never double-count a stretch.
 */
function stretches(rows, end) {
  const out = [];
  const gate = { queued: new Set(), running: new Set() }, land = { queued: new Set(), running: new Set() };
  let phase = 'open', rework = false, held = false, wait = null, outcome = null, smoking = false;
  const bucketNow = () => {
    if (held) return { reason: 'HELD' };
    if (smoking) return { bucket: 'landing' };
    if (land.running.size) return { bucket: 'landing' };
    if (phase === 'merged') return { bucket: 'landing' };
    if (land.queued.size && phase !== 'building') return { bucket: 'waiting to land' };
    if (phase === 'building') return { bucket: rework ? 'rework' : 'building' };
    if (phase === 'submitted') {
      if (gate.running.size) return { bucket: 'testing' };
      if (gate.queued.size) return { bucket: 'waiting for runner' };
      if (outcome !== null && returned(outcome)) return { bucket: 'rework' };
      return outcome === null ? { bucket: 'waiting for runner' } : { bucket: 'waiting for review' };
    }
    if (phase === 'reviewing') return { bucket: 'reviewing' };
    if (phase === 'verdict') return land.running.size ? { bucket: 'landing' } : { bucket: 'waiting to land' };
    return rework ? { bucket: 'rework' } : wait ? { reason: wait } : {};
  };
  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index];
    const gateJob = current.stage.startsWith('gate-'), landJob = current.stage === 'land-queued' || (current.stage === 'landing' && current.ref);
    if (current.stage === 'filed') { phase = 'open'; }
    else if (current.stage === 'claimed' || current.stage === 're-claimed') { phase = 'building'; wait = null; }
    else if (current.stage === 'released') { phase = 'open'; wait = current.reason === 'BLOCKED' ? 'DEPENDENCY' : null; }
    else if (current.stage === 'rejected' || current.stage === 'reopened') { phase = 'open'; rework = true; outcome = null; }
    else if (current.stage === 'submitted') { phase = 'submitted'; rework = false; outcome = null; gate.queued.clear(); gate.running.clear(); }
    else if (current.stage === 'reviewing') phase = 'reviewing';
    else if (current.stage === 'verdict') phase = 'verdict';
    else if (current.stage === 'held') held = current.edge === 'start';
    else if (current.stage === 'smoke') smoking = current.edge === 'start';
    else if (current.stage === 'merged') phase = 'merged';
    if (gateJob) {
      if (current.stage === 'gate-queued') gate.queued.add(current.ref);
      else if (current.stage === 'gate-running') { gate.queued.delete(current.ref); gate.running.add(current.ref); }
      else { gate.queued.delete(current.ref); gate.running.delete(current.ref); outcome = current.reason ?? 'green'; if (returned(outcome)) rework = true; }
    } else if (landJob) {
      if (current.stage === 'land-queued') land.queued.add(current.ref);
      else if (current.edge === 'start') { land.queued.delete(current.ref); land.running.add(current.ref); }
      else land.running.delete(current.ref);
    }
    const next = rows[index + 1]?.at ?? end;
    if (next === undefined) continue;
    out.push({ from: current.at, to: next, ms: next - current.at, ...bucketNow(), fromStage: current.stage, toStage: rows[index + 1]?.stage ?? 'now' });
  }
  return out;
}

/**
 * One item's timeline: time-ordered stage rows with +delta from the previous row, ms per bucket, ms per wait reason,
 * the UNACCOUNTED stretches and the longest gap.
 *
 * Why: an unlabelled stretch over 60 s is a stage nobody recorded; it is shown, never hidden inside a bucket.
 * A short unlabelled hand-off belongs to the stage it leads into, so buckets plus waits plus UNACCOUNTED equal the item's wall time.
 *
 * @param {{ item?: number, events: { id?: number, at: string|number, by?: string, kind: string, item: number, detail?: object|string }[], jobs?: { id: string, kind: string, created: number }[], steps?: { job: string, name: string, at: number, payload?: string|object }[], now?: number }} input
 * @returns {{ rows: object[], summary: object, unmapped: { kind: string, count: number }[] }}
 */
export function timelineOf({ events = [], jobs = [], steps = [], now, item: given = null } = {}) {
  const item = events.find(event => event.item != null)?.item ?? given;
  const fromEvents = eventRows(events);
  const sourceOrder = new Map();
  const all = [...fromEvents.rows, ...jobRows(item, jobs, steps)];
  all.forEach((value, index) => sourceOrder.set(value, index));
  const rows = all.sort((a, b) => a.at - b.at || sourceOrder.get(a) - sourceOrder.get(b));
  rows.forEach((value, index) => { value.delta = index === 0 ? null : value.at - rows[index - 1].at; });
  const buckets = Object.fromEntries(TIMELINE_BUCKETS.map(name => [name, 0]));
  const waits = Object.fromEntries(WAIT_REASONS.map(name => [name, 0]));
  const last = rows.length ? rows.at(-1) : null;
  const end = last && last.stage !== 'merged' && now !== undefined && now > last.at ? now : undefined;
  const parts = rows.length ? stretches(rows, end) : [];
  let unaccounted = 0, longest = null;
  const unaccountedStretches = [];
  parts.forEach((part, index) => {
    if (part.reason) { waits[part.reason] += part.ms; return; }
    if (!part.bucket) {
      if (part.ms > UNACCOUNTED_OVER_MS) { unaccounted += part.ms; unaccountedStretches.push({ from: part.from, to: part.to, ms: part.ms }); part.reason = UNACCOUNTED; return; }
      // A short hand-off belongs to the stage it leads into, else the one it left.
      const into = parts.slice(index + 1).find(other => other.bucket) ?? parts.slice(0, index).reverse().find(other => other.bucket);
      part.bucket = into?.bucket ?? 'building';
    }
    buckets[part.bucket] += part.ms;
  });
  for (const part of parts) if (!ACTIVE.has(part.bucket) && (!longest || part.ms > longest.ms)) longest = { from: part.from, to: part.to, ms: part.ms, fromStage: part.fromStage, toStage: part.toStage, reason: part.reason ?? part.bucket };
  const total = last ? (end ?? last.at) - rows[0].at : 0;
  const summary = { total_ms: total, gates: jobs.filter(job => job.kind === 'gate').length, buckets, waits, unaccounted_ms: unaccounted, unaccounted_share: total ? unaccounted / total : 0, unaccounted: unaccountedStretches, longest_gap: longest, open_until: end ?? null };
  return { rows, summary, unmapped: fromEvents.unmapped };
}

/** The ms two [from, to] ranges share. */
function overlap(from, to, otherFrom, otherTo) { return Math.max(0, Math.min(to, otherTo) - Math.max(from, otherFrom)); }

/** Stall ranges merged so none counts twice, as [from, to] pairs. */
function stallRanges(fleetRows) {
  const ranges = fleetRows.filter(entry => entry.kind === 'api_stall' && entry.ms > 0).map(entry => [msOf(entry.at) - entry.ms, msOf(entry.at)]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    if (merged.length && range[0] <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/** The ms of [from, to] that fall inside the stall ranges. */
const stalledMs = (from, to, ranges) => ranges.reduce((sum, range) => sum + overlap(from, to, range[0], range[1]), 0);

/** An item's id from a timeline entry. */
const itemOf = entry => entry.item ?? entry.rows[0]?.item ?? null;

/** The nearest-rank percentile of a sorted list. */
const percentile = (sorted, share) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))];

/**
 * The fleet's time: per-stage median and p90, the share of all item-time by bucket and by wait reason (UNACCOUNTED included, the shares sum to 100),
 * gates per landed item and the ten slowest items with their biggest gap.
 *
 * Why: one item's timeline says where its time went; the fleet answer says which stage to fix first.
 * An api_stall fleet row that overlaps an unaccounted stretch labels the overlap API_BUSY and leaves the rest UNACCOUNTED.
 * A gap whose stretch is more than half stalled is named API_BUSY.
 *
 * @param {{ item: number, rows: object[], summary: object }[]} timelines - timelineOf results, one per item.
 * @param {{ kind: string, at: string|number, ms: number }[]} [fleetRows] - Fleet rows with no item, such as api_stall (at is when the stall ended, ms how long it lasted).
 * @returns {object}
 */
export function fleetSummary(timelines, fleetRows = []) {
  const stalls = stallRanges(fleetRows);
  const durations = new Map();
  const buckets = Object.fromEntries(TIMELINE_BUCKETS.map(name => [name, 0]));
  const waits = Object.fromEntries(WAIT_REASONS.map(name => [name, 0]));
  let unaccounted = 0, total = 0, gates = 0, landed = 0;
  for (const { rows, summary } of timelines) {
    rows.forEach((value, index) => {
      if (index === rows.length - 1) return;
      if (!durations.has(value.stage)) durations.set(value.stage, []);
      durations.get(value.stage).push(rows[index + 1].at - value.at);
    });
    total += summary.total_ms;
    gates += summary.gates ?? 0;
    if (rows.some(value => value.stage === 'merged')) landed += 1;
    for (const name of TIMELINE_BUCKETS) buckets[name] += summary.buckets[name];
    for (const name of WAIT_REASONS) waits[name] += summary.waits[name];
    for (const stretch of summary.unaccounted) {
      const stalled = Math.min(stretch.ms, stalledMs(stretch.from, stretch.to, stalls));
      waits.API_BUSY += stalled;
      unaccounted += stretch.ms - stalled;
    }
  }
  const percent = ms => (total ? (ms / total) * 100 : 0);
  const stages = {};
  for (const [stage, list] of [...durations].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = list.slice().sort((a, b) => a - b);
    stages[stage] = { count: sorted.length, median_ms: percentile(sorted, 0.5), p90_ms: percentile(sorted, 0.9) };
  }
  const slowest = timelines.filter(entry => entry.summary.total_ms > 0).sort((a, b) => b.summary.total_ms - a.summary.total_ms || itemOf(a) - itemOf(b)).slice(0, 10).map(entry => {
    const { summary } = entry;
    const gap = summary.longest_gap;
    const relabel = gap && gap.reason === UNACCOUNTED && stalledMs(gap.from, gap.to, stalls) * 2 > gap.ms;
    return { item: itemOf(entry), total_ms: summary.total_ms, biggest_gap: gap ? { ...gap, reason: relabel ? 'API_BUSY' : gap.reason } : null };
  });
  return {
    items: timelines.length, landed, total_ms: total, gates_per_landed: landed ? gates / landed : null, stages,
    share: { buckets: Object.fromEntries(Object.entries(buckets).map(([name, ms]) => [name, percent(ms)])), waits: Object.fromEntries(Object.entries(waits).map(([name, ms]) => [name, percent(ms)])), [UNACCOUNTED]: percent(unaccounted) },
    unaccounted_ms: unaccounted, slowest,
  };
}
