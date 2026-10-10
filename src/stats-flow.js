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
function roleOf(kind, detail) {
  if (['reserve', 'accept', 'reject', 'verify'].includes(kind) || kind === 'release' && detail.review) return 'verifier';
  if (['claim', 'submit'].includes(kind) || kind === 'release' && !detail.review) return 'builder';
  return null;
}

/** Return an expired claim to its open queue at the recorded lease boundary. */
function expireClaim(item, at) {
  if (item.state === 'claimed' && Number.isFinite(item.leaseUntil) && item.leaseUntil <= at) {
    item.state = 'open';
    item.openAt = item.leaseUntil;
  }
}

/** Replay one lifecycle move; its first claim and first merge survive rework and repeated receipts. */
function move(item, event, detail, at) {
  expireClaim(item, at);
  switch (event.event_kind) {
    case 'add':
      item.lane = detail.lane ?? 'unknown'; item.state = 'open'; item.openAt = at; break;
    case 'claim':
      item.firstClaim ??= at; item.claimAt = at; item.state = 'claimed';
      item.leaseUntil = Date.parse(detail.leaseUntil); break;
    case 'renew': item.leaseUntil = Date.parse(detail.leaseUntil); break;
    case 'submit':
      item.submitAt = at; item.commit = detail.commit; item.verdictAt = null; item.acceptAt = null;
      item.reserve = null; item.finalReserveAt = null; item.state = 'submitted'; break;
    case 'reserve': item.reserve = { at, by: event.event_by, until: Date.parse(detail.until) }; break;
    case 'release':
      if (detail.review || item.state === 'submitted') item.reserve = null;
      else { item.state = 'open'; item.openAt = at; }
      break;
    case 'accept':
    case 'reject': {
      if (!item.commit || detail.commit !== item.commit) break;
      item.verdictAt = at;
      item.finalReserveAt = item.reserve?.by === event.event_by &&
        (!Number.isFinite(item.reserve.until) || item.reserve.until >= at) ? item.reserve.at : null;
      item.reserve = null;
      if (event.event_kind === 'accept') { item.state = 'accepted'; item.acceptAt = at; }
      else { item.state = 'open'; item.openAt = at; }
      break;
    }
    case 'merged': item.mergeAt ??= at; item.state = 'merged'; break;
    case 'reopen':
    case 'refreeze':
    case 'escalate':
    case 'lapse': item.state = 'open'; item.openAt = at; item.reserve = null; break;
    case 'withdraw': item.state = 'withdrawn'; break;
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
    expireClaim(item, now);
    const queue = queues[item.state];
    if (!queue) continue;
    queue.size += 1;
    const start = { open: item.openAt, claimed: item.claimAt, submitted: item.submitAt, accepted: item.acceptAt }[item.state];
    const ageMinutes = interval(start, now);
    if (ageMinutes !== null && (!queue.oldest || ageMinutes > queue.oldest.ageMinutes ||
      ageMinutes === queue.oldest.ageMinutes && item.id < queue.oldest.id)) queue.oldest = { id: item.id, since: new Date(start).toISOString(), ageMinutes };
    if (item.state === 'submitted' && (!item.reserve || Number.isFinite(item.reserve.until) && item.reserve.until <= now)) {
      unreviewed.size += 1;
      if (ageMinutes !== null && (!unreviewed.oldest || ageMinutes > unreviewed.oldest.ageMinutes ||
        ageMinutes === unreviewed.oldest.ageMinutes && item.id < unreviewed.oldest.id)) {
        unreviewed.oldest = { id: item.id, since: new Date(start).toISOString(), ageMinutes };
      }
    }
    if (item.state === 'open') openByLane.set(item.lane, (openByLane.get(item.lane) ?? 0) + 1);
    if (item.state === 'accepted') accepted.push(item.id);
  }
  return { queues, unreviewed, openByLane, accepted: accepted.sort((a, b) => a - b) };
}

/** Attribute last-hour activity using the latest recorded role, including a prior role when only shouts are recent. */
function activeFrom(actors, now) {
  const agents = [...actors.values()].filter(actor => actor.lastAt >= now - 60 * MINUTE && actor.lastAt <= now)
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
  if (stage === 'review') return `reviews are slow (median ${stages.review.medianMinutes ?? 'unmeasured'} min): check how long the frozen checks take`;
  return accepted.length ? `land the accepted items: ${accepted.map(id => `#${id}`).join(', ')}` : 'land the accepted items (none waiting)';
}

