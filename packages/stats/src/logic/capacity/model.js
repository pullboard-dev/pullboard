/** Pure empirical capacity estimates; unknown history never becomes zero-cost work [R1,R2]. */
const KINDS = ['build', 'review', 'reviewWait', 'reworkGap', 'cycle'];
const DAY = 86_400_000;

/** Accept the observer's epoch milliseconds or an explicit date without reading a live clock. */
function timeOf(value) { return typeof value === 'number' ? value : Date.parse(value); }

/** A finite nonnegative measurement includes genuinely observed zero durations. */
function measured(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
/** Return an empirical mean, preserving an empty sample as unknown. */
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value / values.length, 0) : null; }
/** Use the nearest empirical rank, with no fitted tail or arbitrary duration cap. */
function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)];
}
/** Name exact half-open line-count buckets without inferring missing submission sizes. */
function sizeBucket(size) { return !Number.isSafeInteger(size) || size < 0 ? 'unknown' : size < 100 ? 'under100' : size < 300 ? '100to300' : size < 800 ? '300to800' : '800plus'; }
/** Retain empirical observations, sample counts and JSON-safe summaries. */
function distribution(values) { return { n: values.length, values, mean: mean(values), p90: quantile(values, 0.9) }; }

/** Fit only completed observations inside the requested window, capped at the latest seven days. */
export function fitCapacity(samples, { from, to }) {
  const end = timeOf(to);
  const begin = Math.max(timeOf(from), end - 7 * DAY);
  if (!Number.isFinite(begin) || !Number.isFinite(end) || begin > end) return { version: 1, available: false, from: null, to: null, samples: 0, routes: [], landing: [], unknown: ['invalid fit window'] };
  const routes = new Map();
  const landing = [];
  let count = 0;
  let missing = 0;
  for (const sample of samples ?? []) {
    const at = timeOf(sample?.at);
    if (!Number.isFinite(at) || at < begin || at >= end) continue;
    if (sample.kind === 'landing') {
      if (measured(sample.hours) && Number.isSafeInteger(sample.batchSize) && sample.batchSize > 0
        && Number.isSafeInteger(sample.failed) && sample.failed >= 0 && sample.failed <= sample.batchSize) {
        landing.push({ hours: sample.hours, batchSize: sample.batchSize, failed: sample.failed }); count += 1;
      } else missing += 1;
      continue;
    }
    if (sample.kind === 'landingOutcome') {
      if (typeof sample.route !== 'string' || !sample.route) { missing += 1; continue; }
      if (!routes.has(sample.route)) routes.set(sample.route, { route: sample.route, observations: [], decisions: [], landingOutcomes: [] });
      const provenance = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sample.sourceCommit ?? '')
        && Number.isSafeInteger(sample.acceptEvent) && sample.acceptEvent > 0;
      if (!provenance) missing += 1;
      const known = provenance && (sample.failed === false && sample.cause === 'merged'
        || sample.failed === true && ['conflict', 'landing-test', 'stale'].includes(sample.cause));
      routes.get(sample.route).landingOutcomes.push({ failed: known ? sample.failed : null, cause: sample.cause });
      count += 1;
      continue;
    }
    if (![...KINDS, 'decision'].includes(sample.kind) || typeof sample.route !== 'string' || !sample.route) { missing += 1; continue; }
    if (sample.kind === 'decision' ? typeof sample.accepted !== 'boolean' : !measured(sample.hours)) { missing += 1; continue; }
    if (!routes.has(sample.route)) routes.set(sample.route, { route: sample.route, observations: [], decisions: [], landingOutcomes: [] });
    const route = routes.get(sample.route);
    if (sample.kind === 'decision') route.decisions.push({ accepted: sample.accepted, size: sizeBucket(sample.size) });
    else route.observations.push({ kind: sample.kind, hours: sample.hours, size: sizeBucket(sample.size), attempt: sample.attempt ?? 'unknown' });
    count += 1;
  }
  return { version: 1, available: true, from: new Date(begin).toISOString(), to: new Date(end).toISOString(), samples: count,
    routes: [...routes.values()].sort((a, b) => a.route.localeCompare(b.route)).map(route => ({ ...route,
      durations: Object.fromEntries(KINDS.map(kind => [kind, distribution(route.observations.filter(row => row.kind === kind).map(row => row.hours))])),
      landingRisk: { n: route.landingOutcomes.length,
        unknown: route.landingOutcomes.filter(row => row.failed === null).length,
        probability: route.landingOutcomes.some(row => typeof row.failed === 'boolean')
          ? route.landingOutcomes.filter(row => row.failed === true).length / route.landingOutcomes.filter(row => typeof row.failed === 'boolean').length : null },
      rejection: { n: route.decisions.length, probability: route.decisions.length ? route.decisions.filter(row => !row.accepted).length / route.decisions.length : null } })),
    landing, unknown: missing ? [`${missing} observations have missing or invalid measurements`] : [] };
}

