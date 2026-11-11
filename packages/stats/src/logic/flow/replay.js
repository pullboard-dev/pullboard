/** Deterministic scheduling of observed intervals; predictions are not measurements of an alternate live queue. */
import { Refused } from '../../../../kernel/light.js';
import {
  ACTIVE_REVIEWER_WINDOW_MINUTES,
  lineWipLimit,
} from '../../../../seats/browser.js';
import {
  replayHistory,
  replayObservations,
} from './replay/history.js';

const MINUTE = 60_000;
const RANGES = { wipPerReviewer: [1.5, 3, false], landingBatchSize: [1, 8, true], landingCadenceMinutes: [5, 30, true] };

/** Accept only hypothetical replay limits, never writing machine or board settings. */
function replayPolicy(input, observations) {
  const source = input ?? {};
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || Object.keys(source).some(key => !['order', 'settings'].includes(key))) throw new Refused('USAGE', 'replay policy is an object with order and settings; read pullboard help flow');
  const order = source.order ?? 'recorded';
  if (order !== 'recorded' && (!Array.isArray(order) || order.some(id => !Number.isSafeInteger(id) || id < 1)
    || new Set(order).size !== order.length || order.some(id => !observations.items.some(item => item.id === id)))) {
    throw new Refused('USAGE', 'replay order is recorded or a list of distinct measured item ids');
  }
  const settings = source.settings ?? {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Refused('USAGE', 'replay settings must be a board line-settings object');
  for (const [key, value] of Object.entries(settings)) {
    if (['barReady', 'takeoverMinutes', 'reworkSameFamily', 'returnRejectedWork'].includes(key)) throw new Refused('USAGE', `${key} is not modelled by replay`);
    if (key === 'reviewsFirst' && typeof value === 'boolean') continue;
    const range = RANGES[key];
    if (!range || value !== false && (typeof value !== 'number' || !Number.isFinite(value)
      || value < range[0] || value > range[1] || range[2] && !Number.isSafeInteger(value))) {
      throw new Refused('USAGE', `replay ${key} must use its supported board line-setting range; read pullboard settings line`);
    }
  }
  return { order, settings: { ...settings }, capacity: { ...observations.stages }, recorded: order === 'recorded' && !Object.keys(settings).length };

}

/** Match the existing flow window's quartile convention, retaining nulls when no interval is measured. */
function quartiles(values) {
  const sorted = [...values].sort((a, b) => a - b), count = sorted.length, middle = Math.floor(count / 2);
  return { count, fastQuarterMinutes: count ? sorted[Math.floor(count / 4)] : null,
    medianMinutes: count ? count % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null,
    slowQuarterMinutes: count ? sorted[Math.min(count - 1, Math.floor(3 * count / 4))] : null,
    worstMinutes: count ? sorted.at(-1) : null };
}

/** Schedule each recorded attempt on its recorded seat; explicit order breaks ready-queue ties without preemption. */
function schedule(observations, policy) {
  const pending = new Map(observations.tasks.map(task => [task.id, task]));
  const completed = new Map(), running = [];
  const activeWip = new Set(), submitted = new Set(), reviewActivity = [];
  const arrival = new Map(observations.items.map(item => [item.id, item.arrival]));
  const rank = new Map((Array.isArray(policy.order) ? policy.order : []).map((id, index) => [id, index]));
  const capacity = policy.capacity;
  const batchSize = policy.settings.landingBatchSize || Infinity;
  const cadence = (policy.settings.landingCadenceMinutes || 0) * MINUTE;
  const batched = !policy.recorded && (batchSize !== Infinity || cadence > 0);
  let now = observations.origin, batch = new Set(), batchStarted = -Infinity, batchFinished = -Infinity, batchUnstarted = false;
  /** A measured task starts after arrival, its prior stage and the seat's recorded availability. */
  const readyAt = task => Math.max(arrival.get(task.item), observations.resources.get(task.by).available,
    task.prior ? completed.get(task.prior.id)?.end ?? Infinity : -Infinity, policy.recorded ? task.start : -Infinity);
  /** Count only reservations and verdicts already reached by this simulated clock, including the window boundary. */
  const activeReviewers = () => new Set(reviewActivity.filter(event => event.at >= now - ACTIVE_REVIEWER_WINDOW_MINUTES * MINUTE
    && event.at <= now).map(event => event.by)).size;
  /** Native reviews-first is a backlog threshold, independent of the opt-in total-WIP admission cap. */
  const prioritizeReviews = () => policy.settings.reviewsFirst === true
    && submitted.size > lineWipLimit(typeof policy.settings.wipPerReviewer === 'number' ? policy.settings.wipPerReviewer : 3, activeReviewers());
  /** Recorded decisions preserve their exact start constraints; counterfactual order selects among ready tasks. */
  const compare = (a, b) => policy.recorded ? a.start - b.start || a.id - b.id :
    (prioritizeReviews() ? Number(b.stage === 'review') - Number(a.stage === 'review') : 0)
    || (rank.get(a.item) ?? Infinity) - (rank.get(b.item) ?? Infinity) || arrival.get(a.item) - arrival.get(b.item) || a.item - b.item || a.id - b.id;
  while (pending.size || running.length) {
    for (let i = running.length - 1; i >= 0; i -= 1) {
      if (running[i].end <= now) {
        const row = running.splice(i, 1)[0];
        completed.set(row.task.id, row);
        if (row.task.stage === 'build') submitted.add(row.task.item);
        if (row.task.stage === 'review') {
          submitted.delete(row.task.item);
          activeWip.delete(row.task.item);
          reviewActivity.push({ at: row.end, by: row.task.by });
        }
      }
    }
    if (batched && !batch.size && now >= Math.max(batchStarted + cadence, batchFinished)) {
      const ready = [...pending.values()].filter(task => task.stage === 'landing' && readyAt(task) <= now).sort(compare).slice(0, batchSize);
      if (ready.length) { batch = new Set(ready.map(task => task.id)); batchUnstarted = true; }
    }
    let started = false;
    for (const task of [...pending.values()].sort(compare)) {
      if (batched && task.stage === 'landing' && !batch.has(task.id)) continue;
      if (readyAt(task) > now || running.filter(row => row.task.stage === task.stage).length >= capacity[task.stage]
        || running.filter(row => row.task.by === task.by).length >= observations.resources.get(task.by).capacity) continue;
      if (!policy.recorded && task.stage === 'build' && typeof policy.settings.wipPerReviewer === 'number'
        && activeWip.size + 1 > lineWipLimit(policy.settings.wipPerReviewer, activeReviewers())) continue;
      if (batched && task.stage === 'landing' && batchUnstarted) { batchStarted = now; batchUnstarted = false; }
      pending.delete(task.id);
      if (task.stage === 'build') activeWip.add(task.item);
      if (task.stage === 'review') reviewActivity.push({ at: now, by: task.by });
      running.push({ task, start: now, end: now + task.duration });
      started = true;
    }
    if (batched && batch.size && [...batch].every(id => completed.has(id))) {
      batchFinished = Math.max(...[...batch].map(id => completed.get(id).end));
      batch.clear();
      continue;
    }
    if (started) continue; // A new reservation may admit another build at this same simulated instant.
    if (!pending.size && !running.length) break;
    const batchAt = batched && !batch.size && [...pending.values()].some(task => task.stage === 'landing' && readyAt(task) <= now)
      ? Math.max(batchStarted + cadence, batchFinished) : Infinity;
    const next = Math.min(...running.map(row => row.end), ...[...pending.values()].map(readyAt).filter(at => at > now), batchAt > now ? batchAt : Infinity);
    if (!Number.isFinite(next)) throw new Refused('USAGE', 'replay history has an unschedulable dependency; export a complete lifecycle history');
    now = next;
  }
  return completed;
}

