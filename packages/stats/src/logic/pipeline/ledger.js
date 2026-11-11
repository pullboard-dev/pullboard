/**
 * The pipeline ledger [C7]: where every millisecond, runner second and agent token of an item's loop went, per hop,
 * from its claim to its merge. It joins the board's events, the gate phase spans, the landing step spans, the proof-run
 * receipts and the agents' session activity into one record per item, and sums them into a per-hop table.
 *
 * Why a state machine over the events rather than event pairs: pairs (claim to submit, green to reserve) leave the
 * time between them unnamed when a gate goes red, a review is released or a reject reopens the item. Here every instant
 * between the cycle's first claim and its merge belongs to exactly one hop, so the hops sum to the whole by construction,
 * and a gap shows up as a named "untraced" hop instead of vanishing.
 */

/** The top-level hops, in loop order. */
export const LEDGER_HOPS = Object.freeze(['build', 'gate', 'after failed gate', 'rework after red gate', 'review wait', 'review',
  'rework after reject', 'unowned', 'land']);

/** Version of the --json document; bump for an incompatible change. */
export const LEDGER_VERSION = 1;

/** Agent activity kinds, grouped into the four the person reads. */
export const ACTIVITY_GROUPS = Object.freeze({ thinking: 'thinking', command: 'commands', pullboard: 'commands', tests: 'commands',
  submit: 'commands', waiting: 'waiting', idle: 'idle' });

const RED_STATES = new Set(['red', 'incomplete', 'infrastructure', 'ended']);
const GATE_STATES = new Set(['queued', 'running', 'submitted']);

/**
 * The nearest-rank percentile of sorted numbers, 0 for none.
 *
 * @param {number[]} sorted
 * @param {number} p - 0 to 1
 * @returns {number}
 */
export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/**
 * Split [start, end] into labelled pieces from overlapping spans: at each instant the span that started last wins
 * (the step in progress), and an instant no span covers takes the gap label. The pieces always tile the interval.
 *
 * @param {number} start
 * @param {number} end
 * @param {{ start: number, end: number, label: string }[]} spans
 * @param {string} gap
 * @returns {{ start: number, end: number, label: string }[]}
 */
export function tile(start, end, spans, gap) {
  if (!(end > start)) return [];
  const inside = spans.filter(span => span.end > start && span.start < end && span.end > span.start);
  const cuts = [...new Set([start, end, ...inside.flatMap(span => [span.start, span.end]).filter(at => at > start && at < end)])].sort((a, b) => a - b);
  const pieces = [];
  for (let index = 0; index < cuts.length - 1; index += 1) {
    const from = cuts[index], to = cuts[index + 1];
    let best = null;
    for (const span of inside) if (span.start <= from && span.end >= to && (!best || span.start > best.start)) best = span;
    const label = best ? best.label : gap;
    const last = pieces.at(-1);
    if (last && last.label === label && last.end === from) last.end = to;
    else pieces.push({ start: from, end: to, label });
  }
  return pieces;
}

/**
 * The top-level hop that follows one board event, given the item's flags so far. Null keeps the current hop.
 *
 * @param {{ kind: string, state?: string|null }} event
 * @param {{ red: boolean, rejected: boolean, hop: string|null }} flags
 * @returns {string|null}
 */
function hopAfter(event, flags) {
  switch (event.kind) {
    case 'claim': case 'renew':
      if (flags.hop === 'gate' || flags.hop === 'review wait' || flags.hop === 'review' || flags.hop === 'land') return null;
      return flags.rejected ? 'rework after reject' : flags.red ? 'rework after red gate' : 'build';
    case 'submit-handoff':
      if (GATE_STATES.has(event.state)) return 'gate';
      if (event.state === 'green') { flags.red = false; return flags.hop === 'review' || flags.hop === 'land' ? null : 'review wait'; }
      if (RED_STATES.has(event.state)) { flags.red = true; return 'after failed gate'; }
      return null;
    case 'submit': flags.red = false; flags.rejected = false; return flags.hop === 'review' || flags.hop === 'land' ? null : 'review wait';
    case 'reserve': return 'review';
    case 'reject': flags.rejected = true; return 'rework after reject';
    case 'accept': return 'land';
    case 'release': return flags.hop === 'review' ? 'review wait' : flags.hop === 'build' || flags.hop?.startsWith('rework') ? 'unowned' : null;
    default: return null;
  }
}

/**
 * The cycle an item's ledger covers: from the last claim before its first submit (or its last claim when it never
 * submitted) to its merge, withdrawal or now.
 *
 * @param {{ at: number, kind: string }[]} events - one item's events, oldest first
 * @param {number} now
 * @returns {{ start: number, end: number, merged: number|null }|null}
 */
