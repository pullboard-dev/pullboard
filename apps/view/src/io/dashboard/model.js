import { itemStageKey } from "../../logic/pipeline/model.js";
import { itemStagePresentation } from "../../logic/pipeline/model.js";

/** Project the Dashboard from one authoritative item snapshot and its complete ordered event prefix [N26]. */
export function dashboardModel(project, history, { now, complete = true } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('Dashboard projection requires an explicit clock reading');
  const hour = 3_600_000, start = now - 4 * hour;
  const landingAt = new Map((project.landingBatches ?? []).flatMap(batch => (batch.items || []).map(entry => [entry.id, batch.startedAt])));
  const holds = new Map((project.itemHolds ?? []).map(hold => [hold.item, hold.reason]));
  const laneHolds = new Map((project.holds ?? []).map(hold => [hold.hold_lane, hold.hold_reason]));
  const items = (project.items ?? []).map(item => ({ ...item, landingBatchAt: landingAt.get(item.id) || null,
    heldReason: holds.get(item.id) || null, laneHoldReason: laneHolds.get(item.lane) || null,
    owner: item.status === 'claimed' ? item.claim?.by || item.owner : null,
    reviewer: item.status === 'submitted' ? item.reviewer || item.claim?.by : null,
    reviewUntil: item.status === 'submitted' ? item.reviewUntil || item.claim?.until : null }));
  const byId = new Map(items.map(item => [item.id, item]));
  const stageCounts = Object.fromEntries(['gated','ready','building','in-review','verified','landing','merged'].map(key => [key, 0]));
  // The same stage words and keys the Items Pipeline groups by, so the strip and the pipeline agree.
  for (const item of items) {
    if (item.status === 'withdrawn') continue;
    const key = itemStageKey(itemStagePresentation(item, { gated: Boolean(item.blockedBy?.length || item.heldReason || item.laneHoldReason), landingBatchAt: item.landingBatchAt }).stage);
    if (key in stageCounts) stageCounts[key]++;
  }
  const merged = new Map((project.dashboardLanded ?? []).map(entry => [entry.id, entry]));
  const prefix = project.sequence ?? Infinity;
  const events = history.filter(event => event.event_id <= prefix && Date.parse(event.event_at) <= now)
    .sort((a, b) => a.event_id - b.event_id);
  /** Parse only native event JSON; malformed history cannot create activity. */
  const detail = event => { try { return JSON.parse(event.event_detail || '{}'); } catch { return {}; } };
  const latest = new Map(), landed = new Map(), work = new Map(), rows = new Map();
  const seats = new Set((project.agents ?? []).map(agent => agent.agent_id));
  const joined = new Map();
  // The API's recent-seat list can omit a real seat whose latest move is outside its clock.
  // Native joins in this same bounded history establish membership without promoting automation.
  for (const event of events) if (event.event_kind === 'join') {
    const lane = detail(event).lane;
    if (typeof lane === 'string' && lane && lane !== 'coordinator' && event.event_by) {
      seats.add(event.event_by);
      if (!joined.has(event.event_by)) joined.set(event.event_by, Date.parse(event.event_at));
    }
  }
  /** Attribute history only to registered seats; board automation is not an agent. */
  const row = id => {
    if (!seats.has(id) || id === 'coordinator') return null;
    if (!rows.has(id)) rows.set(id, { id, name: id, segments: [], build: 0, review: 0, idle: 0, shouts: 0, last: 0, current: [], sentBack: [],
      ...(joined.has(id) ? { start: Math.max(start, joined.get(id)) } : {}) });
    return rows.get(id);
  };
  for (const agent of project.agents ?? []) {
    const entry = row(agent.agent_id);
    if (entry) { entry.name = agent.agent_id; entry.model = agent.model || agent.agent_model || '';  entry.last = Date.parse(agent.lastMoveAt) || 0; entry.start = Math.max(start, Date.parse(agent.agent_created_at) || start); }
  }
  /** Close an actual item's occupied interval, clipping only when calculating the four-hour window. */
  const close = (key, at) => {
    const held = work.get(key); if (!held) return;
    at = Math.min(at, held.until ?? now);
    const actor = row(held.actor);
    if (actor && at > start && held.start < now) actor.segments.push({ ...held, start: Math.max(start, held.start), end: Math.min(now, at) });
    work.delete(key);
  };
  let passed = 0, sentBack = 0, personShouts = 0;
  for (const event of events) {
    const at = Date.parse(event.event_at), d = detail(event), id = event.item_id, actor = row(event.event_by);
    if (!Number.isFinite(at)) continue;
    // Count the same bounded native prefix while its date and payload are already decoded.
    if (at > start) {
      if (event.event_kind === 'accept') passed++;
      if (['reject', 'reopen'].includes(event.event_kind)) sentBack++;
      if (event.event_kind === 'shout' && d.to === 'person') personShouts++;
    }
    for (const [key, held] of work) if (held.until <= at) close(key, held.until);
    if (actor && ['reject', 'reopen'].includes(event.event_kind) && at > start) actor.sentBack.push({ at, item: id });
    if (actor) { actor.last = Math.max(actor.last, at); if (event.event_kind === 'shout' && at > start) actor.shouts++; }
    latest.set(event.event_kind + ':' + id, event);
    if (event.event_kind === 'merged') {
      const item = byId.get(id);
      if (item && typeof d.commit === 'string' && d.commit && merged.get(id)?.commit === d.commit && !landed.has(id)) landed.set(id, at);
    }
    if (['claim', 'renew'].includes(event.event_kind)) {
      // Renewals extend the same stay; a replacement closes the prior actor's stay.
      const key = 'build:' + id, held = work.get(key);
      if (held?.actor !== event.event_by) { close(key, at); work.set(key, { actor: event.event_by, item: id, kind: 'build', start: at, until: Date.parse(d.leaseUntil) || at }); }
      else held.until = Date.parse(d.leaseUntil) || held.until;
    }
    if (['submit', 'lapse', 'withdraw', 'reopen'].includes(event.event_kind) || event.event_kind === 'release' && !d.review) close('build:' + id, at);
    if (event.event_kind === 'release' && d.review) close('review:' + id, at);
    if (event.event_kind === 'reserve') {
      const key = 'review:' + id;
      if (work.get(key)?.actor !== event.event_by) { close(key, at); work.set(key, { actor: event.event_by, item: id, kind: 'review', start: at, until: Date.parse(d.until) || at }); }
      else work.get(key).until = Date.parse(d.until) || work.get(key).until;
    }
    if (['accept', 'reject', 'reopen', 'withdraw', 'patch'].includes(event.event_kind)) close('review:' + id, at);
  }
  /**
   * The most agents holding a claim or a review at one moment in the last 24 hours, read from the same claim, renew,
   * reserve, release and close events the timeline reads. An agent counts once however many holds it has open then.
   * Kept inside this function because the page embeds dashboardModel's source text, so no helper may sit outside it [N26].
   */
  const peakAgents = (() => {
    const floorAt = now - 24 * hour, open = new Map(), spans = [];
    /** End one open hold at a moment, keeping only the part of it that falls in the last 24 hours. */
    const end = (key, at) => {
      const held = open.get(key); if (!held) return;
      open.delete(key);
      const from = Math.max(held.start, floorAt), to = Math.min(at, held.until ?? now, now);
      if (to > from) spans.push({ actor: held.actor, start: from, end: to });
    };
    for (const event of events) {
      const at = Date.parse(event.event_at), d = detail(event), id = event.item_id;
      if (!Number.isFinite(at)) continue;
      for (const [key, held] of [...open]) if (held.until <= at) end(key, held.until);
      if (['claim', 'renew'].includes(event.event_kind)) {
        const key = 'build:' + id, held = open.get(key);
        if (held?.actor !== event.event_by) { end(key, at); open.set(key, { actor: event.event_by, start: at, until: Date.parse(d.leaseUntil) || at }); }
        else held.until = Date.parse(d.leaseUntil) || held.until;
      }
      if (['submit', 'lapse', 'withdraw', 'reopen'].includes(event.event_kind) || event.event_kind === 'release' && !d.review) end('build:' + id, at);
      if (event.event_kind === 'release' && d.review) end('review:' + id, at);
      if (event.event_kind === 'reserve') {
        const key = 'review:' + id, held = open.get(key);
        if (held?.actor !== event.event_by) { end(key, at); open.set(key, { actor: event.event_by, start: at, until: Date.parse(d.until) || at }); }
        else held.until = Date.parse(d.until) || held.until;
      }
      if (['accept', 'reject', 'reopen', 'withdraw', 'patch'].includes(event.event_kind)) end('review:' + id, at);
    }
    for (const key of [...open.keys()]) end(key, now);
    // Concurrency only rises at a span's start, so those starts are the only moments worth counting.
    let peak = 0;
    for (const { start: moment } of spans) {
      const holders = new Set(spans.filter(span => span.start <= moment && moment < span.end).map(span => span.actor));
      peak = Math.max(peak, holders.size);
    }
    return peak;
  })();
  const claims = items.filter(item => item.status === 'claimed' && item.owner && Date.parse(item.claim?.until) > now);
  const reviewing = items.filter(item => item.status === 'submitted');
  // A live hold keeps its own unclipped start, apart from the per-minute union below, so a seat holding a review and
  // a build at once still reports each one's age; null means the history holds no open stay for this holder.
  /** When this holder's still-open stay on the item began, or null. */
  const since = (kind, item, by) => { const held = work.get(kind + ':' + item.id); return held?.actor === by ? held.start : null; };
  for (const item of claims) row(item.owner)?.current.push({ kind: 'build', item, since: since('build', item, item.owner) });
  for (const item of reviewing) if (item.reviewer && Date.parse(item.reviewUntil) > now) row(item.reviewer)?.current.push({ kind: 'review', item, since: since('review', item, item.reviewer) });
  for (const [key] of [...work]) close(key, now);
  const agents = [...rows.values()].filter(agent => agent.last > start || agent.current.length || agent.segments.length);
  for (const agent of agents) {
    // Union overlapping intervals: a minute is counted once, with building taking precedence.
    const points = [...new Set([start, now, ...agent.segments.flatMap(segment => [segment.start, segment.end])])].sort((a,b) => a-b);
    const union = [];
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1], b = points[index];
      const active = agent.segments.filter(segment => segment.start < b && segment.end > a);
      const segment = active.find(entry => entry.kind === 'build') || active[0];
      if (segment) { agent[segment.kind] += b-a; union.push({ ...segment, start: a, end: b }); }
    }
    agent.segments = union;
    agent.idle = Math.max(0, now - (agent.start ?? start) - agent.build - agent.review);
    agent.group = agent.current.some(entry => entry.kind === 'build') ? 'building'
      : agent.current.length ? 'reviewing' : agent.last > now - 20 * 60_000 ? 'between items' : 'quiet';
  }
  const times = [...landed.values()], pace = project.dashboardPace ?? project.milestones?.find(entry => entry.summary?.pace)?.summary.pace ?? null;
  const bins = Array.from({ length: 24 }, (_, index) => {
    const from = now - (24-index)*hour;
    return { from, to: from+hour, count: times.filter(at => at > from && at <= from+hour).length };
  });
  const milestone = (project.milestones ?? []).find(entry => !entry.shipped && entry.summary?.left > 0) ?? null;
  const milestoneIds = new Set(milestone?.items.filter(entry => typeof entry.id === 'number').map(entry => entry.id));
  /** The actual latest move time for a row, never its mutable update time when history is available. */
  const last = (item, kind) => Date.parse(latest.get(kind + ':' + item.id)?.event_at) || Date.parse(item.updatedAt) || now;
  const landing = items.filter(item => item.status === 'verified' && !merged.has(item.id)).map(item => ({ ...item, verifiedBy: latest.get('accept:' + item.id)?.event_by })).sort((a,b) => last(a,'accept')-last(b,'accept'));
  const inReview = reviewing.toSorted((a,b) => last(a,'submit')-last(b,'submit'));
  const heldItems = new Set((project.itemHolds ?? []).map(hold => hold.item));
  const heldLanes = new Set((project.holds ?? []).map(hold => hold.hold_lane));
  const order = new Map((project.dashboardNext ?? []).map((id, index) => [id, index]));
  const next = items.filter(item => item.status === 'open' && !(item.blockedBy?.length) && !heldItems.has(item.id) && !heldLanes.has(item.lane))
    .toSorted((a,b) => (order.get(a.id) ?? Infinity)-(order.get(b.id) ?? Infinity) || a.id-b.id);
  return { now, start, complete, pace, peak: complete ? peakAgents : null, claims, reviewing, agents, milestone, comparison: project.statsComparison ?? null,
    pipeline: project.statsPipeline ?? null,
    stageCounts,
    inFlight: { building: claims.filter(item => milestoneIds.has(item.id)), review: reviewing.filter(item => milestoneIds.has(item.id)) },
    landed: [...landed].map(([id, at]) => ({ item: byId.get(id), at })).sort((a,b) => b.at-a.at),
    bins, landing, inReview, next, last,
    totals: { working: agents.filter(agent => agent.group !== 'quiet').length,
      allTime: merged.size,
      day: pace?.last24h ?? (complete ? times.filter(at => at > now-24*hour).length : null),
      recent: complete ? times.filter(at => at > start).length : null,
      passed: complete ? passed : null,
      sentBack: complete ? sentBack : null,
      shouts: complete ? personShouts : null },
  };
}
