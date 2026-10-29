/** Private Cost-tab selection and rendering for the local board view [N26]. */

/** Decode one event detail without letting malformed legacy JSON break the view. */
function detailOf(event) {
  if (event?.detail && typeof event.detail === 'object') return event.detail;
  if (typeof event?.event_detail !== 'string') return {};
  try { return JSON.parse(event.event_detail); } catch { return {}; }
}

/** Return a native event's actor, accepting both API and presenter-shaped inputs. */
function actorOf(event) {
  return event.event_by ?? event.by ?? '';
}

/** Return the native event kind, accepting both API and presenter-shaped inputs. */
function kindOf(event) {
  return event.event_kind ?? event.kind ?? '';
}

/** Format unavailable or incomplete dollar attribution as a dash, never as a fabricated zero. */
export function costFigure(value) {
  return Number.isFinite(value) && value >= 0 ? '$' + value.toFixed(2) : '—';
}

/** Format one time value using the browser's locale while keeping its native timestamp in the markup. */
function dateLabel(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date) : 'Date unknown';
}

/** Escape every native title, name, model and timestamp before it enters the generated page. */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

/** Sum only complete, nonnegative dollar values; incomplete totals stay unknown. */
function completeSum(values) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  return Number.isFinite(sum) ? sum : null;
}