export function itemCycle(events, now) {
  const firstSubmit = events.findIndex(event => event.kind === 'submit-handoff' || event.kind === 'submit');
  const before = firstSubmit < 0 ? events : events.slice(0, firstSubmit);
  const claim = before.findLast(event => event.kind === 'claim');
  if (!claim) return null;
  const close = events.find(event => event.at >= claim.at && (event.kind === 'merged' || event.kind === 'withdraw'));
  return { start: claim.at, end: close ? close.at : now, merged: close?.kind === 'merged' ? close.at : null };
}

/**
 * The landing window for an item: the last landing batch that named it as a candidate before its merge (or now), from
 * that batch's start (never before the accept) to the merge.
 *
 * @param {number} item
 * @param {number} accept
 * @param {number} merged - the merge, or now while it is still landing
 * @param {{ id: string, startedAt: number, at: number, candidates: number[] }[]} batches
 * @returns {{ start: number, batch: string }|null}
 */
function landingWindow(item, accept, merged, batches) {
  const mine = batches.filter(batch => batch.candidates.includes(item) && batch.startedAt <= merged && batch.at >= accept);
  const last = mine.reduce((best, batch) => !best || batch.startedAt > best.startedAt ? batch : best, null);
  return last ? { start: Math.max(accept, Math.min(merged, last.startedAt)), batch: last.id } : null;
}

/**
 * One item's ledger: its cycle tiled into hops and sub-hops, its gate attempts, compute and tokens.
 *
 * @param {object} input
 * @param {number} input.item
 * @param {{ at: number, kind: string, state?: string|null, by?: string }[]} input.events - this item's events, oldest first
 * @param {object[]} input.gateSpans - this item's gate spans
 * @param {object[]} input.landingSpans - every landing span near the cycle
 * @param {object[]} input.batches - landing batches
 * @param {object[]} input.receipts - this item's proof-run receipts
 * @param {(from: number, to: number) => object} input.tokensFor - tokens the item's seats spent in a window
 * @param {number} input.now
 * @returns {object|null}
 */
export function itemLedger({ item, events, gateSpans = [], landingSpans = [], batches = [], receipts = [], tokensFor = () => emptyTokens(), now }) {
  const cycle = itemCycle(events, now);
  if (!cycle) return null;
  const top = [];
  const flags = { red: false, rejected: false, hop: null };
  let at = cycle.start, hop = 'build';
  for (const event of events) {
    if (event.at < cycle.start || event.at > cycle.end) continue;
    flags.hop = hop;
    const next = hopAfter(event, flags);
    if (next === null || next === hop) continue;
    if (event.at > at) top.push({ hop, start: at, end: event.at });
    at = Math.max(at, event.at);
    hop = next;
  }
  if (cycle.end > at) top.push({ hop, start: at, end: cycle.end });
  const gates = gateSpans.map(span => ({ start: Date.parse(span.start), end: Date.parse(span.end), label: `gate.${span.phase}` }));
  const accept = events.findLast(event => event.kind === 'accept' && event.at <= cycle.end)?.at ?? null;
  // An accepted item still landing is measured against the batch now carrying it.
  const window = accept !== null ? landingWindow(item, accept, cycle.end, batches) : null;
  const lands = landingSpans.map(span => ({ start: Date.parse(span.start), end: Date.parse(span.end), label: `land.${span.phase}` }));
  const segments = [];
  for (const piece of top) {
    if (piece.hop === 'gate') {
      for (const part of tile(piece.start, piece.end, gates, 'gate.untraced')) segments.push({ hop: part.label, parent: 'gate', start: part.start, end: part.end });
    } else if (piece.hop === 'land') {
      // A batch that starts after this landing hop ended (a later reject, say) leaves the whole hop a queue wait.
      const from = window ? Math.min(piece.end, Math.max(piece.start, window.start)) : piece.end;
      if (from > piece.start) segments.push({ hop: 'land.queue', parent: 'land', start: piece.start, end: from });
      for (const part of tile(from, piece.end, lands, 'land.untraced')) segments.push({ hop: part.label, parent: 'land', start: part.start, end: part.end });
    } else segments.push({ hop: piece.hop, parent: null, start: piece.start, end: piece.end });
  }
  for (const segment of segments) {
    segment.ms = segment.end - segment.start;
    segment.tokens = tokensFor(segment.start, segment.end);
  }
  const hops = {};
  for (const segment of segments) {
    const name = segment.parent ?? segment.hop;
    hops[name] = (hops[name] ?? 0) + segment.ms;
    if (segment.parent) hops[segment.hop] = (hops[segment.hop] ?? 0) + segment.ms;
  }
  const totalMs = cycle.end - cycle.start;
  const attributedMs = segments.reduce((sum, segment) => sum + segment.ms, 0);
  const inCycle = gateSpans.filter(span => Date.parse(span.end) >= cycle.start && Date.parse(span.start) <= cycle.end);
  const mineReceipts = receipts.filter(receipt => receipt.at >= cycle.start && receipt.at <= cycle.end);
  const tokens = tokensFor(cycle.start, cycle.end);
  return {
    item, start: cycle.start, end: cycle.end, merged: cycle.merged, open: !cycle.merged && cycle.end === now, totalMs, attributedMs,
    unattributedMs: totalMs - attributedMs, hops, segments,
    gateAttempts: new Set(inCycle.map(span => span.job)).size,
    submits: events.filter(event => event.kind === 'submit-handoff' && event.state === 'queued' && event.at >= cycle.start && event.at <= cycle.end).length,
    landingBatch: window?.batch ?? null,
    compute: itemCompute(inCycle, mineReceipts),
    tokens,
  };
}

