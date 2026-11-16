import { itemLanded } from "../../logic/counts.js";
import { itemStageKey } from "../../logic/pipeline/model.js";
import { itemStagePresentation } from "../../logic/pipeline/model.js";

/** Project the Dashboard from one authoritative item snapshot and its complete ordered event prefix [N26]. */
export function dashboardModel(project, history, { now, complete = true, working = null, fold = null } = {}) {
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
  const stageCounts = Object.fromEntries(['blocked','ready','building','in-review','verified','landing','merged'].map(key => [key, 0]));
  // The same stage words and keys the Items Pipeline groups by, so the strip and the pipeline agree.
  for (const item of items) {
    if (item.status === 'withdrawn' && !itemLanded(item)) continue;
    const key = itemStageKey(itemStagePresentation(item, { gated: Boolean(item.blockedBy?.length || item.heldReason || item.laneHoldReason), landingBatchAt: item.landingBatchAt }).stage);
    if (itemLanded(item)) stageCounts.merged++;
    else if (key in stageCounts) stageCounts[key]++;
  }
  // Every landed item is known from its own row; only the last day's landings list their commit, to match merge events (#6666).
  const merged = new Map(items.filter(item => item.merged || item.stage === 'merged').map(item => [item.id, { id: item.id, commit: null }]));
  for (const entry of project.dashboardLanded ?? []) merged.set(entry.id, entry);
  const prefix = project.sequence ?? Infinity;
  /** Parse only native event JSON; malformed history cannot create activity. */
  const detail = event => { try { return JSON.parse(event.event_detail || '{}'); } catch { return {}; } };
  /*
   * Everything the history decides that does not depend on the clock, folded one event at a time into `fold.state`
   * (#6678): when the caller keeps one `fold` object per board and passes the board's events in id order, each call
   * folds only the events after the last one it folded, so a live update never rescans or re-parses the history.
   * With no `fold` the whole history is folded into a fresh state, so both paths run the same code.
   * Kept inside this function because the page embeds dashboardModel's source text, so no helper may sit outside it [N26].
   */
  const blank = () => ({ upto: -1, now: -Infinity, latest: new Map(), mergedAt: new Map(), joined: new Map(), lastBy: new Map(),
    work: new Map(), closed: [], tail: [], tailCap: 8192, gateAt: new Map() });
  /** Fold one event, whose time is `at`, into a state. */
  const apply = (state, event, at) => {
    const kind = event.event_kind, id = event.item_id, by = event.event_by;
    const shout = kind === 'shout', closes = ['accept', 'reject', 'reopen', 'withdraw', 'patch'].includes(kind);
    const needsDetail = shout || ['join', 'claim', 'renew', 'reserve', 'release', 'merged', 'gate-run', 'proof-run'].includes(kind);
    const d = needsDetail ? detail(event) : null;
    if (kind === 'join' && typeof d.lane === 'string' && d.lane && d.lane !== 'coordinator' && by && !state.joined.has(by)) state.joined.set(by, at);
    /** End one open stay, keeping it for the windows that read it. */
    const close = (key, when) => {
      const held = state.work.get(key); if (!held) return;
      state.closed.push({ held, at: Math.min(when, held.until) });
      state.work.delete(key);
    };
    state.lastBy.set(by, Math.max(state.lastBy.get(by) ?? 0, at));
    // The flow's own moves (#6847): a new claim, a submit with its build time, a build handed back, and a gate's verdict.
    const building = state.work.get('build:' + id);
    const gate = kind === 'gate-run' && typeof d.run?.green === 'boolean' ? d.run.green
      : kind === 'proof-run' && ['submit', 'gate'].includes(d.receipt?.kind) && Number.isInteger(d.receipt?.exitCode) ? d.receipt.exitCode === 0 : null;
    if (gate !== null && id) state.gateAt.set(id, at);
    const flow = kind === 'claim' && building?.actor !== by ? 'claimed' : kind === 'submit' ? 'submitted'
      : kind === 'release' && !d.review ? 'handed back' : gate === null ? null : gate ? 'green' : 'red';
    if (flow) state.tail.push({ at, kind: flow, by, item: id, took: flow === 'submitted' && building ? at - building.start : null });
    if (['accept', 'reject', 'reopen'].includes(kind) || shout) state.tail.push({ at, kind, by, item: id, person: shout && d.to === 'person' });
    if (state.tail.length >= state.tailCap) {
      state.tail = state.tail.filter(entry => entry.at > start);
      state.tailCap = Math.max(8192, state.tail.length * 2);
    }
    for (const [key, held] of state.work) if (held.until <= at) close(key, held.until);
    state.latest.set(kind + ':' + id, event);
    if (kind === 'merged' && typeof d.commit === 'string' && d.commit) {
      if (!state.mergedAt.has(id)) state.mergedAt.set(id, []);
      state.mergedAt.get(id).push({ at, commit: d.commit, event: event.event_id });
    }
    if (['claim', 'renew'].includes(kind)) {
      // Renewals extend the same stay; a replacement closes the prior actor's stay.
      const key = 'build:' + id, held = state.work.get(key);
      if (held?.actor !== by) { close(key, at); state.work.set(key, { actor: by, item: id, kind: 'build', start: at, until: Date.parse(d.leaseUntil) || at }); }
      else held.until = Date.parse(d.leaseUntil) || held.until;
    }
    if (['submit', 'lapse', 'withdraw', 'reopen'].includes(kind) || kind === 'release' && !d.review) close('build:' + id, at);
    if (kind === 'release' && d.review) close('review:' + id, at);
    if (kind === 'reserve') {
      const key = 'review:' + id;
      if (state.work.get(key)?.actor !== by) { close(key, at); state.work.set(key, { actor: by, item: id, kind: 'review', start: at, until: Date.parse(d.until) || at }); }
      else state.work.get(key).until = Date.parse(d.until) || state.work.get(key).until;
    }
    if (closes) close('review:' + id, at);
  };
  /** Fold the events after the state's last, as far as the prefix; false when one has no usable time at or before now. */
  const fill = (state, list, from, strict) => {
    for (let index = from; index < list.length && list[index].event_id <= prefix; index++) {
      const event = list[index], at = Date.parse(event.event_at);
      if (!(at <= now)) { if (strict) return false; continue; }
      apply(state, event, at);
      state.upto = event.event_id;
    }
    return true;
  };
  let state = fold?.state ?? null;
  if (!fold) {
    state = blank();
    fill(state, history.filter(event => event.event_id <= prefix).sort((a, b) => a.event_id - b.event_id), 0, false);
  } else {
    if (state && (state.now > now || state.upto > prefix)) state = null;
    state ??= blank();
    // The events are in id order, so the first unfolded one is found by halving.
    let low = 0, high = history.length;
    while (low < high) { const mid = (low + high) >> 1; if (history[mid].event_id <= state.upto) low = mid + 1; else high = mid; }
    if (!fill(state, history, low, true)) {
      // An event dated after the clock (or with no date) can fold in later: fold the whole history without keeping it.
      state = blank();
      fill(state, history, 0, false);
      fold.state = null;
    } else fold.state = state;
  }
  state.now = now;
  const { latest } = state;
  const seats = new Set([...(project.agents ?? []).map(agent => agent.agent_id), ...state.joined.keys()]);
  const landed = new Map(), rows = new Map();
  /** Attribute history only to registered seats; board automation is not an agent. */
  const row = id => {
    if (!seats.has(id) || id === 'coordinator') return null;
    if (!rows.has(id)) rows.set(id, { id, name: id, segments: [], build: 0, review: 0, idle: 0, shouts: 0, shoutAt: [], last: 0, current: [], sentBack: [],
      ...(state.joined.has(id) ? { start: Math.max(start, state.joined.get(id)) } : {}) });
    return rows.get(id);
  };
  for (const agent of project.agents ?? []) {
    const entry = row(agent.agent_id);
    if (entry) { entry.name = agent.agent_id; entry.model = agent.model || agent.agent_model || ''; entry.lane = agent.agent_lane ?? agent.lane ?? null; entry.presence = agent.presence ?? null; entry.last = Date.parse(agent.lastMoveAt) || 0; entry.start = Math.max(start, Date.parse(agent.agent_created_at) || start); }
  }
  // Seats appear in the order their first event came, after those the API lists.
  for (const [by, at] of state.lastBy) { const entry = row(by); if (entry) entry.last = Math.max(entry.last, at); }
  state.tail = state.tail.filter(entry => entry.at > start);
  const acceptedItems = new Set();
  let sentBack = 0, personShouts = 0;
  for (const entry of state.tail) {
    const actor = row(entry.by);
    if (entry.kind === 'accept') acceptedItems.add(entry.item);
    if (['reject', 'reopen'].includes(entry.kind)) { sentBack++; actor?.sentBack.push({ at: entry.at, item: entry.item }); }
    if (entry.kind === 'shout') { if (entry.person) personShouts++; if (actor) { actor.shouts++; actor.shoutAt.push(entry.at); } }
  }
  // Every landing the page knows, matched to the first merge event that carries its current commit.
  for (const [id, entry] of merged) {
    if (!byId.has(id) || typeof entry.commit !== 'string' || !entry.commit) continue;
    const first = state.mergedAt.get(id)?.find(event => event.commit === entry.commit);
    if (first) landed.set(id, first);
  }
  const landedAt = new Map([...landed].sort((a, b) => a[1].event - b[1].event).map(([id, first]) => [id, first.at]));
  landed.clear();
  for (const [id, at] of landedAt) landed.set(id, at);
  // The server's own landings carry their time: the first recording of each current merge, the same one Pace and the counts use (#7763).
  for (const entry of project.dashboardLanded ?? []) if (byId.has(entry.id) && Number.isFinite(entry.at)) landed.set(entry.id, entry.at);
  // Stays that ended long ago can no longer touch a window; the rest, and the stays still open, make the spans.
  const floorAt = now - 24 * hour;
  if (state.closed.some(span => span.at <= floorAt)) state.closed = state.closed.filter(span => span.at > floorAt);
  const spans = [...state.closed, ...[...state.work.values()].map(held => ({ held, at: Math.min(now, held.until) }))];
  for (const { held, at } of spans) {
    const actor = row(held.actor);
    if (actor && at > start && held.start < now) actor.segments.push({ ...held, start: Math.max(start, held.start), end: Math.min(now, at) });
  }
  /**
   * The most agents holding a claim or a review at one moment in the last 24 hours, read from the same claim, renew,
   * reserve, release and close events the timeline reads. An agent counts once however many holds it has open then.
   */
  const peakAgents = () => {
    const edges = [];
    for (const { held, at } of spans) {
      const from = Math.max(held.start, floorAt), to = Math.min(at, now);
      if (to > from) { edges.push({ at: from, rise: true, actor: held.actor }); edges.push({ at: to, rise: false, actor: held.actor }); }
    }
    // At one moment the ended spans leave before the starting ones count, since a span covers its start but not its end.
    edges.sort((a, b) => a.at - b.at || a.rise - b.rise);
    const holding = new Map();
    let peak = 0;
    for (let index = 0; index < edges.length;) {
      const moment = edges[index].at;
      let rose = false;
      for (; index < edges.length && edges[index].at === moment; index++) {
        const edge = edges[index], count = (holding.get(edge.actor) ?? 0) + (edge.rise ? 1 : -1);
        if (count) holding.set(edge.actor, count); else holding.delete(edge.actor);
        rose ||= edge.rise;
      }
      if (rose) peak = Math.max(peak, holding.size);
    }
    return peak;
  };
  const claims = items.filter(item => item.status === 'claimed' && !itemLanded(item) && item.owner && Date.parse(item.claim?.until) > now);
  const reviewing = items.filter(item => item.status === 'submitted' && !itemLanded(item));
  // A live hold keeps its own unclipped start, apart from the per-minute union below, so a seat holding a review and
  // a build at once still reports each one's age; null means the history holds no open stay for this holder.
  /** When this holder's still-open stay on the item began, or null. */
  const since = (kind, item, by) => { const held = state.work.get(kind + ':' + item.id); return held?.actor === by ? held.start : null; };
  for (const item of claims) row(item.owner)?.current.push({ kind: 'build', item, since: since('build', item, item.owner) });
  for (const item of reviewing) if (item.reviewer && Date.parse(item.reviewUntil) > now) row(item.reviewer)?.current.push({ kind: 'review', item, since: since('review', item, item.reviewer) });
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
    // Who is at work is the notch's list when the page passes it (every count of agents at work reads that one list); alone, the model's own reading.
    // With the notch's list empty or absent, a seat that moved in the last 20 minutes is between items at least, so a board whose agents just finished still lists them (#7945); a list that names agents is the only one.
    const named = Array.isArray(working) && working.length > 0;
    const atWork = named ? working.includes(agent.id) : agent.current.length > 0 || agent.last > now - 20 * 60_000;
    // A build claim the board read marks stalled or waiting is held, not built: it groups apart from building [C7,#3021].
    const idleClaim = entry => ['stalled', 'waiting'].includes(entry.item?.claimHealth?.state);
    agent.group = !atWork ? 'quiet' : agent.current.some(entry => entry.kind === 'build' && !idleClaim(entry)) ? 'building'
      : agent.current.some(entry => entry.kind === 'build') ? 'stalled' : agent.current.length ? 'reviewing' : 'between items';
  }
  // The server's own four-hour counts stand in while the browser's history is incomplete; never a guess from a partial log.
  const recent = project.dashboardRecent && typeof project.dashboardRecent === 'object' ? project.dashboardRecent : null;
  /** One server-read count, or null when the board sent none. */
  const read = key => Number.isInteger(recent?.[key]) && recent[key] >= 0 ? recent[key] : null;
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
  /*
   * The /live-style Dashboard (#6847): how work moved in the last four hours, where every item is now, the four short
   * lists and the lanes, all read from the same items, folded events and landings as the rest of this model.
   */
  const reserved = item => Boolean(item.reviewer) && Date.parse(item.reviewUntil) > now;
  // A submitted item is in the gate until a gate verdict is recorded after its submit, unless a reviewer already holds it.
  const inGate = reviewing.filter(item => !reserved(item) && !((state.gateAt.get(item.id) ?? 0) >= last(item, 'submit'))).toSorted((a, b) => last(a, 'submit') - last(b, 'submit'));
  const gateIds = new Set(inGate.map(item => item.id));
  const checked = inReview.filter(item => !gateIds.has(item.id));
  const moved = kind => state.tail.filter(entry => entry.kind === kind);
  const took = moved('submitted').map(entry => entry.took).filter(Number.isFinite).sort((a, b) => a - b);
  const median = took.length ? took[Math.floor((took.length - 1) / 2)] : null;
  const landedRecent = [...landed].filter(([, at]) => at > start);
  const lastLanded = Math.max(0, ...landed.values());
  // Passed review counts each item once: one the reviewer accepted in the window, or one that landed in it (a landing
  // is a pass even when the board recorded no accept, as for a hand landing), so it never reads 0 beside its landings.
  const shared = project.counts ?? null;
  const passed = new Set([...acceptedItems, ...landedRecent.map(([id]) => id)]).size;
  const waitingReview = checked.filter(item => !reserved(item));
  const flow = complete ? {
    claimed: moved('claimed').length, submitted: moved('submitted').length, handedBack: moved('handed back').length, buildMedian: median,
    green: moved('green').length, red: moved('red').length, gateRunning: inGate.length,
    accepted: passed, sentBack: Number.isInteger(shared?.sentBack?.count) ? shared.sentBack.count : sentBack, waitingReview: waitingReview.length,
    oldestWait: waitingReview.length ? Math.min(...waitingReview.map(item => last(item, 'submit'))) : null,
    landed: Number.isInteger(shared?.landed?.last4h) ? shared.landed.last4h : landedRecent.length, lastLanded: lastLanded || null,
  } : null;
  const blocked = item => Boolean(item.blockedBy?.length);
  const held = item => heldItems.has(item.id) || heldLanes.has(item.lane);
  const open = items.filter(item => item.status === 'open');
  const backItems = items.filter(item => ['open', 'claimed'].includes(item.status) && item.verdict?.decision === 'REJECT');
  // A claim the board read marks stalled or waiting is held, not built, so it never counts as building [C7,#6477].
  const idleClaim = item => ['stalled', 'waiting'].includes(item.claimHealth?.state);
  const stages = { ready: Number.isInteger(shared?.ready) ? shared.ready : next.length, waiting: Number.isInteger(shared?.blocked) ? shared.blocked : open.filter(item => blocked(item) && !held(item)).length, building: claims.filter(item => !idleClaim(item)).length,
    stalled: claims.filter(item => item.claimHealth?.state === 'stalled').length, waitingClaims: claims.filter(item => item.claimHealth?.state === 'waiting').length,
    gate: inGate.length, review: checked.length, toLand: landing.length, sentBack: backItems.length, held: open.filter(held).length,
    active: items.filter(item => !['withdrawn', 'verified'].includes(item.status)).length };
  // Each lane's work now and its last four hours; the board's own lane list first, then any lane an item names.
  const sentBackItems = new Set(state.tail.filter(entry => ['reject', 'reopen'].includes(entry.kind)).map(entry => entry.item));
  const laneNames = [...new Set([...(project.lanes ?? []), ...items.filter(item => item.status !== 'withdrawn').map(item => item.lane)])].filter(lane => lane && lane !== 'coordinator');
  const lanes = laneNames.map(lane => ({ lane,
    building: claims.filter(item => item.lane === lane && !idleClaim(item)).length, review: reviewing.filter(item => item.lane === lane).length,
    ready: next.filter(item => item.lane === lane).length,
    landed: complete ? landedRecent.filter(([id]) => byId.get(id)?.lane === lane).length : null,
    sentBack: complete ? [...sentBackItems].filter(id => byId.get(id)?.lane === lane).length : null }))
    .filter(row => row.building + row.review + row.ready + (row.landed ?? 0) + (row.sentBack ?? 0) > 0);
  const lists = { gate: inGate, review: checked, accepted: landing,
    landed: landedRecent.map(([id, at]) => ({ item: byId.get(id), at })).sort((a, b) => b.at - a.at) };
  return { now, start, complete, pace, peak: complete ? peakAgents() : null, claims, reviewing, agents, milestone, comparison: project.statsComparison ?? null,
    flow, stages, lanes, lists, runners: project.dashboardRunners ?? null,
    pipeline: project.statsPipeline ?? null,
    stageCounts,
    inFlight: { building: claims.filter(item => milestoneIds.has(item.id)), review: reviewing.filter(item => milestoneIds.has(item.id)) },
    landed: [...landed].map(([id, at]) => ({ item: byId.get(id), at })).sort((a,b) => b.at-a.at),
    bins, landing, inReview, next, last,
    // At work, runners and sent back are the state's shared counts, so the top bar, this page and Activity never differ (#7310).
    totals: { working: Number.isInteger(shared?.agents) ? shared.agents : Array.isArray(working) ? working.length : agents.filter(agent => agent.group !== 'quiet').length,
      joined: Number.isInteger(shared?.joined) ? shared.joined : null,
      runners: Number.isInteger(shared?.runners) ? shared.runners : (project.dashboardRunners?.runners ?? []).length,
      allTime: Number.isInteger(shared?.landed?.total) ? shared.landed.total : merged.size,
      day: pace?.last24h ?? (Number.isInteger(shared?.landed?.last24h) ? shared.landed.last24h : complete ? times.filter(at => at > now-24*hour).length : null),
      recent: Number.isInteger(shared?.landed?.last4h) ? shared.landed.last4h : complete ? times.filter(at => at > start).length : read('landed'),
      passed: complete ? passed : read('passed'),
      sentBack: Number.isInteger(shared?.sentBack?.count) ? shared.sentBack.count : complete ? sentBack : read('sentBack'),
      shouts: complete ? personShouts : read('shouts') },
    // Why a hero count is missing, for its hover; null once every count is a number.
    unread: complete || recent ? null : 'The board has not sent its last-4-hour counts yet, and its full event history is still loading.',
  };
}