/** Reproducible randomness is local to a projection, never shared with application state. */
function randomFor(seed) {
  let state = 2166136261;
  for (const character of String(seed ?? 0)) state = Math.imul(state ^ character.charCodeAt(0), 16777619) >>> 0;
  return () => { state = (state + 0x6D2B79F5) >>> 0; let value = state; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}
/** Bootstrap the observed empirical distribution without adding invented pseudo-observations. */
function resample(values, random) { return Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]); }
/** Keep absent external dependencies and cycles visible; holds and person waits only lower supply. */
function graphFor(items) {
  const all = new Map(items.map(item => [item.id, item]));
  const pending = items.filter(item => !['merged', 'withdrawn'].includes(item.state));
  const nodes = new Map(pending.map(item => [item.id, item]));
  const predecessors = new Map();
  const successors = new Map(pending.map(item => [item.id, []]));
  const unknown = [];
  for (const item of pending) {
    const deps = [...new Set(item.after ?? [])].filter(id => !['accepted', 'merged'].includes(all.get(id)?.state));
    for (const id of deps) if (!nodes.has(id)) unknown.push(`item #${item.id} has unsatisfied dependency #${id}`);
    predecessors.set(item.id, deps);
    for (const id of deps) successors.get(id)?.push(item.id);
  }
  const indegree = new Map([...predecessors].map(([id, deps]) => [id, deps.length]));
  const order = pending.filter(item => indegree.get(item.id) === 0).map(item => item.id);
  for (let index = 0; index < order.length; index += 1) for (const id of successors.get(order[index])) {
    indegree.set(id, indegree.get(id) - 1);
    if (indegree.get(id) === 0) order.push(id);
  }
  if (order.length !== pending.length && !unknown.some(text => text.includes('unsatisfied dependency'))) unknown.push('dependency graph contains a cycle');
  // A future unlock is counted only if every ancestor is schedulable, not merely present.
  const schedulable = new Set();
  for (const id of order) {
    const item = nodes.get(id);
    if (!item.held && !item.needsYou && predecessors.get(id).every(dep => schedulable.has(dep))) schedulable.add(id);
  }
  const supply = [...schedulable].filter(id => nodes.get(id).state !== 'accepted').length;
  // Ready now means schedulable with no unfinished dependency, unlike supply, which also counts future unlocks.
  const ready = [...schedulable].map(id => nodes.get(id)).filter(item => item.state !== 'accepted' && !predecessors.get(item.id).length);
  return { pending, nodes, predecessors, order, supply, ready, unknown };
}
/** Greedy disjoint-file waves give an observed conservative width, not a maximum independent set. */
function waveWidth(items) {
  const waves = [];
  for (const item of [...items].sort((a, b) => a.id - b.id)) {
    // An item with no recorded files joins no collision; the width stays a lower bound.
    if (!Array.isArray(item.files) || !item.files.length) { waves.push({ files: new Set(), count: 1 }); continue; }
    if (item.files.some(file => typeof file !== 'string' || !file)) return null;
    let wave = waves.find(row => item.files.every(file => !row.files.has(file)));
    if (!wave) { wave = { files: new Set(), count: 0 }; waves.push(wave); }
    for (const file of item.files) wave.files.add(file);
    wave.count += 1;
  }
  return Math.max(0, ...waves.map(wave => wave.count));
}
/** Resolve empirical route parameters; the input API has no unfinished-item size prediction. */
function parameters(fit, random) {
  const routes = new Map();
  for (const route of fit.routes ?? []) {
    const draws = Object.fromEntries(KINDS.map(kind => {
      const values = route.durations?.[kind]?.values ?? [];
      return [kind, random ? resample(values, random) : values];
    }));
    const durations = Object.fromEntries(KINDS.map(kind => [kind, mean(draws[kind])]));
    const ordinaryBuilds = route.observations.filter(row => row.kind === 'build' && !['conflict', 'landing-test'].includes(row.attempt)).map(row => row.hours);
    durations.build = mean(random ? resample(ordinaryBuilds, random) : ordinaryBuilds);
    const decisions = random ? resample(route.decisions, random) : route.decisions;
    const outcomes = random ? resample(route.landingOutcomes ?? [], random) : route.landingOutcomes ?? [];
    const repair = Object.fromEntries(['conflict', 'landing-test', 'reject'].map(cause => [cause,
      Object.fromEntries(['build', 'reworkGap'].map(kind => {
        const values = route.observations.filter(row => row.kind === kind && row.attempt === cause).map(row => row.hours);
        return [kind, mean(random ? resample(values, random) : values)];
      }))]));
    routes.set(route.route, { ...durations, repair, outcomes, q: decisions.length ? decisions.filter(row => !row.accepted).length / decisions.length : null,
      tail: Object.fromEntries(KINDS.map(kind => [kind, quantile(draws[kind], 0.9)])) });
  }
  const landings = random ? resample(fit.landing ?? [], random) : fit.landing ?? [];
  const batches = landings.reduce((sum, row) => sum + row.batchSize, 0);
  const failures = landings.reduce((sum, row) => sum + row.failed, 0);
  const landed = batches - failures;
  return { routes, service: landed > 0 ? landings.reduce((sum, row) => sum + row.hours / landed, 0) : null };
}
/** Compute knowable post-accept repair labor without inventing any failed gate duration. */
function landingRepair(route) {
  // An unclassified outcome is right-censored: dropped from the rate, never voiding the route.
  route = route && { ...route, outcomes: route.outcomes.filter(row => typeof row.failed === 'boolean') };
  if (!route || !route.outcomes.length) {
    return { work: null, unknown: ['landing outcome coverage is missing or unclassified'] };
  }
  const failed = route.outcomes.filter(row => row.failed);
  if (!failed.length) return { work: 0, unknown: [] };
  const probability = failed.length / route.outcomes.length;
  if (probability >= 1 || route.q === null || route.q >= 1 || route.review === null) {
    return { work: null, unknown: ['landing repair labor has insufficient completed service or successful outcomes'] };
  }
  // Failed cycles use the observed lander-cycle distribution, which already includes bisection and retries.
  const unknown = [];
  const rejectBuild = route.repair.reject.build ?? route.build;
  if (route.q > 0 && rejectBuild === null) return { work: null, unknown: [...unknown, 'review-reject repair build service is missing'] };
  let weighted = 0;
  for (const cause of ['conflict', 'landing-test']) {
    const count = failed.filter(row => row.cause === cause).length;
    if (!count) continue;
    const service = route.repair[cause];
    // A cause with failures but no cause-specific build sample (a rare mid-route landing-test) repairs at the route's ordinary build service, as review rejects do.
    const repairBuild = service.build ?? route.build;
    if (repairBuild === null) return { work: null, unknown: [...unknown, `${cause} repair build service is missing`] };
    // A missing repair gap is latency, never labor: it adds no work, so it cannot void the estimate.
    // The cause-specific build happens once; later review rejects use their own observed build service.
    const labor = repairBuild + (route.review + route.q * (rejectBuild ?? 0)) / (1 - route.q);
    weighted += count / route.outcomes.length * labor;
  }
  return { work: weighted / (1 - probability), unknown };
}