/**
 * Runner and coordinator seconds for one item: span time by host and phase, and proof-run time, files and shards.
 *
 * @param {object[]} spans - gate spans in the cycle
 * @param {{ runner?: string, durationMs?: number, files?: number }[]} receipts
 * @returns {object}
 */
export function itemCompute(spans, receipts) {
  const byHost = {}, byPhase = {};
  for (const span of spans) {
    const host = !span.host || span.host === 'local' ? 'coordinator' : span.host;
    byHost[host] = (byHost[host] ?? 0) + (span.ms ?? 0);
    byPhase[`gate.${span.phase}`] = (byPhase[`gate.${span.phase}`] ?? 0) + (span.ms ?? 0);
  }
  const tests = {};
  for (const receipt of receipts) {
    const runner = receipt.runner ?? 'unknown';
    const row = tests[runner] ??= { runner, ms: 0, files: 0, shards: 0 };
    row.ms += receipt.durationMs ?? 0; row.files += receipt.files ?? 0; row.shards += 1;
  }
  return { byHost, byPhase, tests: Object.values(tests),
    testFiles: receipts.reduce((sum, receipt) => sum + (receipt.files ?? 0), 0), shards: receipts.length };
}

/** A zeroed token tally. */
export function emptyTokens() {
  return { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, byModel: {} };
}

/**
 * Add one token bucket to a tally.
 *
 * @param {ReturnType<typeof emptyTokens>} tally
 * @param {{ m?: string, fresh?: number, read?: number, write?: number, out?: number }} bucket
 */
export function addTokens(tally, bucket) {
  const fresh = bucket.fresh ?? 0, read = bucket.read ?? 0, write = bucket.write ?? 0, out = bucket.out ?? 0;
  tally.fresh += fresh; tally.cacheRead += read; tally.cacheWrite += write; tally.output += out;
  tally.total += fresh + read + write + out;
  const model = bucket.m || 'unknown';
  tally.byModel[model] = (tally.byModel[model] ?? 0) + fresh + read + write + out;
}

/**
 * Who each seat was working as over time, from its claim, submit, review and release events.
 *
 * @param {{ at: number, kind: string, by: string, item: number|null }[]} events - oldest first
 * @returns {Map<string, { at: number, role: string, item: number|null }[]>}
 */
export function seatAssignments(events) {
  const seats = new Map();
  for (const event of events) {
    if (!event.by || event.by === 'coordinator') continue;
    const role = ['claim', 'renew', 'submit', 'submit-handoff'].includes(event.kind) ? 'builder'
      : ['reserve', 'accept', 'reject'].includes(event.kind) ? 'reviewer'
        : event.kind === 'release' ? 'unassigned' : null;
    if (!role) continue;
    const list = seats.get(event.by) ?? [];
    const item = role === 'unassigned' ? null : event.item;
    const last = list.at(-1);
    if (!last || last.role !== role || last.item !== item) list.push({ at: event.at, role, item });
    seats.set(event.by, list);
  }
  return seats;
}

/**
 * The seat a working folder belongs to: the joined agent whose path holds it (longest wins), or whose item folder
 * (`<seat path>-item-<id>`) it is, or the seat a wrapper named (`seat:<name>`), else the coordinator when it is the main checkout or anything else this repo's
 * sessions ran in.
 *
 * @param {string|null} cwd
 * @param {{ id: string, path: string, lane?: string }[]} agents - sorted longest path first
 * @returns {{ id: string, lane: string|null }}
 */
