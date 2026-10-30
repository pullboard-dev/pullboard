/** Recorded lifecycle intervals and attempts for a bounded window of landed items [R1,R2,C7]. */
import { Refused } from './refused.js';
import { proofEventDetail } from '../packages/kernel/src/core/event-detail.js';

const STAGES = ['claim', 'submit', 'reviewWait', 'review', 'landing'];
const CAUSES = ['runner-wait', 'flake', 'main-red', 'bar-change', 'conflict', 'companion-wait', 'unknown'];

/** Validate the public last-N selector before any history is read. */
export function pipelineLimit(value = 20) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new Refused('USAGE', 'choose the last 1–1000 landed items: pullboard stats pipeline --limit 20');
  return count;
}

/** Use only typed causes or structural native evidence, never a narrative note or test name. */
function causeOf(kind, detail) {
  if (kind === 'refreeze') return 'bar-change';
  if (detail.conflict?.files?.length) return 'conflict';
  const value = detail.cause ?? detail.code ?? detail.reason;
  if (typeof value !== 'string') return 'unknown';
  if (value.startsWith('conflict:')) return 'conflict';
  const known = { RUNNER_WAIT_DEADLINE: 'runner-wait', RUNNER_INFRA_RETRY_EXHAUSTED: 'runner-wait',
    FLAKE: 'flake', MAIN_RED: 'main-red', CRITERIA_CHANGED: 'bar-change', ITEM_PATCH_CHANGED: 'companion-wait',
    'runner wait': 'runner-wait', 'bar change': 'bar-change', 'main red': 'main-red', 'companion wait': 'companion-wait' };
  return CAUSES.includes(value) ? value : known[value] ?? 'unknown';
}

/** Start an item's independent trace; missing boundaries stay distinct from measured zero. */
function trace(id) {
  return { id, title: '', stage: null, since: null, measured: Object.fromEntries(STAGES.map(key => [key, 0])),
    missing: new Set(), seen: new Set(), gaps: [], retries: [], admissions: 0, submits: 0, activeAdmission: false, landedAt: null, landedEvent: null };
}

/** Close exactly the interval between two recorded native events. */
function close(item, at, eventId) {
  if (!item.stage) return;
  if (Number.isFinite(item.since) && Number.isFinite(at) && at >= item.since) { item.measured[item.stage] += at - item.since; item.seen.add(item.stage); }
  else {
    item.missing.add(item.stage);
    item.gaps.push({ eventId, stages: [item.stage], reason: 'missing or non-monotonic boundary' });
  }
}

/** Record an explicitly unseparated interval without assigning its time to either adjacent stage. */
function gap(item, stages, eventId, reason) {
  for (const stage of stages) item.missing.add(stage);
  item.gaps.push({ eventId, stages, reason });
}

/** Observe a retry/reopen once at its native event identity, retaining even an unknown cause. */
function retry(item, event, detail, kind = event.event_kind) {
  item.retries.push({ eventId: event.event_id, at: event.event_at, kind, cause: causeOf(event.event_kind, detail) });
}