/** Derive flow from the same immutable history used for counts, with an injectable observation time for fixtures. */
export function flowStats(history, boundary, now, counts) {
  const items = new Map();
  const actors = new Map();
  const daily = new Map();
  /** Include a stage or first completion at the exact lower boundary. */
  const selected = at => !boundary || at >= Date.parse(boundary);
  /** Count each day's additions and first completed merges without filling gaps with invented moves. */
  function day(at) {
    const date = new Date(at).toISOString().slice(0, 10);
    if (!daily.has(date)) daily.set(date, { date, added: 0, merged: 0 });
    return daily.get(date);
  }
  for (const event of history) {
    const detail = JSON.parse(event.event_detail);
    const at = Date.parse(event.event_at);
    const id = event.event_by;
    if (!['board', 'person', 'clock'].includes(id)) {
      if (!actors.has(id)) actors.set(id, { id, lane: 'unknown', role: 'unknown', lastAt: at });
      const actor = actors.get(id);
      if (event.event_kind === 'join' && detail.lane) actor.lane = detail.lane;
      actor.role = id === 'coordinator' ? 'coordinator' : roleOf(event.event_kind, detail) ?? actor.role;
      actor.lastAt = at;
    }
    if (event.item_id === null || event.item_id === undefined) continue;
    if (!items.has(event.item_id)) items.set(event.item_id, { id: event.item_id, lane: 'unknown' });
    const item = items.get(event.item_id);
    if (event.event_kind === 'add' && selected(at)) day(at).added += 1;
    if (event.event_kind === 'merged' && item.mergeAt === undefined && selected(at)) day(at).merged += 1;
    move(item, event, detail, at);
  }
  const samples = Object.fromEntries(STAGES.map(stage => [stage, []]));
  const cycleTotals = Object.fromEntries(STAGES.map(stage => [stage, 0]));
  let completedItems = 0;
  let fullyMeasuredCycles = 0;
  const unmeasured = Object.fromEntries(STAGES.map(stage => [stage, 0]));
  for (const item of items.values()) {
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
  const queueData = queuesFrom(items.values(), now);
  const activeAgents = activeFrom(actors, now);
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
  return { asOf: new Date(now).toISOString(), stages, queues: queueData.queues, unreviewed: queueData.unreviewed, daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    submitsPerMerged: completedItems ? counts.submissions / completedItems : 0, activeAgents, bottleneck };
}

/** Format measured minutes for people while JSON retains the original numeric precision. */
function minutes(value) { return value === null ? 'unmeasured' : String(Number(value.toFixed(2))); }

/** Render all flow dimensions and the evidence behind the single recommended action. */
export function flowLines(flow) {
  const lines = STAGES.map(stage => {
    const row = flow.stages[stage];
    return `${LABELS[stage]}: average ${minutes(row.averageMinutes)} min · median ${minutes(row.medianMinutes)} min · ${row.count} measured; ${row.unmeasuredCompleted} of ${flow.bottleneck.completedItems} completed items unmeasured`;
  });
  for (const [state, queue] of Object.entries(flow.queues)) {
    lines.push(`${state} queue: ${queue.size} · oldest ${queue.oldest ? `#${queue.oldest.id} (${minutes(queue.oldest.ageMinutes)} min)` : 'none'}`);
  }
  lines.push(`per day: ${flow.daily.map(row => `${row.date}: ${row.added} added, ${row.merged} merged`).join('; ') || 'none'}`);
  lines.push(`${minutes(flow.submitsPerMerged)} submissions per merged item`);
  lines.push(`active in the last hour: ${flow.activeAgents.total} agents · roles ${Object.entries(flow.activeAgents.roles).map(([role, count]) => `${role} ${count}`).join(', ')} · lanes ${Object.entries(flow.activeAgents.lanes).map(([lane, count]) => `${lane} ${count}`).join(', ') || 'none'}`);
  const bottleneck = flow.bottleneck;
  lines.push(`bottleneck: ${bottleneck.message}${bottleneck.share === null ? '' : ` (${minutes(bottleneck.share * 100)}%)`}${bottleneck.lowConfidence ? ' · low confidence' : ''}`);
  if (bottleneck.recommendation) lines.push(`next: ${bottleneck.recommendation}`);
  return lines;
}

/** Name a tripped documented threshold using the same measured flow and action as stats [N32]. */
export function flowAlertLine(flow) {
  const average = flow.stages.reviewWait.averageMinutes;
  const oldest = flow.unreviewed.oldest;
  const thresholds = [];
  if (average > 60) thresholds.push(`review wait average ${minutes(average)} min (${flow.stages.reviewWait.count} measured; > 60 min)`);
  if (oldest?.ageMinutes > 180) thresholds.push(`unreviewed #${oldest.id} waiting ${minutes(oldest.ageMinutes)} min (> 180 min)`);
  if (!thresholds.length) return null;
  const bottleneck = flow.bottleneck;
  const measured = bottleneck.stage === null ? 'bottleneck: not measured yet' :
    `bottleneck: ${LABELS[bottleneck.stage]} (${minutes(bottleneck.share * 100)}% of ${minutes(bottleneck.totalCycleMinutes)} measured cycle min); next: ${bottleneck.recommendation}`;
  return `flow: ${thresholds.join('; ')}; ${measured}`;
}