export function seatOf(cwd, agents) {
  if (cwd?.startsWith('seat:')) {
    // A seat wrapper names the seat by its worktree's suffix: seat-<name>.sh drives <repo>-<name>.
    const name = cwd.slice('seat:'.length);
    for (const agent of agents) if (agent.path.endsWith(`-${name}`) || agent.path.endsWith(`/${name}`)) return { id: agent.id, lane: agent.lane ?? null };
    return { id: 'coordinator', lane: 'coordinator' };
  }
  if (cwd) for (const agent of agents) if (cwd === agent.path || cwd.startsWith(agent.path + '/') || cwd.startsWith(agent.path + '-item-')) return { id: agent.id, lane: agent.lane ?? null };
  return { id: 'coordinator', lane: 'coordinator' };
}

/**
 * The role and item a seat held at one instant.
 *
 * @param {{ id: string, lane: string|null }} seat
 * @param {Map<string, { at: number, role: string, item: number|null }[]>} assignments
 * @param {number} at
 * @returns {{ role: string, item: number|null }}
 */
export function roleAt(seat, assignments, at) {
  if (seat.id === 'coordinator') return { role: 'coordinator', item: null };
  const list = assignments.get(seat.id) ?? [];
  let low = 0, high = list.length - 1, found = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (list[mid].at <= at) { found = list[mid]; low = mid + 1; } else high = mid - 1;
  }
  const lane = String(seat.lane ?? '');
  const fallback = /unblock/u.test(seat.id) || /unblock/u.test(lane) ? 'unblocker' : lane === 'tests' ? 'reviewer' : 'unassigned';
  if (!found || found.role === 'unassigned') return { role: fallback, item: null };
  return { role: found.role, item: found.item };
}

/**
 * Attribute session activity and tokens to seats, roles, models and items.
 *
 * @param {object} input
 * @param {{ s: number, e: number, k: string, m?: string, c?: string }[]} input.segments
 * @param {{ t: number, m?: string, c?: string, fresh?: number, read?: number, write?: number, out?: number }[]} input.buckets
 * @param {{ id: string, path: string, lane?: string }[]} input.agents
 * @param {Map<string, object[]>} input.assignments
 * @param {number} input.since
 * @param {number} input.now
 * @returns {{ roles: object[], models: object[], itemBuckets: Map<number, object[]>, totals: object }}
 */
export function attributeAgents({ segments, buckets, agents, assignments, since, now }) {
  const sorted = [...agents].filter(agent => agent.path).sort((a, b) => b.path.length - a.path.length);
  const seatCache = new Map();
  const seat = cwd => { if (!seatCache.has(cwd)) seatCache.set(cwd, seatOf(cwd, sorted)); return seatCache.get(cwd); };
  const roles = new Map(), models = new Map();
  const row = (map, key, base) => { if (!map.has(key)) map.set(key, { ...base, minutes: { thinking: 0, commands: 0, waiting: 0, idle: 0 }, kinds: {}, tokens: emptyTokens(), seats: new Set() }); return map.get(key); };
  for (const segment of segments) {
    const from = Math.max(segment.s, since), to = Math.min(segment.e, now);
    if (!(to > from)) continue;
    const who = seat(segment.c ?? null);
    const { role } = roleAt(who, assignments, from);
    const model = segment.m || 'unknown';
    const minutes = (to - from) / 60_000;
    for (const target of [row(roles, `${role}\0${model}`, { role, model }), row(models, model, { model })]) {
      target.minutes[ACTIVITY_GROUPS[segment.k] ?? 'commands'] += minutes;
      target.kinds[segment.k] = (target.kinds[segment.k] ?? 0) + minutes;
      target.seats.add(who.id);
    }
  }
  const itemBuckets = new Map();
  const totals = emptyTokens();
  for (const bucket of buckets) {
    if (bucket.t < since || bucket.t > now) continue;
    const who = seat(bucket.c ?? null);
    const { role, item } = roleAt(who, assignments, bucket.t);
    const model = bucket.m || 'unknown';
    for (const target of [row(roles, `${role}\0${model}`, { role, model }), row(models, model, { model })]) { addTokens(target.tokens, bucket); target.seats.add(who.id); }
    addTokens(totals, bucket);
    if (item !== null && item !== undefined) {
      const list = itemBuckets.get(item) ?? [];
      list.push({ ...bucket, role });
      itemBuckets.set(item, list);
    }
  }
  const logged = new Set([...roles.values()].flatMap(value => [...value.seats]));
  const finish = value => ({ ...value, seats: value.seats.size, minutes: Object.fromEntries(Object.entries(value.minutes).map(([key, minutes]) => [key, round(minutes, 1)])),
    kinds: Object.fromEntries(Object.entries(value.kinds).map(([key, minutes]) => [key, round(minutes, 1)])) });
  return {
    roles: [...roles.values()].map(finish).sort((a, b) => b.tokens.total - a.tokens.total || a.role.localeCompare(b.role)),
    models: [...models.values()].map(finish).sort((a, b) => b.tokens.total - a.tokens.total),
    itemBuckets, totals, logged,
  };
}

