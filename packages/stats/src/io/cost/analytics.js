/** Private server-side cost cohorts from native board events [N26]. */
import { Refused } from '../../../../kernel/index.js';

/** Wilson's two-sided 95% score interval for a binomial proportion. */
export function wilson(successes, total) {
  if (!total) return { low: null, high: null };
  const z = 1.959963984540054, p = successes / total, z2 = z * z;
  const center = (p + z2 / (2 * total)) / (1 + z2 / total);
  const radius = z * Math.sqrt(p * (1 - p) / total + z2 / (4 * total * total)) / (1 + z2 / total);
  return { low: Math.max(0, center - radius), high: Math.min(1, center + radius) };
}

/** Rank only adequately sized cohorts by their observed success rate. */
function comparison(rows) {
  const judged = rows.filter(row => row.judged).sort((a, b) => b.rate - a.rate || a.model.localeCompare(b.model));
  const [best, runner] = judged;
  return { verdict: !runner ? 'nothing-to-compare' : best.low > runner.high ? 'clear' : 'leaning', best: best?.model ?? null, runnerUp: runner?.model ?? null, rows };
}

/** Unknown observations do not silently become zero. */
function sum(values) {
  return values.every(Number.isSafeInteger) ? values.reduce((a, b) => a + b, 0) : null;
}
/** Total the observed durations; items with no recorded session time are left out, never counted as zero. */
function knownSum(values) {
  const known = values.filter(Number.isSafeInteger);
  return known.length ? known.reduce((a, b) => a + b, 0) : values.length ? null : 0;
}
function median(values) {
  const sorted = values.filter(Number.isSafeInteger).sort((a, b) => a - b);
  const n = sorted.length;
  return n ? Math.round((sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2) : null;
}
/** A landing or review move needs no parse here: its item is its own column, and only its model is read, later, when named. */
const NO_DETAIL = Object.freeze({});
function detail(event) {
  try { return JSON.parse(event.event_detail); } catch { return {}; }
}
function dateInZone(at, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
/** Start of a calendar date in the board time zone, including daylight-saving offsets. */
function midnight(date, timeZone) {
  const [year, month, day] = date.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(part => [part.type, part.value]));
    const represented = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    guess += target - represented;
  }
  return guess;
}

/** Start of a cost window in the board time zone, so a reader can fetch only the events from then on. */
export function costWindowStart(window, now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if (!['today', '7d', '30d'].includes(window)) throw new Refused('BAD_REQUEST', 'window must be today, 7d or 30d');
  const today = dateInZone(new Date(now), timeZone), daysBack = window === 'today' ? 0 : window === '7d' ? 6 : 29;
  const date = new Date(today + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() - daysBack);
  return new Date(midnight(date.toISOString().slice(0, 10), timeZone));
}