/** Reproduce complete recorded cycles or predict alternate scheduling with identical arrivals, seats and work intervals. */
export function replayFlow(events, inputPolicy) {
  const history = replayHistory(events), observations = replayObservations(history), policy = replayPolicy(inputPolicy, observations);
  const times = schedule(observations, policy);
  const items = observations.items.map(item => {
    const first = times.get(item.tasks[0].id), last = times.get(item.tasks.at(-1).id);
    const values = { build: 0, reviewWait: 0, review: 0, sendBackIdle: 0, mergeWait: 0 };
    for (const task of item.tasks) {
      const row = times.get(task.id), prior = task.prior && times.get(task.prior.id);
      if (task.stage === 'build') { values.build += task.duration / MINUTE; if (prior) values.sendBackIdle += (row.start - prior.end) / MINUTE; }
      if (task.stage === 'review') { values.review += task.duration / MINUTE; values.reviewWait += (row.start - prior.end) / MINUTE; }
      if (task.stage === 'landing') values.mergeWait += (row.end - prior.end) / MINUTE;
    }
    return { id: item.id, arrivalAt: new Date(item.arrival).toISOString(), claimAt: new Date(first.start).toISOString(),
      landedAt: new Date(last.end).toISOString(), cycleMinutes: (last.end - first.start) / MINUTE, stages: values };
  });
  const landingOrder = [...items].sort((a, b) => Date.parse(a.landedAt) - Date.parse(b.landedAt)
    || (policy.recorded ? observations.items.find(item => item.id === a.id).landedEvent - observations.items.find(item => item.id === b.id).landedEvent : 0) || a.id - b.id).map(item => item.id);
  const stages = Object.fromEntries(['build', 'reviewWait', 'review', 'sendBackIdle', 'mergeWait'].map(stage => [stage, quartiles(items.map(item => item.stages[stage]))]));
  return { history, replay: { mode: policy.recorded ? 'recorded' : 'predicted', policy: { order: policy.order, settings: policy.settings },
    items, landingOrder, stages, unmeasured: observations.unmeasured,
    assumptions: ['Recorded lifecycle intervals are retained, not interpreted as CPU time.',
      'Seat identities and their observed concurrency are fixed; modelled board controls change scheduling only.',
      `Predicted total WIP uses the native unrounded cap and distinct simulated reservation/verdict actors in the trailing ${ACTIVE_REVIEWER_WINDOW_MINUTES}-minute window, minimum one.`,
      'Only complete measured cycles supply simulated reviewer activity; incomplete or abandoned work stays explicitly unmeasured.',
      'Landing batches contain ready items only; the next batch waits for prior completion and its start-to-start cadence.',
      'Predicted queue times are not timings measured by running an alternate live policy.',
      'Incomplete or abandoned attempts remain unmeasured, never zero-duration work.'] } };
}