/**
 * Seats that moved items in the window but left no session log on this machine (they run elsewhere, or under a
 * harness whose logs this ledger cannot read), so their minutes and tokens are missing rather than zero.
 *
 * @param {object[]} seatEvents
 * @param {Set<string>} logged
 * @param {number} since
 * @param {number} now
 * @returns {{ seat: string, events: number }[]}
 */
function unloggedSeats(seatEvents, logged, since, now) {
  const counts = new Map();
  for (const event of seatEvents) {
    if (event.at < since || event.at > now || !event.by || event.by === 'coordinator' || logged.has(event.by)) continue;
    counts.set(event.by, (counts.get(event.by) ?? 0) + 1);
  }
  return [...counts].map(([seat, events]) => ({ seat, events })).sort((a, b) => b.events - a.events);
}

/** Round to a number of decimals. */
function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * The whole ledger: every item that moved in the window, the per-hop table, compute per hop and runner, tokens per
 * role and model and per landing, the attribution audit, and, for one item, its timeline.
 *
 * @param {object} input
 * @param {number} input.since
 * @param {number} input.now
 * @param {number|null} [input.item] - one item's timeline
 * @param {object[]} input.events - pipeline events of the items in scope, oldest first ({ at, kind, state, by, item })
 * @param {object[]} input.seatEvents - every seat assignment event in the lookback, oldest first
 * @param {object[]} input.gateSpans
 * @param {object[]} input.landingSpans
 * @param {object[]} input.batches
 * @param {object[]} input.receipts
 * @param {{ segments: object[], buckets: object[] }} input.sessions
 * @param {{ id: string, path: string, lane?: string }[]} input.agents
 * @returns {object}
 */
export function pipelineLedger({ since, now, item = null, events, seatEvents = events, gateSpans = [], landingSpans = [], batches = [], receipts = [], sessions = { segments: [], buckets: [] }, agents = [] }) {
  const assignments = seatAssignments(seatEvents);
  const agentView = attributeAgents({ segments: sessions.segments, buckets: sessions.buckets, agents, assignments, since, now });
  const byItem = groupBy(events.filter(event => event.item !== null && event.item !== undefined), event => event.item);
  const spansByItem = groupBy(gateSpans.filter(span => Number.isSafeInteger(span.item)), span => span.item);
  const receiptsByItem = groupBy(receipts, receipt => receipt.item);
  const ledgers = [];
  for (const [id, list] of byItem) {
    if (item !== null && id !== item) continue;
    const mine = agentView.itemBuckets.get(id) ?? [];
    const tokensFor = (from, to) => {
      const tally = emptyTokens();
      for (const bucket of mine) if (bucket.t >= from && bucket.t < to) addTokens(tally, bucket);
      return tally;
    };
    const ledger = itemLedger({ item: id, events: list, gateSpans: spansByItem.get(id) ?? [], landingSpans, batches, receipts: receiptsByItem.get(id) ?? [], tokensFor, now });
    if (!ledger) continue;
    if (item === null && ledger.end < since) continue;
    const roleTokens = {};
    for (const bucket of mine) {
      if (bucket.t < ledger.start || bucket.t > ledger.end) continue;
      addTokens(roleTokens[bucket.role] ??= emptyTokens(), bucket);
    }
    ledger.tokensByRole = roleTokens;
    ledgers.push(ledger);
  }
  ledgers.sort((a, b) => a.start - b.start);
  return {
    version: LEDGER_VERSION, since: new Date(since).toISOString(), asOf: new Date(now).toISOString(), item,
    items: ledgers.length, merged: ledgers.filter(ledger => ledger.merged).length,
    hops: hopTable(ledgers),
    audit: auditOf(ledgers),
    compute: computeTable(ledgers, gateSpans, landingSpans, since, now, item),
    agents: { roles: agentView.roles, models: agentView.models, totals: agentView.totals, perLanding: perLanding(ledgers, agentView.totals),
      unlogged: unloggedSeats(seatEvents, agentView.logged, since, now) },
    ledgers: ledgers.map(ledger => item === null ? { ...ledger, segments: undefined } : ledger),
    timeline: item === null ? null : timelineOf(ledgers[0], events, spansByItem.get(item) ?? [], landingSpans, receiptsByItem.get(item) ?? []),
  };
}