/** Return the middle of the sorted complete cost observations, averaging the two middle rows. */
function median(values) {
  const sorted = values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Determine whether an agent's usage checkpoint follows a first build or returned work. */
function usageRole(itemEvents, agent, checkpointId) {
  let role = 'build';
  let returned = false;
  for (const event of itemEvents) {
    if (event.event_id > checkpointId) break;
    const kind = kindOf(event);
    if (kind === 'reject' || kind === 'reopen') returned = true;
    if (kind === 'accept' || kind === 'reject') {
      if (actorOf(event) === agent) role = 'review';
    }
    if (kind === 'claim' && actorOf(event) === agent) role = returned ? 'rework' : 'build';
    if (kind === 'submit' && actorOf(event) === agent) role = returned ? 'rework' : 'build';
  }
  return role;
}

/** Return a cumulative counter's attributable delta, keeping resets and unknowns visibly unknown. */
function counterDelta(current, previous, field) {
  const value = current?.[field];
  if (!Number.isSafeInteger(value) || value < 0) return null;
  if (!previous || !Object.hasOwn(previous, field)) return value;
  const prior = previous[field];
  return Number.isSafeInteger(prior) && prior >= 0 && value >= prior ? value - prior : null;
}

/** Recover per-revision agent/model deltas instead of assigning cumulative totals to the latest phase. */
function usageByItem(events) {
  const snapshots = new Map(), deltas = [];
  for (const event of [...(events ?? [])].sort((a, b) => Number(a.event_id ?? 0) - Number(b.event_id ?? 0))) {
    if (kindOf(event) !== 'usage') continue;
    const detail = detailOf(event), item = Number(detail.item), agent = actorOf(event), revision = Number(detail.revision ?? 0);
    if (!Number.isSafeInteger(item) || item < 1 || !agent || !Number.isSafeInteger(revision) || revision < 1 || !Array.isArray(detail.records)) continue;
    const key = item + ':' + agent, prior = snapshots.get(key);
    if (prior && revision <= prior.revision) continue;
    const records = new Map();
    for (const record of detail.records) {
      if (!record || typeof record.model !== 'string' || !record.model.trim()) continue;
      const old = prior?.records.get(record.model);
      const fields = ['freshInputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens', 'inputTokens', 'outputTokens', 'wallMs', 'knownInputTokens', 'knownOutputTokens'];
      const delta = Object.fromEntries(fields.map(field => [field, counterDelta(record, old, field)]));
      deltas.push({ item, agent, revision, eventId: Number(event.event_id ?? 0), model: record.model, ...delta });
      records.set(record.model, record);
    }
    snapshots.set(key, { revision, records });
  }
  return deltas;
}

/** Identify items whose native usage was shared across seats and cannot be split per landing. */
function sharedUsageItems(events) {
  const items = new Set();
  for (const event of events ?? []) {
    if (kindOf(event) !== 'shared-usage') continue;
    for (const allocation of detailOf(event).allocations ?? []) {
      if (Number.isSafeInteger(allocation?.item) && allocation.item > 0) items.add(allocation.item);
    }
  }
  return items;
}

/** Price a split record only when all required counters and normalized per-million rates exist. */
function recordCost(record, prices) {
  const rate = prices?.[record.model];
  const fields = ['freshInputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens', 'outputTokens'];
  const rates = ['freshInput', 'cacheReadInput', 'cacheWriteInput', 'output'];
  if (!rate || fields.some(field => !Number.isSafeInteger(record[field]) || record[field] < 0)
    || rates.some(field => !Number.isFinite(rate[field]) || rate[field] < 0)) return null;
  return fields.reduce((total, field, index) => total + record[field] * rate[rates[index]] / 1_000_000, 0);
}

/**
 * Prepare the last twenty landed items and their private usage details from the authenticated local view API.
 * Rates are an optional normalized model table; without one, every dollar figure remains a dash.
 */
export function costTabModel(project, events, prices = null) {
  const items = new Map((project?.items ?? []).map(item => [Number(item.id), item]));
  const agents = new Map((project?.agents ?? []).map(agent => [agent.agent_id ?? agent.id, agent]));
  const itemEvents = new Map();
  const landings = new Map();
  for (const event of [...(events ?? [])].sort((a, b) => Number(a.event_id ?? 0) - Number(b.event_id ?? 0))) {
    const id = Number(event.item_id ?? detailOf(event).item);
    if (!Number.isSafeInteger(id) || id < 1) continue;
    if (!itemEvents.has(id)) itemEvents.set(id, []);
    itemEvents.get(id).push(event);
    if (kindOf(event) === 'merged') landings.set(id, event);
  }
  const usage = usageByItem(events ?? []), sharedItems = sharedUsageItems(events ?? []);
  const rows = [...landings].map(([id, event]) => {
    const item = items.get(id) ?? {};
    const history = itemEvents.get(id) ?? [];
    const checkpoints = usage.filter(entry => entry.item === id).map(entry => {
      const owner = agents.get(entry.agent) ?? {};
      return { ...entry, vendor: owner.family ?? owner.agent_family ?? owner.vendor ?? 'Vendor unknown', role: usageRole(history, entry.agent, entry.eventId), costUSD: recordCost(entry, prices) };
    });
    const aggregates = new Map();
    for (const checkpoint of checkpoints) {
      const key = [checkpoint.agent, checkpoint.model, checkpoint.vendor, checkpoint.role].join(':');
      const old = aggregates.get(key);
      if (!old) aggregates.set(key, { ...checkpoint });
      else {
        for (const field of ['freshInputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'wallMs']) {
          old[field] = Number.isSafeInteger(old[field]) && Number.isSafeInteger(checkpoint[field]) ? old[field] + checkpoint[field] : null;
        }
        old.costUSD = Number.isFinite(old.costUSD) && Number.isFinite(checkpoint.costUSD) ? old.costUSD + checkpoint.costUSD : null;
        old.eventId = Math.min(old.eventId, checkpoint.eventId);
      }
    }
    const sessions = [...aggregates.values()];
    const submits = history.filter(row => kindOf(row) === 'submit').length;
    const reviewActors = [...new Set(history.filter(row => ['accept', 'reject'].includes(kindOf(row))).map(actorOf).filter(Boolean))];
    const buildAgent = item.builtBy ?? item.built_by ?? item.builder;
    const buildModel = agents.get(buildAgent)?.model ?? agents.get(buildAgent)?.agent_model;
    const buildModels = [...new Set([
      ...sessions.filter(row => row.role !== 'review').map(row => row.model),
      ...(typeof buildModel === 'string' && buildModel.trim() && buildModel.toLowerCase() !== 'unknown' ? [buildModel] : []),
    ])];
    const reviewedModels = [...new Set(reviewActors.map(id => agents.get(id)?.model ?? agents.get(id)?.agent_model).filter(value => typeof value === 'string' && value.trim()))];
    const costs = sessions.map(row => row.costUSD);
    const totalCost = sessions.length ? completeSum(costs) : null;
    const wall = sessions.map(row => row.wallMs);
    const totalWallMs = sessions.length && wall.every(value => Number.isSafeInteger(value)) ? wall.reduce((sum, value) => sum + value, 0) : null;
    const sharedUsage = sharedItems.has(id);
    const returnEvents = history.filter(row => ['reject', 'reopen'].includes(kindOf(row)));
    const returns = returnEvents.map((row, index) => {
      const after = Number(row.event_id ?? 0), before = Number(returnEvents[index + 1]?.event_id ?? Infinity);
      const reworkCosts = checkpoints.filter(entry => entry.role === 'rework' && entry.eventId > after && entry.eventId < before).map(entry => entry.costUSD);
      return { kind: kindOf(row), at: row.event_at ?? row.at, costUSD: reworkCosts.length ? completeSum(reworkCosts) : totalCost !== null && !sharedUsage ? 0 : null };
    });
    return { id, title: item.title ?? `Item ${id}`, landedAt: event.event_at ?? event.at ?? '', buildModels, reviewedModels,
      agentHours: totalWallMs === null ? null : totalWallMs / 3_600_000, rounds: submits, sessions, returns, totalCost: sharedUsage ? null : totalCost, sharedUsage };
  }).sort((a, b) => String(b.landedAt).localeCompare(String(a.landedAt)) || b.id - a.id).slice(0, 20);
  const knownCosts = rows.map(row => row.totalCost);
  const total = rows.length ? completeSum(knownCosts) : null;
  const middle = median(knownCosts);
  const rework = rows.flatMap(row => row.sessions.filter(session => session.role === 'rework').map(session => session.costUSD));
  const reworkCost = rework.length ? completeSum(rework) : total !== null ? 0 : null;
  const reworkShare = total !== null && total > 0 && reworkCost !== null ? reworkCost / total : null;
  const vendors = [...new Set(rows.flatMap(row => row.sessions.map(session => session.vendor)))].sort().map(vendor => ({
    vendor,
    costUSD: completeSum(rows.flatMap(row => row.sessions.filter(session => session.vendor === vendor).map(session => session.costUSD))),
  }));
  return { rows, total, perLanding: rows.length && total !== null ? total / rows.length : null, median: middle, reworkShare, vendors };
}

/** Render a single session's split token amounts and unknown dollar cost. */
function sessionHtml(session) {
  const token = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : '—';
  return '<div class="cost-session"><span class="cost-session-model"><b>' + escapeHtml(session.model) + '</b><small>' + escapeHtml(session.agent) + ' · ' + escapeHtml(session.role) + '</small></span>'
    + '<span><small>Fresh input</small><b>' + token(session.freshInputTokens) + '</b></span>'
    + '<span><small>Cached input</small><b>' + token(session.cacheReadInputTokens) + '</b></span>'
    + '<span><small>Cached write</small><b>' + token(session.cacheWriteInputTokens) + '</b></span>'
    + '<span><small>Output</small><b>' + token(session.outputTokens) + '</b></span>'
    + '<span><small>Cost</small><b>' + costFigure(session.costUSD) + '</b></span></div>';
}

/** Render the private Cost pane using the same compact row and expanded detail rhythm as Roadmap. */
export function costTabHtml(model, opened = null, { loading = false, error = null } = {}) {
  if (loading) return '<section class="cost-page" aria-label="Cost"><p class="empty" role="status">Loading cost history…</p></section>';
  if (error) return '<section class="cost-page" aria-label="Cost"><p class="empty" role="status">Cost history is unavailable. ' + escapeHtml(error) + '</p></section>';
  const rows = model?.rows ?? [];
  const vendors = model?.vendors?.length ? model.vendors.map(row => '<span><b>' + escapeHtml(row.vendor) + '</b> ' + costFigure(row.costUSD) + '</span>').join('') : '<span>—</span>';
  const tiles = '<div class="cost-tiles"><article><span>Last 20 landings</span><b>' + (rows.length ? costFigure(model.total) : '—') + '</b></article>'
    + '<article><span>Cost per landing · median</span><b>' + (rows.length ? costFigure(model.perLanding) : '—') + '</b><small>Median ' + costFigure(model.median) + '</small></article>'
    + '<article><span>Rework share</span><b>' + (Number.isFinite(model?.reworkShare) ? (100 * model.reworkShare).toFixed(1) + '%' : '—') + '</b></article>'
    + '<article><span>By vendor</span><div class="cost-vendors">' + vendors + '</div></article></div>';
  const cards = rows.length ? rows.map(row => {
    const expanded = opened === row.id;
    const models = [...new Set([...row.buildModels, ...row.reviewedModels])];
    const title = models.length ? models.join(' · ') : '—';
    const color = Number.isFinite(row.totalCost) && Number.isFinite(model.median)
      ? row.totalCost > model.median * 2 ? ' cost-red' : row.totalCost > model.median ? ' cost-amber' : '' : '';
    const time = row.landedAt ? '<time datetime="' + escapeHtml(row.landedAt) + '">' + escapeHtml(dateLabel(row.landedAt)) + '</time>' : '<span>—</span>';
    const summary = '<button class="cost-row' + color + '" type="button" data-cost-row="' + row.id + '" aria-expanded="' + expanded + '" aria-controls="cost-detail-' + row.id + '">'
      + '<span class="cost-date" data-label="Landed">' + time + '</span><b class="cost-id">#' + row.id + '</b><span class="cost-title" title="' + escapeHtml(row.title) + '">' + escapeHtml(row.title) + '</span>'
      + '<span class="cost-models" data-label="Models">' + escapeHtml(title) + '</span><span class="cost-hours" data-label="Agent-hours">' + (Number.isFinite(row.agentHours) ? row.agentHours.toFixed(1) + ' h' : '—') + '</span>'
      + '<span class="cost-rounds" data-label="Rounds">' + row.rounds + '</span><b class="cost-amount" data-label="Cost">' + costFigure(row.totalCost) + '</b></button>';
    if (!expanded) return summary;
    const sessions = row.sessions.length ? row.sessions.map(sessionHtml).join('') : '<p class="cost-unknown">' + (row.sharedUsage
      ? 'Shared usage is not attributable to this item; token and cost figures are unavailable.'
      : 'No usage record; token and cost figures are unavailable.') + '</p>';
    const returns = row.returns.length ? '<section class="cost-returns"><h3>Rejects and reopens</h3><ul>' + row.returns.map(entry => '<li><span>' + escapeHtml(entry.kind === 'reject' ? 'Rejected' : 'Reopened') + ' · ' + escapeHtml(dateLabel(entry.at)) + '</span><b>' + costFigure(entry.costUSD) + '</b></li>').join('') + '</ul></section>' : '';
    const shared = row.sharedUsage ? '<p class="cost-unknown">Shared session usage is not split across its items.</p>' : '';
    return summary + '<div class="cost-detail" id="cost-detail-' + row.id + '"><h3>Usage detail</h3>' + shared + sessions + returns + '</div>';
  }).join('') : '<p class="empty">No landed items yet.</p>';
  return '<section class="cost-page" aria-label="Cost"><header class="cost-heading"><div><h1>Cost</h1><p>The last 20 landed items</p></div><span class="cost-private">Private to this view</span></header>'
    + tiles + '<section class="cost-list card-panel" aria-label="Landed items">' + cards + '</section></section>';
}

/** Embed this module's closure-free Cost functions into the standalone local-view page. */
export function costTabScript() {
  const functions = [detailOf, actorOf, kindOf, costFigure, dateLabel, escapeHtml, completeSum, median,
    usageRole, counterDelta, usageByItem, sharedUsageItems, recordCost, costTabModel, sessionHtml, costTabHtml];
  return functions.map((fn) => `const ${fn.name} = (${fn.toString()});`).join('\n');
}
