/** Private Cost-tab selection and rendering for the local board view [N26]. */
import { costOverviewHtml } from "./overview.js";
import { bindCostOverview } from "./overview.js";

import { modelPresentation } from "../presentation.js";
export { modelPresentation } from "../presentation.js";

/** Decode one event detail without letting malformed legacy JSON break the view. */
function costEventDetail(event) {
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

/** A first published cumulative snapshot cannot split this agent's earlier phases or returned work. */
function firstSamplePhaseKnown(itemEvents, agent, checkpointId) {
  const history = itemEvents.filter(event => Number(event.event_id ?? 0) <= checkpointId);
  if (history.some(event => ['reject', 'reopen'].includes(kindOf(event)))) return false;
  const ownPhaseEvents = history.filter(event => actorOf(event) === agent && ['claim', 'submit', 'accept', 'reject'].includes(kindOf(event)));
  return new Set(ownPhaseEvents.map(event => usageRole(history, agent, Number(event.event_id ?? 0)))).size <= 1;
}

/** Return a cumulative counter's attributable delta, keeping resets and unknowns visibly unknown. */
export function counterDelta(current, previous, field) {
  const value = current?.[field];
  if (!Number.isSafeInteger(value) || value < 0) return null;
  if (!previous) return value;
  if (!Object.hasOwn(previous, field)) return null;
  const prior = previous[field];
  return Number.isSafeInteger(prior) && prior >= 0 && value >= prior ? value - prior : null;
}

/** Recover per-revision agent/model deltas instead of assigning cumulative totals to the latest phase. */
function usageByItem(events) {
  const snapshots = new Map(), deltas = [];
  const ordered = [...(events ?? [])].sort((a, b) => Number(a.event_id ?? 0) - Number(b.event_id ?? 0));
  const itemHistories = new Map();
  for (const row of ordered) {
    const id = Number(row.item_id ?? costEventDetail(row).item);
    if (!Number.isSafeInteger(id) || id < 1) continue;
    if (!itemHistories.has(id)) itemHistories.set(id, []);
    itemHistories.get(id).push(row);
  }
  for (const event of ordered) {
    if (kindOf(event) !== 'usage') continue;
    const detail = costEventDetail(event), item = Number(detail.item), agent = actorOf(event), revision = Number(detail.revision ?? 0);
    if (!Number.isSafeInteger(item) || item < 1 || !agent || !Number.isSafeInteger(revision) || revision < 1 || !Array.isArray(detail.records)) continue;
    const key = item + ':' + agent, prior = snapshots.get(key);
    const history = itemHistories.get(item) ?? [];
    const itemHistory = history.filter(row => Number(row.event_id ?? 0) > (prior?.eventId ?? 0) && Number(row.event_id ?? 0) < Number(event.event_id ?? 0));
    const phaseChanged = Boolean(prior && itemHistory.some(row => ['claim', 'submit', 'release', 'reject', 'reopen', 'accept'].includes(kindOf(row))));
    const firstSampleAmbiguous = !prior && !firstSamplePhaseKnown(history, agent, Number(event.event_id ?? 0));
    const revisionGap = Boolean(prior && revision > prior.revision + 1);
    const phaseKnown = !phaseChanged && !firstSampleAmbiguous && !revisionGap;
    if (prior && revision <= prior.revision) continue;
    const fields = ['freshInputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens', 'inputTokens', 'outputTokens', 'wallMs', 'knownInputTokens', 'knownOutputTokens'];
    const records = new Map();
    for (const record of detail.records) {
      if (!record || typeof record.model !== 'string' || !record.model.trim()) continue;
      const modelKey = modelPresentation(record.model).key, same = records.get(modelKey);
      if (!same) records.set(modelKey, { ...record });
      else for (const field of fields) {
        const total = Number.isSafeInteger(same[field]) && same[field] >= 0 && Number.isSafeInteger(record[field]) && record[field] >= 0 ? same[field] + record[field] : null;
        same[field] = Number.isSafeInteger(total) ? total : null;
      }
    }
    for (const [modelKey, record] of records) {
      const old = prior?.records.get(modelKey);
      const delta = Object.fromEntries(fields.map(field => [field, counterDelta(record, old, field)]));
      deltas.push({ item, agent, revision, eventId: Number(event.event_id ?? 0), model: record.model, phaseKnown, ...delta });
    }
    snapshots.set(key, { revision, records, eventId: Number(event.event_id ?? 0) });
  }
  return deltas;
}

/** Identify items whose native usage was shared across seats and cannot be split per landing. */
function sharedUsageItems(events) {
  const items = new Set();
  for (const event of events ?? []) {
    const detail = costEventDetail(event);
    if (kindOf(event) === 'usage' && detail.shared === true) {
      const item = Number(detail.item);
      if (Number.isSafeInteger(item) && item > 0) items.add(item);
    }
    if (kindOf(event) === 'shared-usage') {
      for (const allocation of detail.allocations ?? []) {
        if (Number.isSafeInteger(allocation?.item) && allocation.item > 0) items.add(allocation.item);
      }
    }
  }
  return items;
}

/** Price a split record only when all required counters and normalized per-million rates exist. */
function recordCost(record, prices) {
  const rate = prices?.[modelPresentation(record.model).key];
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
  prices = prices ? Object.fromEntries(Object.entries(prices).map(([name, rate]) => [modelPresentation(name).key, rate])) : null;
  const items = new Map((project?.items ?? []).map(item => [Number(item.id), item]));
  const agents = new Map((project?.agents ?? []).map(agent => [agent.agent_id ?? agent.id, agent]));
  const itemEvents = new Map();
  const landings = new Map();
  for (const event of [...(events ?? [])].sort((a, b) => Number(a.event_id ?? 0) - Number(b.event_id ?? 0))) {
    const id = Number(event.item_id ?? costEventDetail(event).item);
    if (!Number.isSafeInteger(id) || id < 1) continue;
    if (!itemEvents.has(id)) itemEvents.set(id, []);
    itemEvents.get(id).push(event);
    if (kindOf(event) === 'merged') landings.set(id, event);
  }
  const usage = usageByItem(events ?? []), sharedItems = sharedUsageItems(events ?? []);
  const rows = [...landings].map(([id, event]) => {
    const item = items.get(id) ?? {};
    const history = itemEvents.get(id) ?? [];
    const sharedUsage = sharedItems.has(id);
    const checkpoints = usage.filter(entry => entry.item === id).map(entry => {
      const owner = agents.get(entry.agent) ?? {};
      const named = modelPresentation(entry.model, owner.family);
      return { ...entry, model: named.name, modelKey: named.key, vendor: named.vendor, role: entry.phaseKnown ? usageRole(history, entry.agent, entry.eventId) : 'unattributed', costUSD: sharedUsage ? null : recordCost(entry, prices) };
    });
    const aggregates = new Map();
    for (const checkpoint of checkpoints) {
      const key = [checkpoint.agent, checkpoint.modelKey, checkpoint.vendor, checkpoint.role].join(':');
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
    const usageRows = [...aggregates.values()];
    const submits = history.filter(row => kindOf(row) === 'submit').length;
    const reviewActors = [...new Set(history.filter(row => ['accept', 'reject'].includes(kindOf(row))).map(actorOf).filter(Boolean))];
    const buildAgent = item.builtBy ?? item.built_by ?? item.builder;
    const buildModel = agents.get(buildAgent)?.model ?? agents.get(buildAgent)?.agent_model;
    const buildModels = [...new Set([
      ...usageRows.filter(row => row.role !== 'review').map(row => row.model),
      ...(typeof buildModel === 'string' && buildModel.trim() && buildModel.toLowerCase() !== 'unknown' ? [buildModel] : []),
    ])];
    const reviewedModels = [...new Set(reviewActors.map(id => agents.get(id)?.model ?? agents.get(id)?.agent_model).filter(value => typeof value === 'string' && value.trim()))];
    const costs = usageRows.map(row => row.costUSD);
    const totalCost = usageRows.length ? completeSum(costs) : null;
    const wall = usageRows.map(row => row.wallMs);
    const totalWallMs = usageRows.length && wall.every(value => Number.isSafeInteger(value)) ? wall.reduce((sum, value) => sum + value, 0) : null;
    const returnEvents = history.filter(row => ['reject', 'reopen'].includes(kindOf(row)));
    const returns = returnEvents.map((row, index) => {
      const after = Number(row.event_id ?? 0), before = Number(returnEvents[index + 1]?.event_id ?? Infinity);
      const reworkCosts = checkpoints.filter(entry => entry.role === 'rework' && entry.eventId > after && entry.eventId < before).map(entry => entry.costUSD);
      const ambiguousWindow = checkpoints.some(entry => entry.role === 'unattributed' && entry.eventId > after && entry.eventId < before);
      return { kind: kindOf(row), at: row.event_at ?? row.at, costUSD: reworkCosts.length && !ambiguousWindow ? completeSum(reworkCosts) : null };
    });
    return { id, title: item.title ?? `Item ${id}`, landedAt: event.event_at ?? event.at ?? '', buildModels: [...new Set(buildModels.map(value => modelPresentation(value).name))], reviewedModels: [...new Set(reviewedModels.map(value => modelPresentation(value).name))],
      agentHours: totalWallMs === null ? null : totalWallMs / 3_600_000, rounds: submits, usageRows, returns, totalCost: sharedUsage ? null : totalCost, sharedUsage };
  }).sort((a, b) => String(b.landedAt).localeCompare(String(a.landedAt)) || b.id - a.id).slice(0, 20);
  const knownCosts = rows.map(row => row.totalCost);
  const total = rows.length ? completeSum(knownCosts) : null;
  const middle = median(knownCosts);
  const rework = rows.flatMap(row => row.usageRows.filter(entry => entry.role === 'rework').map(entry => entry.costUSD));
  const phaseUnknown = rows.some(row => row.sharedUsage || row.usageRows.some(entry => entry.role === 'unattributed'));
  const reworkCost = phaseUnknown ? null : rework.length ? completeSum(rework) : total !== null ? 0 : null;
  const reworkShare = total !== null && total > 0 && reworkCost !== null ? reworkCost / total : null;
  const vendors = [...new Set(rows.flatMap(row => row.usageRows.map(entry => entry.vendor)))].sort().map(vendor => ({
    vendor,
    costUSD: completeSum(rows.flatMap(row => row.usageRows.filter(entry => entry.vendor === vendor).map(entry => entry.costUSD))),
  }));
  return { rows, total, perLanding: rows.length && total !== null ? total / rows.length : null, median: middle, reworkShare, vendors };
}

/** Render an agent/model/phase usage aggregate and unknown dollar cost. */
function sessionHtml(session) {
  const token = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : '—';
  const phase = session.role === 'unattributed' ? 'Phase unavailable' : session.role;
  return '<div class="cost-session"><span class="cost-session-model"><b>' + escapeHtml(session.model) + '</b><small>' + escapeHtml(session.agent) + ' · ' + escapeHtml(phase) + '</small></span>'
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
    const sessions = row.usageRows.length ? row.usageRows.map(sessionHtml).join('') : '<p class="cost-unknown">' + (row.sharedUsage
      ? 'Shared usage is not attributable to this item; token and cost figures are unavailable.'
      : 'No usage record; token and cost figures are unavailable.') + '</p>';
    const returns = row.returns.length ? '<section class="cost-returns"><h3>Rejects and reopens</h3><ul>' + row.returns.map(entry => '<li><span>' + escapeHtml(entry.kind === 'reject' ? 'Rejected' : 'Reopened') + ' · ' + escapeHtml(dateLabel(entry.at)) + '</span><b>' + costFigure(entry.costUSD) + '</b></li>').join('') + '</ul></section>' : '';
    const shared = row.sharedUsage ? '<p class="cost-unknown">Shared session usage is not split across its items.</p>' : '';
    return summary + '<div class="cost-detail" id="cost-detail-' + row.id + '"><h3>Usage by agent, model and phase</h3>' + shared + sessions + returns + '</div>';
  }).join('') : '<p class="empty">No landed items yet.</p>';
  return '<section class="cost-page" aria-label="Cost"><header class="cost-heading"><div><h1>Cost</h1><p>The last 20 landed items</p></div><span class="cost-private">Private to this view</span></header>'
    + tiles + '<section class="cost-list card-panel" aria-label="Landed items">' + cards + '</section></section>';
}

/** Embed this module's closure-free Cost functions into the standalone local-view page. */
export function costTabScript() {
  const functions = [modelPresentation, costEventDetail, actorOf, kindOf, costFigure, dateLabel, escapeHtml, completeSum, median,
    usageRole, firstSamplePhaseKnown, counterDelta, usageByItem, sharedUsageItems, recordCost, costTabModel, sessionHtml, costTabHtml, costOverviewHtml, bindCostOverview];
  return functions.map((fn) => `const ${fn.name} = (${fn.toString()});`).join('\n');
}