/** Group values into a Map by key. */
function groupBy(values, key) {
  const map = new Map();
  for (const value of values) {
    const name = key(value);
    const list = map.get(name) ?? [];
    list.push(value);
    map.set(name, list);
  }
  return map;
}

/**
 * The per-hop table: per hop, how many items spent time in it, the p50 and p90 of that time per item, its sum and its
 * share of all items' claim-to-merged time.
 *
 * @param {object[]} ledgers
 * @returns {object[]}
 */
export function hopTable(ledgers) {
  const values = new Map();
  for (const ledger of ledgers) for (const [hop, ms] of Object.entries(ledger.hops)) {
    if (!values.has(hop)) values.set(hop, []);
    values.get(hop).push(ms);
  }
  const whole = ledgers.reduce((sum, ledger) => sum + ledger.totalMs, 0);
  const ends = ledgers.filter(ledger => ledger.merged).map(ledger => ledger.totalMs).sort((a, b) => a - b);
  const rows = [{ hop: 'end to end (claim to merged)', parent: null, count: ends.length, p50Ms: percentile(ends, 0.5), p90Ms: percentile(ends, 0.9), sumMs: ends.reduce((a, b) => a + b, 0), share: null }];
  const order = hop => {
    const parent = hop.includes('.') ? hop.slice(0, hop.indexOf('.')) : hop;
    const index = LEDGER_HOPS.indexOf(parent);
    return [index < 0 ? LEDGER_HOPS.length : index, hop.includes('.') ? 1 : 0];
  };
  const names = [...values.keys()].sort((a, b) => {
    const [ia, sa] = order(a), [ib, sb] = order(b);
    if (ia !== ib) return ia - ib;
    if (sa !== sb) return sa - sb;
    return values.get(b).reduce((x, y) => x + y, 0) - values.get(a).reduce((x, y) => x + y, 0);
  });
  for (const hop of names) {
    const list = values.get(hop).sort((a, b) => a - b);
    const sum = list.reduce((a, b) => a + b, 0);
    rows.push({ hop, parent: hop.includes('.') ? hop.slice(0, hop.indexOf('.')) : null, count: list.length, p50Ms: percentile(list, 0.5), p90Ms: percentile(list, 0.9), sumMs: sum, share: whole ? sum / whole : 0 });
  }
  return rows;
}

/**
 * The attribution audit: every item's claim-to-end time against the time its hops cover.
 *
 * @param {object[]} ledgers
 * @returns {{ totalMs: number, attributedMs: number, unattributedMs: number, unattributedShare: number, items: number[] }}
 */
export function auditOf(ledgers) {
  const totalMs = ledgers.reduce((sum, ledger) => sum + ledger.totalMs, 0);
  const attributedMs = ledgers.reduce((sum, ledger) => sum + ledger.attributedMs, 0);
  return { totalMs, attributedMs, unattributedMs: totalMs - attributedMs, unattributedShare: totalMs ? (totalMs - attributedMs) / totalMs : 0,
    items: ledgers.filter(ledger => ledger.unattributedMs !== 0).map(ledger => ledger.item) };
}

/**
 * Compute in the window: span seconds per gate phase and landing step (summed across concurrent spans, so it is
 * machine time, not wall time), per runner host, and proof-run time, files and shards per runner.
 *
 * @returns {object}
 */