/** Replay one native item event without inferring unrecorded attempts or command start times. */
function observe(item, event) {
  const detail = proofEventDetail(event), kind = event.event_kind, at = Date.parse(event.event_at);
  if (kind === 'add') item.title = detail.title ?? item.title;
  if (kind === 'claim' || kind === 'renew') {
    if (detail.submitAdmission?.id) {
      if (item.admissions++ > 0) retry(item, event, detail, 'submit-retry');
      close(item, at, event.event_id);
      if (item.stage !== 'claim' && item.stage !== 'submit') gap(item, ['claim'], event.event_id, 'no recorded claim boundary before submit admission');
      item.stage = 'submit'; item.since = at; item.activeAdmission = true;
    } else if (kind === 'claim') {
      close(item, at, event.event_id); item.stage = 'claim'; item.since = at; item.activeAdmission = false;
    }
    return;
  }
  if (kind === 'submit') {
    if (item.submits++ > 0 && !item.activeAdmission) retry(item, event, detail, 'submit-retry');
    if (item.stage === 'submit') close(item, at, event.event_id);
    else gap(item, ['claim', 'submit'], event.event_id, 'no recorded submit admission; claim and submit time cannot be separated');
    item.stage = 'reviewWait'; item.since = at; item.activeAdmission = false;
  } else if (kind === 'reserve') {
    if (item.stage !== 'review') {
      close(item, at, event.event_id);
      if (item.stage !== 'reviewWait') gap(item, ['reviewWait'], event.event_id, 'no recorded submission before review');
      item.stage = 'review'; item.since = at;
    }
  } else if (kind === 'accept' || kind === 'reject') {
    if (item.stage === 'review') close(item, at, event.event_id);
    else gap(item, ['reviewWait', 'review'], event.event_id, 'no recorded review reservation; waiting and review time cannot be separated');
    if (kind === 'reject') retry(item, event, detail);
    item.stage = kind === 'accept' ? 'landing' : null; item.since = at;
  } else if (kind === 'release') {
    close(item, at, event.event_id);
    item.stage = detail.review ? 'reviewWait' : null; item.since = at;
  } else if (['reopen', 'refreeze', 'withdraw'].includes(kind)) {
    retry(item, event, detail);
    if (!(kind === 'refreeze' && detail.retainedClaim)) { close(item, at, event.event_id); item.stage = null; item.since = at; item.activeAdmission = false; }
  } else if (kind === 'merged') {
    if (item.stage === 'landing') close(item, at, event.event_id);
    else gap(item, ['landing'], event.event_id, 'no recorded acceptance before landing');
    item.landedAt = event.event_at; item.landedEvent = event.event_id; item.stage = null; item.since = at;
  }
}

/** Project only recorded attempts up to each item's latest landing; later edits do not rewrite that cycle. */
export function pipelineStats(history, { limit = 20 } = {}) {
  limit = pipelineLimit(limit);
  const ordered = [...history].sort((a, b) => a.event_id - b.event_id);
  const landed = new Map();
  for (const event of ordered) if (event.event_kind === 'merged' && event.item_id != null) landed.set(event.item_id, event.event_id);
  const selected = [...landed].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const traces = new Map(selected.map(([id]) => [id, trace(id)]));
  for (const event of ordered) {
    const item = traces.get(event.item_id);
    if (item && event.event_id <= landed.get(event.item_id)) observe(item, event);
  }
  const items = selected.map(([id]) => {
    const item = traces.get(id);
    for (const key of STAGES) if (!item.seen.has(key) && !item.missing.has(key)) gap(item, [key], item.landedEvent, 'no recorded ' + key + ' interval');
    return { id, title: item.title, landedAt: item.landedAt, landedEvent: item.landedEvent,
      stages: Object.fromEntries(STAGES.map(key => [key, item.missing.has(key) ? null : item.measured[key]])),
      measuredMs: item.measured, gaps: item.gaps, retries: item.retries };
  });
  const causes = Object.fromEntries(CAUSES.map(key => [key, 0]));
  for (const item of items) for (const retry of item.retries) causes[retry.cause] += 1;
  return { version: 1, limit, count: items.length, items, causes,
    totals: Object.fromEntries(STAGES.map(key => [key, { measuredMs: items.reduce((sum, item) => sum + item.measuredMs[key], 0), unmeasuredItems: items.filter(item => item.stages[key] === null).length }])),
    evidence: 'Recorded native events only; commands failing before admission leave no event and are unmeasured. Landing includes the recorded acceptance-to-merge wait.' };
}

/** Render the same exact millisecond projection for people and keep unknowns explicit. */
export function pipelineLines(report) {
  const lines = [`pipeline: last ${report.count} landed items (requested ${report.limit})`];
  for (const item of report.items) {
    lines.push(`#${item.id}: ${STAGES.map(key => `${key} ${item.stages[key] === null ? 'unmeasured' : item.stages[key] + ' ms'}`).join(' · ')}`);
    for (const retry of item.retries) lines.push(`  ${retry.kind} ${retry.eventId}: ${retry.cause} at ${retry.at}`);
    for (const gap of item.gaps) lines.push(`  unmeasured: ${gap.reason} (event ${gap.eventId})`);
  }
  lines.push(`retry/reopen causes: ${Object.entries(report.causes).map(([key, count]) => `${key} ${count}`).join(' · ')}`);
  lines.push(report.evidence);
  return lines;
}