/** Project a selected landing cohort; model presentation is supplied by the shared native naming provider. */
function* projectCost({ items, agents, events, window = '30d', now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, modelPresentation }) {
  if (!['today', '7d', '30d'].includes(window)) throw new Refused('BAD_REQUEST', 'window must be today, 7d or 30d');
  if (typeof modelPresentation !== 'function') throw new TypeError('cost analytics requires the native model presentation provider');
  const to = new Date(now), from = costWindowStart(window, to, timeZone);
  const ordered = [...events].sort((a, b) => a.event_id - b.event_id), histories = new Map(), latest = new Map(), latestByItem = new Map(), modelChanges = new Map(), shared = new Set();
  let seen = 0;
  for (const event of ordered) {
    if (++seen % 2000 === 0) yield;
    const info = event.item_id !== null && event.item_id !== undefined && !['usage', 'shared-usage'].includes(event.event_kind) ? NO_DETAIL : detail(event), id = event.item_id ?? info.item;
    if (id) { if (!histories.has(id)) histories.set(id, []); histories.get(id).push(event); }
    if (event.event_kind === 'usage') {
      if (info.shared) shared.add(info.item);
      const key = `${info.item}:${event.event_by}`, prior = latest.get(key);
      if (!prior || info.revision > prior.revision) {
        const value = { ...info, agent: event.event_by };
        latest.set(key, value);
        if (!latestByItem.has(info.item)) latestByItem.set(info.item, new Map());
        latestByItem.get(info.item).set(event.event_by, value);
      }
    }
    if (event.event_kind === 'model') { if (!modelChanges.has(event.event_by)) modelChanges.set(event.event_by, []); modelChanges.get(event.event_by).push(event); }
    if (event.event_kind === 'shared-usage') for (const allocation of info.allocations ?? []) shared.add(allocation.item);
  }
  const seats = new Map(agents.map(agent => [agent.agent_id ?? agent.id, agent]));
  const named = (actor, target) => {
    const seat = seats.get(actor), eventId = target?.event_id ?? Infinity;
    const recorded = target && detail(target).model;
    if (typeof recorded === 'string') return recorded.toLowerCase() === 'unknown' ? null : modelPresentation(recorded, seat?.family ?? seat?.agent_family);
    const changes = modelChanges.get(actor) ?? [];
    const prior = changes.filter(event => event.event_id <= eventId).at(-1);
    // A later model change makes the original unrecorded join model unknowable.
    const model = prior ? detail(prior).model : changes.length ? null : seat?.model ?? seat?.agent_model;
    return model && model.toLowerCase() !== 'unknown' ? modelPresentation(model, seat?.family ?? seat?.agent_family) : null;
  };
  const projected = [];
  let rows = 0;
  for (const item of items) {
    if (++rows % 200 === 0) yield;
    const id = item.item_id ?? item.id, history = histories.get(id) ?? [];
    const landing = [...history].reverse().find(event => event.event_kind === 'merged');
    const at = Date.parse(landing?.event_at);
    if (!Number.isFinite(at) || at < from.getTime() || at > to.getTime()) continue;
    const returns = history.filter(event => ['reject', 'reopen'].includes(event.event_kind) && event.event_id < landing.event_id);
    const firstSubmit = history.find(event => event.event_kind === 'submit');
    const builder = named(firstSubmit?.event_by, firstSubmit);
    const accepts = history.filter(event => event.event_kind === 'accept' && event.event_id < landing.event_id);
    const verifier = named(accepts.at(-1)?.event_by, accepts.at(-1));
    const allocations = [...(latestByItem.get(id)?.values() ?? [])];
    const grouped = new Map();
    for (const allocation of allocations) for (const row of allocation.records ?? []) {
      const label = modelPresentation(row.model), entry = grouped.get(label.key) ?? { model: label.key, label: label.name, count: null, agentMs: 0, tokensIn: 0 };
      entry.count = (entry.count ?? 0) + 1; entry.agentMs = sum([entry.agentMs, row.wallMs]); entry.tokensIn = sum([entry.tokensIn, row.inputTokens]); grouped.set(label.key, entry);
    }
    const sessions = [...grouped.values()];
    const agentMs = shared.has(id) || !sessions.length ? null : sum(sessions.map(row => row.agentMs));
    projected.push({ id, title: item.item_title ?? item.title, lane: item.item_lane ?? item.lane ?? null, landedAt: landing.event_at, date: dateInZone(new Date(at), timeZone), agentMs,
      sentBack: returns.length, builder, verifier, accepts, history, sessions: shared.has(id) ? [] : sessions });
  }
  const totalMs = projected.length ? knownSum(projected.map(row => row.agentMs)) : 0;
  const sent = projected.filter(row => row.sentBack), sentMs = sent.length ? knownSum(sent.map(row => row.agentMs)) : 0;
  const days = [...new Set(projected.map(row => row.date))].sort().map(day => {
    const rows = projected.filter(row => row.date === day), first = rows.filter(row => !row.sentBack), returned = rows.filter(row => row.sentBack);
    return { date: day, firstTimeMs: first.length ? knownSum(first.map(row => row.agentMs)) : 0, sentBackMs: returned.length ? knownSum(returned.map(row => row.agentMs)) : 0, items: rows.length,
      timedItems: rows.filter(row => row.agentMs !== null).length, untimedItems: rows.filter(row => row.agentMs === null).length };
  });
  /** Agent time per model and per lane: hours, share of the total and the part sent back [N26]. */
  const spread = (entries) => [...entries.values()].filter(row => row.agentMs > 0).sort((x, y) => y.agentMs - x.agentMs || String(x.key).localeCompare(String(y.key)))
    .map(row => ({ ...row, share: totalMs > 0 ? row.agentMs / totalMs : null, sentBackShare: row.agentMs > 0 ? row.sentBackMs / row.agentMs : null }));
  const byModel = new Map(), byLane = new Map();
  for (const row of projected) {
    if (row.agentMs === null) continue;
    for (const session of row.sessions) {
      const entry = byModel.get(session.model) ?? { key: session.model, label: session.label, agentMs: 0, sentBackMs: 0, items: 0 };
      entry.agentMs += session.agentMs ?? 0; entry.items++; if (row.sentBack) entry.sentBackMs += session.agentMs ?? 0; byModel.set(session.model, entry);
    }
    const lane = row.lane ?? 'unassigned', entry = byLane.get(lane) ?? { key: lane, label: lane, agentMs: 0, sentBackMs: 0, items: 0 };
    entry.agentMs += row.agentMs; entry.items++; if (row.sentBack) entry.sentBackMs += row.agentMs; byLane.set(lane, entry);
  }
  const builders = new Map(), verifiers = new Map();
  for (const row of projected) {
    if (row.builder) { const b = builders.get(row.builder.key) ?? { model: row.builder.key, label: row.builder.name, vendor: row.builder.vendor, built: 0, passedFirst: 0, times: [] }; b.built++; if (!row.sentBack) b.passedFirst++; b.times.push(row.agentMs); builders.set(b.model, b); }
    for (const event of row.history.filter(event => ['accept', 'reject'].includes(event.event_kind))) {
      const person = named(event.event_by, event); if (!person) continue;
      const v = verifiers.get(person.key) ?? { model: person.key, label: person.name, vendor: person.vendor, verdicts: 0, accepts: 0, reopenedLater: 0 };
      v.verdicts++; if (event.event_kind === 'accept') { v.accepts++; if (row.history.some(later => later.event_kind === 'reopen' && later.event_id > event.event_id)) v.reopenedLater++; } verifiers.set(v.model, v);
    }
  }
  const builderRows = [...builders.values()].map(({ times, ...row }) => ({ ...row, rate: row.passedFirst / row.built, ...(row.built < 5 ? { low: null, high: null } : wilson(row.passedFirst, row.built)), typicalItemMs: median(times), judged: row.built >= 30, tooFew: row.built < 5 }));
  const verifierRows = [...verifiers.values()].map(row => ({ ...row, rate: row.accepts ? (row.accepts - row.reopenedLater) / row.accepts : null, ...(row.accepts < 5 ? { low: null, high: null } : wilson(row.accepts - row.reopenedLater, row.accepts)), judged: row.accepts >= 30, tooFew: row.accepts < 5 }));
  const longest = [...projected].filter(row => row.agentMs !== null).sort((a, b) => b.agentMs - a.agentMs || a.id - b.id).slice(0, 10).map(row => ({ id: row.id, title: row.title, agentMs: row.agentMs, sentBack: row.sentBack, verifiedBy: row.verifier?.name ?? null, landedAt: row.landedAt, sessions: row.sessions }));
  return { version: 1, window, from: from.toISOString(), to: to.toISOString(), totals: { agentMs: totalMs, itemCount: projected.length, medianItemMs: median(projected.map(row => row.agentMs)), sentBack: { items: sent.length, itemShare: projected.length ? sent.length / projected.length : 0, agentMs: sentMs, agentMsShare: totalMs > 0 && sentMs !== null ? sentMs / totalMs : totalMs === 0 ? 0 : null } }, days, byModel: spread(byModel), byLane: spread(byLane), builders: comparison(builderRows), verifiers: comparison(verifierRows), unknownBuilderModelShare: projected.length ? projected.filter(row => !row.builder).length / projected.length : 0, longest, allItems: projected.length };
}

/** Project a selected landing cohort in one go. */
export function costAnalytics(input) {
  const run = projectCost(input);
  for (let step = run.next(); ; step = run.next()) if (step.done) return step.value;
}

/** The same projection, giving the event loop a turn every few milliseconds so other requests keep answering [6663]. */
export async function costAnalyticsSliced(input, turn, sliceMs = 15) {
  const run = projectCost(input);
  let started = performance.now();
  for (let step = run.next(); ; step = run.next()) {
    if (step.done) return step.value;
    if (performance.now() - started >= sliceMs) { await turn(); started = performance.now(); }
  }
}