function computeTable(ledgers, gateSpans, landingSpans, since, now, item) {
  const inWindow = span => Date.parse(span.end) >= since && Date.parse(span.start) <= now;
  const gates = gateSpans.filter(span => inWindow(span) && (item === null || span.item === item));
  const byHop = {}, byRunner = {};
  for (const span of gates) {
    byHop[`gate.${span.phase}`] = (byHop[`gate.${span.phase}`] ?? 0) + (span.ms ?? 0);
    const host = !span.host || span.host === 'local' ? 'coordinator' : span.host;
    const row = byRunner[host] ??= { runner: host, spanMs: 0, testMs: 0, shards: 0, files: 0 };
    row.spanMs += span.ms ?? 0;
  }
  let landingMs = 0;
  if (item === null) for (const span of landingSpans.filter(inWindow)) {
    byHop[`land.${span.phase}`] = (byHop[`land.${span.phase}`] ?? 0) + (span.ms ?? 0);
    landingMs += span.ms ?? 0;
  }
  for (const ledger of ledgers) for (const test of ledger.compute.tests) {
    const row = byRunner[test.runner] ??= { runner: test.runner, spanMs: 0, testMs: 0, shards: 0, files: 0 };
    row.testMs += test.ms; row.shards += test.shards; row.files += test.files;
  }
  return {
    byHop: Object.entries(byHop).map(([hop, ms]) => ({ hop, ms })).sort((a, b) => b.ms - a.ms),
    byRunner: Object.values(byRunner).sort((a, b) => b.spanMs + b.testMs - a.spanMs - a.testMs),
    coordinatorMs: (byRunner.coordinator?.spanMs ?? 0) + landingMs,
    testFiles: ledgers.reduce((sum, ledger) => sum + ledger.compute.testFiles, 0),
    shards: ledgers.reduce((sum, ledger) => sum + ledger.compute.shards, 0),
  };
}

/**
 * Tokens per landed item: what the merged items' own seats spent, and every session's tokens over the landings.
 *
 * @param {object[]} ledgers
 * @param {ReturnType<typeof emptyTokens>} totals
 * @returns {object}
 */
function perLanding(ledgers, totals) {
  const merged = ledgers.filter(ledger => ledger.merged);
  const own = merged.reduce((sum, ledger) => sum + ledger.tokens.total, 0);
  return { landed: merged.length, itemTokens: own, itemTokensPerLanding: merged.length ? Math.round(own / merged.length) : null,
    allTokensPerLanding: merged.length ? Math.round(totals.total / merged.length) : null };
}

/**
 * One item's timeline: its board events, gate spans, landing steps and proof runs in time order, beside the hop
 * segments that tile its cycle with the tokens spent in each.
 *
 * @returns {object|null}
 */
function timelineOf(ledger, events, gateSpans, landingSpans, receipts) {
  if (!ledger) return null;
  const inCycle = at => at >= ledger.start && at <= ledger.end;
  const entries = [];
  for (const event of events) if (event.item === ledger.item && inCycle(event.at)) entries.push({ at: event.at, type: 'event', text: event.kind + (event.state ? `:${event.state}` : ''), by: event.by ?? null });
  for (const span of gateSpans) if (inCycle(Date.parse(span.start))) entries.push({ at: Date.parse(span.start), type: 'gate', text: `gate.${span.phase}`, ms: span.ms, host: span.host ?? null, outcome: span.outcome ?? null, job: span.job });
  for (const span of landingSpans) if (Date.parse(span.start) >= ledger.start && Date.parse(span.end) <= ledger.end && ledger.segments.some(segment => segment.hop === `land.${span.phase}`)) {
    entries.push({ at: Date.parse(span.start), type: 'land', text: `land.${span.phase}`, ms: span.ms, outcome: span.outcome ?? null, job: span.job });
  }
  for (const receipt of receipts) if (inCycle(receipt.at)) entries.push({ at: receipt.at, type: 'proof', text: `proof-run ${receipt.kind ?? ''}`.trim(), ms: receipt.durationMs ?? 0, host: receipt.runner ?? null, files: receipt.files ?? 0 });
  entries.sort((a, b) => a.at - b.at);
  return { start: ledger.start, end: ledger.end, segments: ledger.segments, entries };
}

/** A short duration: 850ms, 42s, 3.4m or 2.1h. */
export function shortMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** A short token count: 950, 12k, 3.4M. */
export function shortTokens(count) {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** The biggest models of a token tally, as "model 1.2M, model 30k". */
function modelList(tally, limit = 3) {
  return Object.entries(tally.byModel).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([model, count]) => `${model} ${shortTokens(count)}`).join(', ');
}

/**
 * The ledger as text: the hop table, compute, tokens, the audit and, for one item, its timeline.
 *
 * @param {ReturnType<typeof pipelineLedger>} ledger
 * @param {string} window - the --since text, for the heading
 * @returns {string[]}
 */
