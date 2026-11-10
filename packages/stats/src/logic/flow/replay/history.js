/** Text-free lifecycle observations for an offline replay, never a second board state machine [R1,R2]. */
import { Refused } from '../../../../../kernel/light.js';

const KINDS = new Set(['join', 'add', 'claim', 'submit', 'reserve', 'accept', 'reject', 'merged', 'release', 'reopen', 'refreeze', 'lapse', 'escalate', 'withdraw']);

/** Project only structural identifiers, kinds and times; no event detail or current item row is read. */
export function replayHistory(events) {
  if (!Array.isArray(events)) throw new Refused('USAGE', 'replay history needs an events array exported by pullboard flow replay --json');
  const seen = new Set();
  const rows = [];
  for (const event of events) {
    if (!KINDS.has(event.event_kind)) continue;
    const id = event.event_id;
    const at = Date.parse(event.event_at);
    const item = event.item_id;
    const by = event.event_by;
    if (!Number.isSafeInteger(id) || id < 1 || seen.has(id) || !Number.isFinite(at)
      || typeof by !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(by)
      || (event.event_kind !== 'join' && (!Number.isSafeInteger(item) || item < 1))) {
      throw new Refused('USAGE', 'replay history needs unique positive event ids, valid times, native seat ids and positive lifecycle item ids');
    }
    seen.add(id);
    rows.push({ event_id: id, event_at: new Date(at).toISOString(), event_kind: event.event_kind,
      item_id: event.event_kind === 'join' ? null : item, event_by: by });
  }
  rows.sort((a, b) => a.event_id - b.event_id);
  if (rows.some((row, index) => index > 0 && Date.parse(row.event_at) < Date.parse(rows[index - 1].event_at))) {
    throw new Refused('USAGE', 'replay history clocks moved backwards in native event order; use a history with nondecreasing recorded times, never reorder or clamp timestamp evidence');
  }
  return { version: 1, events: rows };
}

/** Maximum simultaneous measured intervals; adjacent and zero-length intervals do not consume two places. */
export function observedCapacity(tasks) {
  const edges = tasks.flatMap(task => task.end > task.start ? [[task.start, 1], [task.end, -1]] : []);
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let used = 0, peak = 1;
  for (const [, delta] of edges) { used += delta; peak = Math.max(peak, used); }
  return peak;
}

/** Compile only complete measured attempts; absent reservations or abandoned work stay explicitly unmeasured. */
export function replayObservations(history) {
  const items = new Map();
  const seats = new Map();
  const origin = history.events.length ? Date.parse(history.events[0].event_at) : 0;
  let nextTask = 0;
  for (const event of history.events) {
    const at = Date.parse(event.event_at), by = event.event_by, id = event.item_id;
    if (event.event_kind === 'join') { if (!seats.has(by)) seats.set(by, at); continue; }
    if (!items.has(id)) items.set(id, { id, tasks: [], missing: [], arrival: null, landed: null });
    const item = items.get(id);
    if (item.landed !== null) continue;
    /** Record an interval and its actual seat, retaining the previous attempt as its dependency. */
    const task = (stage, start, end, actor) => {
      if (!Number.isFinite(start) || end < start || typeof actor !== 'string') {
        item.missing.push(`missing ${stage} boundary`); return null;
      }
      const row = { id: nextTask++, item: id, stage, start, end, duration: end - start, by: actor,
        prior: item.tasks.at(-1) ?? null };
      item.tasks.push(row);
      return row;
    };
    switch (event.event_kind) {
      case 'add': item.arrival ??= at; break;
      case 'claim':
        if (item.claim) item.missing.push('abandoned build attempt');
        item.claim = { at, by }; break;
      case 'submit':
        task('build', item.claim?.at, at, item.claim?.by);
        item.claim = null; item.submitted = at; break;
      case 'reserve':
        if (item.reserve) item.missing.push('replaced review reservation');
        item.reserve = { at, by }; break;
      case 'accept':
      case 'reject':
        if (item.submitted === undefined || item.reserve?.by !== by || item.tasks.at(-1)?.stage !== 'build') item.missing.push('missing review boundary');
        task('review', item.reserve?.at, at, by);
        item.reserve = null;
        item.accepted = event.event_kind === 'accept' ? { at, by: null } : null;
        break;
      case 'merged':
        task('landing', item.accepted?.at, at, by);
        item.landed = at; item.landedEvent = event.event_id; break;
      case 'release': case 'reopen': case 'refreeze': case 'lapse': case 'escalate': case 'withdraw':
        item.missing.push(`unmeasured ${event.event_kind} interval`); break;
    }
  }
  const complete = [], unmeasured = [];
  for (const item of [...items.values()].sort((a, b) => a.id - b.id)) {
    if (item.arrival === null || item.landed === null || !item.tasks.length || item.tasks.at(-1).stage !== 'landing') item.missing.push('incomplete recorded cycle');
    if (item.tasks.some(task => task.start < item.arrival || task.prior && task.start < task.prior.end)) item.missing.push('overlapping or reversed item stages');
    if (item.missing.length) unmeasured.push({ id: item.id, reasons: [...new Set(item.missing)].sort() });
    else complete.push(item);
  }
  const tasks = complete.flatMap(item => item.tasks);
  const stages = Object.fromEntries(['build', 'review', 'landing'].map(stage => [stage, observedCapacity(tasks.filter(task => task.stage === stage))]));
  const actors = [...new Set(tasks.map(task => task.by))].sort();
  const resources = new Map(actors.map(by => [by, { available: seats.get(by) ?? origin,
    capacity: observedCapacity(tasks.filter(task => task.by === by)) }]));
  return { items: complete, tasks, unmeasured, stages, resources, origin };
}