/** Preserve independently knowable work even when landing latency makes a complete forecast unavailable. */
function knownWork(graph, parameters) {
  let work = 0;
  for (const item of graph.pending) {
    const route = parameters.routes.get(item.route);
    const repair = landingRepair(route);
    if (repair.work === null) return null;
    let ordinary = 0;
    if (item.state !== 'accepted') {
      if (!route || route.q === null || route.q >= 1 || route.review === null
        || (item.state !== 'submitted' || route.q > 0) && route.build === null) return null;
      ordinary = item.state === 'submitted' ? (route.review + route.q * (route.build ?? 0)) / (1 - route.q)
        : (route.build + route.review) / (1 - route.q);
    }
    work += ordinary + repair.work;
  }
  return Number.isFinite(work) ? work : null;
}

/** Estimate one item's active labor and acceptance latency with geometric repeat attempts. */
function itemCost(item, parameters) {
  const route = parameters.routes.get(item.route);
  if (item.state === 'accepted') return { work: 0, path: 0, tail: 0 };
  // A submitted item with no observed rejects needs only its review, so a missing build sample cannot make it unknown.
  const needsBuild = item.state !== 'submitted' || route?.q > 0;
  if (!route || route.q === null || route.q >= 1 || needsBuild && route.build === null || route.review === null
    || route.reviewWait === null || route.tail.cycle === null || route.q > 0 && route.reworkGap === null) return null;
  const q = route.q;
  const build = route.build ?? 0; // Only a submitted q=0 item reaches here without a build sample, where it has zero weight.
  const startWork = item.state === 'submitted' ? (route.review + q * build) / (1 - q) : (build + route.review) / (1 - q);
  const startPath = item.state === 'submitted'
    ? (route.review + route.reviewWait + q * (build + (route.reworkGap ?? 0))) / (1 - q)
    : (build + route.review + route.reviewWait + q * (route.reworkGap ?? 0)) / (1 - q);
  // Whole first-claim→matching-accept cycles already include retries and idle rework gaps.
  // Their empirical p90 must not receive the geometric attempt multiplier a second time.
  return { work: startWork, path: startPath, tail: route.tail.cycle };
}
/** Evaluate the closed form once; graph and collision structure are reused by all replicates. */
function evaluate(graph, width, parameters) {
  const finish = new Map();
  const repairs = new Map();
  let work = 0;
  let tail = 0;
  for (const id of graph.order) {
    const item = graph.nodes.get(id);
    const cost = itemCost(item, parameters);
    if (!cost) return null;
    // Post-accept landing-repair labor is work too, now that a failed landing no longer voids the estimate.
    if (!repairs.has(item.route)) repairs.set(item.route, landingRepair(parameters.routes.get(item.route)).work);
    if (repairs.get(item.route) === null) return null;
    work += cost.work + repairs.get(item.route); tail = Math.max(tail, cost.tail);
    finish.set(id, Math.max(0, ...graph.predecessors.get(id).map(dep => finish.get(dep) ?? 0)) + cost.path);
  }
  if (parameters.service === null) return null;
  const critical = Math.max(0, ...finish.values());
  if (![work, tail, critical, parameters.service * graph.pending.length].every(Number.isFinite)) return null;
  const landing = parameters.service * graph.pending.length;
  const infinity = Math.max(critical, tail, landing);
  const limit = infinity > 0 ? Math.ceil(2 * work / infinity) : null;
  const recommended = limit === null || width === null ? null : Math.min(limit, width, graph.supply);
  return { work, critical, tail, landing, infinity, recommended,
    finish: recommended > 0 ? Math.max(infinity, work / recommended) : work === 0 ? infinity : null };
}
/** Forecast one bounded empirical queue with shared active slots, independent reviewers and one lander. */
function forecast(graph, fit, capacity, seats, parameters, random, identities) {
  const routes = new Map((fit.routes ?? []).map(route => [route.route, route]));
  const needsAgents = graph.pending.some(item => item.state !== 'accepted');
  if (needsAgents && (capacity < 1 || seats === null || seats < 2)) return null;
  const slots = Math.min(capacity, seats ?? 0);
  const agents = Array.from({ length: identities ? seats : Math.min(seats ?? 0, Math.max(2, slots + 1)) }, (_, id) => ({ id, busy: false }));
  const states = new Map(graph.pending.map(item => [item.id, { ...item, phase: item.state === 'accepted' ? 'accepted' : item.state === 'submitted' ? 'waitingReview' : 'waitingBuild', at: 0, builder: null, attempts: 0 }]));
  const accepted = new Set(graph.pending.filter(item => item.state === 'accepted').map(item => item.id));
  const landQueue = [...accepted];
  const events = [];
  let time = 0;
  let serial = 0;
  let landed = 0;
  let lander = false;
  const horizon = graph.pending.reduce((sum, item) => sum + (routes.get(item.route)?.decisions.length ?? 0), 0);
  // Retries beyond the observed decision cohort are explicitly right-censored, not a duration cap.
  const eventBudget = graph.pending.length * 4 + horizon * 4 + 1; // Every rejected attempt can produce four phase completions.
  let processed = 0;
  /** Add a deterministic virtual completion; this never starts a real agent or changes board authority. */
  function push(at, kind, value) {
    const event = { at, kind, value, serial: serial++ };
    let index = events.length;
    events.push(event);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!earlier(event, events[parent])) break;
      events[index] = events[parent]; index = parent;
    }
    events[index] = event;
  }
  /** Stable heap ordering makes completion handling O(log pending events). */
  function earlier(left, right) { return left.at < right.at || left.at === right.at && left.serial < right.serial; }
  /** Remove the earliest virtual completion without repeatedly sorting the event queue. */
  function pop() {
    const first = events[0];
    const last = events.pop();
    if (events.length) {
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        if (left >= events.length) break;
        const right = left + 1;
        const child = right < events.length && earlier(events[right], events[left]) ? right : left;
        if (!earlier(events[child], last)) break;
        events[index] = events[child]; index = child;
      }
      events[index] = last;
    }
    return first;
  }
  /** Draw one observed duration without fitting a synthetic tail. */
  function duration(item, kind) {
    const route = routes.get(item.route);
    const values = kind === 'build' ? (route?.observations ?? []).filter(row => row.kind === 'build'
      && !['conflict', 'landing-test'].includes(row.attempt)).map(row => row.hours) : route?.durations[kind]?.values ?? [];
    return values.length ? values[Math.floor(random() * values.length)] : null;
  }
  /** Dispatch available queue work subject to active capacity and different builder/reviewer identities. */
  function dispatch() {
    for (;;) {
      if (agents.filter(agent => agent.busy).length >= slots) break;
      let choice = null;
      let worker = null;
      for (const item of states.values()) if (item.phase === 'readyReview') {
        const candidate = agents.find(agent => !agent.busy && agent.id !== item.builder);
        if (candidate) { choice = item; worker = candidate; break; }
      }
      if (!choice) for (const item of states.values()) if (item.phase === 'waitingBuild' && item.at <= time && graph.predecessors.get(item.id).every(id => accepted.has(id))) {
        const conflict = [...states.values()].some(other => other.phase === 'building' && item.files.some(file => other.files.includes(file)));
        const candidate = agents.find(agent => !agent.busy);
        if (!conflict && candidate) { choice = item; worker = candidate; break; }
      }
      if (!choice) break;
      const reviewing = choice.phase === 'readyReview';
      const hours = duration(choice, reviewing ? 'review' : 'build');
      if (hours === null) return false;
      worker.busy = true;
      choice.phase = reviewing ? 'reviewing' : 'building';
      if (!reviewing) choice.builder = worker.id;
      push(time + hours, reviewing ? 'reviewed' : 'built', { id: choice.id, worker: worker.id });
    }
    if (!lander && landQueue.length) {
      const cycles = fit.landing ?? [];
      if (!cycles.length) return false;
      const cycle = cycles[Math.floor(random() * cycles.length)];
      const adopted = cycle.batchSize - cycle.failed;
      if (adopted < 1) return false;
      const batch = landQueue.splice(0, adopted);
      lander = true;
      push(time + cycle.hours, 'landed', batch);
    }
    return true;
  }
  for (const item of states.values()) if (item.phase === 'waitingReview') {
    const hours = duration(item, 'reviewWait');
    if (hours === null) return null;
    // A submitted item's recorded builder must be compared with the actual assumed seat identities.
    if (!identities || typeof item.builderId !== 'string' || !item.builderId) return null;
    item.builder = identities.indexOf(item.builderId);
    push(hours, 'readyReview', item.id);
  }
  if (!dispatch()) return null;
  while (landed < graph.pending.length) {
    if (!events.length || processed++ >= eventBudget) return null;
    const event = pop();
    time = event.at;
    if (!Number.isFinite(time)) return null;
    if (event.kind === 'landed') { landed += event.value.length; lander = false; }
    else if (event.kind === 'readyReview') states.get(event.value).phase = 'readyReview';
    else if (event.kind === 'readyBuild') states.get(event.value).at = time;
    else {
      const item = states.get(event.value.id);
      agents[event.value.worker].busy = false;
      if (event.kind === 'built') {
        item.phase = 'waitingReview';
        const hours = duration(item, 'reviewWait');
        if (hours === null) return null;
        push(time + hours, 'readyReview', item.id);
      } else {
        item.attempts += 1;
        const q = parameters.routes.get(item.route)?.q;
        if (q === null || q === undefined || q >= 1) return null;
        if (random() < q) {
          if (item.attempts >= routes.get(item.route).decisions.length) return null;
          const hours = duration(item, 'reworkGap');
          if (hours === null) return null;
          item.phase = 'waitingBuild'; item.at = time + hours;
          push(item.at, 'readyBuild', item.id);
        } else { item.phase = 'accepted'; accepted.add(item.id); landQueue.push(item.id); }
      }
    }
    if (!dispatch()) return null;
  }
  return time;
}