export function ledgerLines(ledger, window) {
  const lines = [];
  const scope = ledger.item === null ? `last ${window}` : `item #${ledger.item}`;
  lines.push(`pipeline ledger, ${scope}: ${ledger.items} item(s) moved, ${ledger.merged} merged`);
  lines.push('');
  lines.push(`${'hop'.padEnd(34)} ${'n'.padStart(4)} ${'p50'.padStart(7)} ${'p90'.padStart(7)} ${'sum'.padStart(8)} ${'share'.padStart(6)}`);
  for (const row of ledger.hops) {
    const name = row.parent ? `  ${row.hop}` : row.hop;
    lines.push(`${name.slice(0, 34).padEnd(34)} ${String(row.count).padStart(4)} ${shortMs(row.p50Ms).padStart(7)} ${shortMs(row.p90Ms).padStart(7)} ${shortMs(row.sumMs).padStart(8)} ${row.share === null ? ''.padStart(6) : `${(row.share * 100).toFixed(1)}%`.padStart(6)}`);
  }
  const audit = ledger.audit;
  lines.push(`audit: ${shortMs(audit.attributedMs)} of ${shortMs(audit.totalMs)} claim-to-end time attributed to a hop; unattributed ${(audit.unattributedShare * 100).toFixed(2)}%`);
  lines.push('');
  lines.push('compute (machine time; concurrent spans add up):');
  for (const row of ledger.compute.byHop.slice(0, 12)) lines.push(`  ${row.hop.padEnd(28)} ${shortMs(row.ms).padStart(8)}`);
  lines.push('  per runner:');
  for (const row of ledger.compute.byRunner) lines.push(`  ${row.runner.slice(0, 28).padEnd(28)} spans ${shortMs(row.spanMs).padStart(7)}  tests ${shortMs(row.testMs).padStart(7)}  ${row.shards} shard(s), ${row.files} file(s)`);
  lines.push(`  coordinator ${shortMs(ledger.compute.coordinatorMs)}; ${ledger.compute.shards} proof run(s), ${ledger.compute.testFiles} test file(s)`);
  lines.push('');
  lines.push('agents (minutes: thinking / commands / waiting / idle; tokens):');
  for (const row of ledger.agents.roles) {
    const m = row.minutes;
    lines.push(`  ${row.role.padEnd(12)} ${row.model.slice(0, 22).padEnd(22)} ${String(row.seats).padStart(3)} seat(s)  ${m.thinking.toFixed(0)}/${m.commands.toFixed(0)}/${m.waiting.toFixed(0)}/${m.idle.toFixed(0)}m  ${shortTokens(row.tokens.total).padStart(6)} (out ${shortTokens(row.tokens.output)}, cache read ${shortTokens(row.tokens.cacheRead)})`);
  }
  const landing = ledger.agents.perLanding;
  lines.push(`  all sessions ${shortTokens(ledger.agents.totals.total)} tokens${landing.landed ? `; per landing: ${shortTokens(landing.itemTokensPerLanding)} on the item's own seats, ${shortTokens(landing.allTokensPerLanding)} counting every session` : '; no landings in the window'}`);
  const unlogged = ledger.agents.unlogged;
  if (unlogged.length) lines.push(`  no session log on this machine for ${unlogged.length} seat(s) that moved items: ${unlogged.slice(0, 8).map(row => row.seat).join(', ')}${unlogged.length > 8 ? ', …' : ''}; their minutes and tokens are missing, not zero`);
  if (ledger.timeline) {
    const timeline = ledger.timeline;
    const one = ledger.ledgers[0];
    lines.push('');
    lines.push(`#${ledger.item} ${one.merged ? 'merged' : one.open ? 'still open' : 'closed'} after ${shortMs(one.totalMs)}; ${one.gateAttempts} gate attempt(s), ${one.submits} submit(s); tokens ${shortTokens(one.tokens.total)}${one.tokens.total ? ` (${modelList(one.tokens)})` : ''}`);
    lines.push('hops:');
    for (const segment of timeline.segments) {
      const offset = (segment.start - timeline.start) / 60_000;
      lines.push(`  ${offset.toFixed(1).padStart(7)}m  ${(segment.parent ? `  ${segment.hop}` : segment.hop).padEnd(30)} ${shortMs(segment.ms).padStart(7)}${segment.tokens.total ? `  ${shortTokens(segment.tokens.total)} tokens (${modelList(segment.tokens, 2)})` : ''}`);
    }
    lines.push('events and spans:');
    let previous = timeline.start;
    for (const entry of timeline.entries) {
      const detail = [entry.ms !== undefined ? shortMs(entry.ms) : null, entry.host, entry.outcome && entry.outcome !== 'ok' ? entry.outcome : null, entry.files ? `${entry.files} file(s)` : null, entry.by].filter(Boolean).join(' ');
      lines.push(`  ${((entry.at - timeline.start) / 60_000).toFixed(1).padStart(7)}m (+${shortMs(Math.max(0, entry.at - previous)).padStart(6)}) ${entry.type === 'event' ? '' : '  '}${entry.text}${detail ? `  ${detail}` : ''}`);
      previous = entry.at;
    }
  }
  return lines;
}