/** Make nonfinite or unknown estimates explicit in the wire format. */
function finite(value) { return Number.isFinite(value) ? value : null; }

/** Project a bounded, seeded empirical planner without Git, clocks, board writes or raw-history reads. */
export function planCapacity({ items = [], fit, liveSeats, now, sequence, seed = 0, simulate = true }) {
  const graph = graphFor(items);
  const unknown = [...graph.unknown];
  if (!Number.isFinite(timeOf(now))) unknown.push('invalid observation clock');
  const baseline = fit?.available ? parameters(fit) : null;
  const independentWork = baseline && !graph.unknown.length ? knownWork(graph, baseline) : null;
  if (baseline) for (const route of new Set(graph.pending.map(item => item.route))) {
    for (const reason of landingRepair(baseline.routes.get(route)).unknown) unknown.push(`${route}: ${reason}`);
  }
  const active = graph.pending.filter(item => item.state !== 'accepted');
  // Ready supply and file collisions need no history, so the width of what can be built now is known without a fit.
  const readyFiles = waveWidth(graph.ready);
  const readyWidth = readyFiles === null ? null : Math.min(graph.ready.length, readyFiles);
  const width = !graph.unknown.length && fit?.available ? waveWidth(active) : null;
  if (fit?.available && !graph.unknown.length && width === null) unknown.push('unfinished work has invalid file collision inputs');
  if (!fit?.available) unknown.push('empirical fit is unavailable');
  const empty = graph.pending.length === 0;
  let estimate = null;
  if (empty) estimate = { work: 0, critical: 0, tail: 0, landing: 0, infinity: 0, recommended: 0, finish: 0 };
  else if (!unknown.length) estimate = evaluate(graph, width, baseline);
  if (!empty && !estimate) unknown.push('completed route, review, rework or landing measurements are insufficient');
  // With no cost estimate the advice falls back to what ready work alone can use; it is labelled so it is never read as measured.
  const fallback = !empty && !estimate && fit?.available === true && !graph.unknown.length && readyWidth !== null ? Math.min(readyWidth, graph.supply) : null;
  const seats = Number.isSafeInteger(liveSeats) && liveSeats >= 0 ? liveSeats : Number.isSafeInteger(liveSeats?.total) && liveSeats.total >= 0 ? liveSeats.total : null;
  const identities = Array.isArray(liveSeats?.ids) && liveSeats.ids.length === seats && new Set(liveSeats.ids).size === seats
    && liveSeats.ids.every(id => typeof id === 'string' && id) ? liveSeats.ids : null;
  const replicates = [];
  const random = randomFor(seed);
  if (simulate && estimate && !empty) for (let index = 0; index < 100; index += 1) {
    const empirical = parameters(fit, random);
    const closed = evaluate(graph, width, empirical);
    const finish = closed ? forecast(graph, fit, closed.recommended, seats, empirical, random, identities) : null;
    replicates.push({ closed, finish });
  }
  const ks = replicates.map(row => row.closed?.recommended ?? Infinity);
  const times = replicates.map(row => row.finish ?? Infinity);
  if (simulate && estimate && !empty && !replicates.some(row => row.finish !== null)) unknown.push('no empirical forecast finishes with observed staffing and retry coverage');
  let binding = 'unknown';
  if (estimate) {
    if (empty) binding = 'supply';
    else if (seats !== null && seats < estimate.recommended) binding = 'seats';
    else if (graph.supply < Math.ceil(2 * estimate.work / estimate.infinity) && graph.supply <= width) binding = 'supply';
    else if (width < Math.ceil(2 * estimate.work / estimate.infinity) && width < graph.supply) binding = 'collisions';
    else if (estimate.landing === estimate.infinity) binding = 'landing';
    else if (estimate.tail === estimate.infinity && (fit.routes ?? []).some(route => route.rejection.probability > 0)) binding = 'rework';
    else binding = 'DAG';
  }
  const levers = { unknown: ['measure', 'Collect the missing completed measurements.'], supply: ['decompose', 'Decompose more ready work.'], seats: ['staff', 'Add live seats up to the useful-agent limit.'], collisions: ['soft-order', 'Prefer work on different functions; do not block claims.'], landing: ['batch', 'Batch accepted work and bisect failed gates.'], rework: ['bar-check', 'Reduce rejects with bar checks and advisory dry-run review.'], DAG: ['unblock', 'Resolve approvals or split the critical chain.'] };
  const curve = [];
  if (estimate) {
    const stop = Math.max(1, active.length, estimate.recommended ?? 0);
    for (let agents = 1; agents <= stop; agents *= 2) curve.push({ agents, hours: Math.max(estimate.infinity, estimate.work / agents) });
    if (!curve.some(row => row.agents === estimate.recommended) && estimate.recommended > 0) curve.push({ agents: estimate.recommended, hours: Math.max(estimate.infinity, estimate.work / estimate.recommended) });
    curve.sort((a, b) => a.agents - b.agents);
  }
  return { version: 1, available: Boolean(estimate), readyWidth, asOf: Number.isFinite(timeOf(now)) ? new Date(now).toISOString() : null, source: { sequence: sequence ?? null, fitFrom: fit?.from ?? null, fitTo: fit?.to ?? null, samples: fit?.samples ?? 0 },
    workHours: estimate?.work ?? independentWork, bounds: { criticalPathHours: estimate?.critical ?? null, stragglerHours: estimate?.tail ?? null, landingHours: estimate?.landing ?? null },
    tInfinityHours: estimate?.infinity ?? null, agents: { recommended: estimate?.recommended ?? fallback, ...(fallback === null ? {} : { basis: 'ready' }), lower: empty ? 0 : finite(quantile(ks, 0.1)), upper: empty ? 0 : finite(quantile(ks, 0.9)) },
    finishHours: { lower: empty ? 0 : finite(quantile(times, 0.1)), upper: empty ? 0 : finite(quantile(times, 0.9)) },
    binding: { kind: binding, text: binding === 'unknown' ? 'Not enough measured data.' : `${binding} limits useful concurrency.` }, lever: { kind: levers[binding][0], text: levers[binding][1] },
    needsYou: graph.pending.filter(item => item.needsYou).map(item => item.id).sort((a, b) => a - b), curve, unknown: [...new Set([...unknown, ...(fit?.unknown ?? [])])],
    assumptions: ['Work counts recorded build/review seat-occupancy hours; queue and rework gaps affect latency only.',
      'Unfinished sizes use the observed route mixture; missing sizes are not zero.',
      'Remaining claimed/submitted work uses unconditional empirical service and a whole-cycle straggler bound, without an invented elapsed-work discount.',
      'Review rejects repeat geometrically at observed route rates; empirical observations are stationary and independently resampled.',
      'Landing samples are observed coordinator batch cycles, including in-batch admission and bisection, not raw gate execution or prior accept-queue waits.',
      'Outcome rates condition on completed accepted episodes; still-open accepted episodes are right-censored and never asserted to be zero-risk outcomes.',
      'Landing-return risk comes from matching accepted source-head episodes ending in merged or typed conflict/landing-test returns, independently of batch cycle timing.',
      'Positive landing-return risk includes cause-specific first repair builds and review/reject repair labor; missing repair labor remains unknown.',
      'Failed landing cycles use the observed lander-cycle distribution; unclassified landing outcomes are right-censored.',
      'Items with no recorded files join no collision wave.',
      'Review-reject repair builds use their cause-specific observations when present, otherwise the existing pooled non-landing build convention; queue/rework gaps are latency, not labor.',
      'The straggler bound is the observed route whole-item cycle p90 (first claim through matching acceptance, including rework), never a sum of unrelated component quantiles or multiplied again by repeat attempts.',
      'Collision width is a deterministic greedy disjoint-file wave, not measured function independence.',
      'The curve contains work/span lower bounds; finish quantiles come from a discrete-event build/review/dependency/batched-landing forecast.',
      'Forecasts share assumed available capacity across build and review, require two identities, and never let a builder review its own modeled work.',
      'Retries exceeding the route decision sample count are right-censored; nonfinishing replicates stay in quantiles rather than being discarded.',
      'Observed disjoint-file conflicts conservatively delay modeled concurrent builds; this advice does not change live claim eligibility.'],
    monteCarlo: { replicates: 100, completed: empty ? 100 : replicates.length, nonFinishing: replicates.filter(row => row.finish === null).length } };
}

/**
 * The budget line a warn or stop budget adds to the capacity report: spend and limit in dollars, and which limit it is.
 * Below 80 percent, or with no budget set, the report has no budget line [N2].
 */
function budgetLines(budget) {
  if (!budget || !['warn', 'stop'].includes(budget.state) || typeof budget.limit !== 'number' || typeof budget.spend !== 'number') return [];
  const dollars = value => `$${value.toFixed(2)}`;
  const span = budget.which === 'dailyUsd' ? 'daily' : 'total';
  return [budget.state === 'stop'
    ? `Budget reached: ${dollars(budget.spend)} of the ${dollars(budget.limit)} ${span} limit.`
    : `Budget at 80 percent: ${dollars(budget.spend)} of the ${dollars(budget.limit)} ${span} limit.`];
}

/** Render the same explicit estimates and unknowns for status, the view and the morning report. */
export function capacityLines(planner) {
  /** Format hours or counts without printing a missing measurement as zero. */
  function show(value) { return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value * 100) / 100) : 'unknown'; }
  const needs = Array.isArray(planner.needsYou) ? planner.needsYou : null;
  return [planner.agents.basis === 'ready' ? `Max useful agents now: ${show(planner.agents.recommended)} from ready work only.`
      : `Max useful agents now: ${show(planner.agents.recommended)} (${show(planner.agents.lower)}-${show(planner.agents.upper)}).`,
    ...(Number.isSafeInteger(planner.readyWidth) ? [`${planner.readyWidth} ${planner.readyWidth === 1 ? 'item can' : 'items can'} be built at once now.`] : []),
    typeof planner.finishHours.lower === 'number' && typeof planner.finishHours.upper === 'number'
      ? `Finish in about ${show(planner.finishHours.lower)}-${show(planner.finishHours.upper)} h.` : 'Finish time: unknown.',
    `Binding: ${planner.binding.kind}. ${planner.binding.text}`, `Lever: ${planner.lever.text}`,
    needs ? `${needs.length} items lack recorded approval evidence${needs.length ? `: ${needs.slice(0, 5).map(id => `#${id}`).join(', ')}${needs.length > 5 ? ` +${needs.length - 5} more` : ''}` : ''}.` : 'Approval evidence count: unknown.',
    ...(planner.staffing?.measuredLive === false ? [`Forecast assumes ${planner.staffing.seats} available seats from recent activity; live presence is unknown.`] : []),
    ...(planner.staffing?.measuredLive === true ? [`Live seats: ${planner.staffing.seats} from presence heartbeats.`] : []),
    ...(Number.isSafeInteger(planner.waiting) && planner.waiting > 0 ? [`${planner.waiting} items wait on a hold, a person or a dependency.`] : []),
    ...(planner.stale ? ['Estimates are stale; waiting for a board update.'] : []),
    ...budgetLines(planner.budget),
    ...(planner.monteCarlo.asOf && planner.monteCarlo.asOf !== planner.asOf ? [`Finish range last refreshed at ${planner.monteCarlo.asOf}.`] : []),
    ...(planner.unknown.length ? [`Unknown: ${planner.unknown.slice(0, 5).join('; ')}${planner.unknown.length > 5 ? `; +${planner.unknown.length - 5} more` : ''}.`] : [])];
}
