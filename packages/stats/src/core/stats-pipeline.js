import { pipelineCauseType } from '../../../kernel/index.js';
/** Recorded lifecycle intervals and attempts for a bounded window of landed items [R1,R2,C7]. */
import { Refused } from '../../../kernel/core.js';
import { proofEventDetail } from '../../../kernel/src/core/event-detail.js';

const STAGES = ['claim', 'submit', 'reviewWait', 'review', 'landing'];
const CAUSES = ['runner-wait', 'flake', 'main-red', 'bar-change', 'conflict', 'companion-wait', 'test-failure', 'other', 'unknown'];

/** Validate the public last-N selector before any history is read. */
export function pipelineLimit(value = 20) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new Refused('USAGE', 'choose the last 1–1000 landed items: pullboard stats pipeline --limit 20');
  return count;
}

/** Use only typed causes or structural native evidence, never a narrative note or test name. */
function causeOf(kind, detail) {
  const typed = pipelineCauseType(detail.pipelineCause);
  if (typed) return typed;
  if (kind === 'refreeze') return 'bar-change';
  if (detail.conflict?.files?.length) return 'conflict';
  const value = detail.cause ?? detail.code ?? detail.reason;
  if (typeof value !== 'string') return 'unknown';
  if (value.startsWith('conflict:')) return 'conflict';
  const known = { RUNNER_WAIT_DEADLINE: 'runner-wait',
    FLAKE: 'flake', MAIN_RED: 'main-red', CRITERIA_CHANGED: 'bar-change',
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
  item.retries.push({ eventId: event.event_id, at: event.event_at, kind, cause: causeOf(event.event_kind, detail),
    ...(detail.pipelineCause?.type === 'other' && pipelineCauseType(detail.pipelineCause) ? { text: detail.pipelineCause.text } : {}) });
}

/** Respect recorded lease deadlines; a clock transition is evidence only when its deadline was recorded. */
function expire(item, at, event) {
  if (item.stage === 'claim' && Number.isFinite(item.claimUntil) && item.claimUntil <= at) {
    close(item, item.claimUntil, event.event_id); item.stage = null; item.since = item.claimUntil;
  }
  if (item.stage === 'review' && Number.isFinite(item.reviewUntil) && (item.reviewUntil < at || item.reviewUntil === at && !['accept', 'reject'].includes(event.event_kind))) {
    close(item, item.reviewUntil, event.event_id); item.stage = 'reviewWait'; item.since = item.reviewUntil;
  }
}

/** Replay one native item event without inferring unrecorded attempts or command start times. */
function observe(item, event) {
  const detail = proofEventDetail(event), kind = event.event_kind, at = Date.parse(event.event_at);
  expire(item, at, event);
  if (kind === 'add') item.title = detail.title ?? item.title;
  if (kind === 'claim' || kind === 'renew') {
    item.claimUntil = Date.parse(detail.leaseUntil);
    if (detail.submitOutcome) {
      retry(item, event, detail.submitOutcome, 'submit-retry');
      if (item.stage === 'submit') { close(item, at, event.event_id); item.stage = 'claim'; item.since = at; }
      item.activeAdmission = false; item.outcomeRecorded = true;
    } else if (detail.submitAdmission?.id) {
      if (item.admissions++ > 0 && !item.outcomeRecorded && item.stage === 'submit') retry(item, event, detail, 'submit-retry');
      close(item, at, event.event_id);
      if (item.stage !== 'claim' && item.stage !== 'submit') gap(item, ['claim'], event.event_id, 'no recorded claim boundary before submit admission');
      item.stage = 'submit'; item.since = at; item.activeAdmission = true; item.outcomeRecorded = false;
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
    item.reviewUntil = Date.parse(detail.until);
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
  } else if (['reopen', 'refreeze', 'withdraw', 'lapse', 'escalate'].includes(kind)) {
    if (!['lapse', 'escalate'].includes(kind)) retry(item, event, detail);
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
    unmeasuredGaps: [{ kind: 'unrecorded-attempts', count: null, durationMs: null, reason: 'Legacy attempts and failures before a live submit attempt may have no recorded event; their count, cause and duration are unmeasured.' }],
    totals: Object.fromEntries(STAGES.map(key => [key, { measuredMs: items.reduce((sum, item) => sum + item.measuredMs[key], 0), unmeasuredItems: items.filter(item => item.stages[key] === null).length }])),
    evidence: 'Recorded native events only; attempts without native admission or outcome evidence remain unmeasured. Landing includes the recorded acceptance-to-merge wait.' };
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
  for (const gap of report.unmeasuredGaps) lines.push(`unmeasured ${gap.kind}: ${gap.reason}`);
  lines.push(report.evidence);
  return lines;
}

const HOUR = 60 * 60_000;
/** A lapsed lease is the only recorded structure for a stale claim; its release reason is the board's own words [C7]. */
const STALE_RELEASE = /no heartbeat|lease lapsed|lease expired/iu;

/** Name a reviewer's family from what the board recorded: a declared family, else the model's maker, else unknown. */
function familyName(declared, event, detail) {
  const named = typeof detail.family === 'string' && detail.family.trim() ? detail.family : declared.get(event.event_by);
  if (named) return named.toLowerCase();
  const model = typeof detail.model === 'string' ? detail.model.toLowerCase() : '';
  if (/^(claude|anthropic)/u.test(model)) return 'anthropic';
  if (/^(gpt|codex|o\d|openai)/u.test(model)) return 'openai';
  return model ? model.split('-')[0] : 'unknown';
}

/** A share, or null when nothing was attempted, so an empty hour never reads as 0% bounced. */
const share = (count, of) => of > 0 ? count / of : null;

/**
 * The pipeline over the last `windowMinutes`, scaled to one hour: green submits, verdicts by reviewer family, items
 * landed, and the share bounced at each stage (red gate, reject, landing reopen, stale claim) [C7].
 */
export function pipelinePerHour(history, { now = Date.now(), windowMinutes = 60 } = {}) {
  if (!(windowMinutes > 0) || !Number.isFinite(windowMinutes)) throw new Refused('USAGE', 'choose a positive window, for example pullboard stats --window 1h');
  const from = now - windowMinutes * 60_000, scale = HOUR / (windowMinutes * 60_000);
  const count = { green: 0, red: 0, accept: 0, reject: 0, landed: 0, reopen: 0, stale: 0, claims: 0 };
  const verdicts = new Map(), declared = new Map();
  for (const event of [...history].sort((a, b) => a.event_id - b.event_id)) {
    const detail = proofEventDetail(event);
    if (typeof detail.family === 'string' && detail.family.trim()) declared.set(event.event_by, detail.family);
    const at = Date.parse(event.event_at);
    if (!(at > from && at <= now)) continue;
    const kind = event.event_kind;
    if (kind === 'gate-run' && detail.run?.kind === 'submit') count[detail.run.green === true ? 'green' : 'red'] += 1;
    else if (kind === 'accept' || kind === 'reject') {
      count[kind] += 1;
      const name = familyName(declared, event, detail), row = verdicts.get(name) ?? { family: name, accept: 0, reject: 0 };
      row[kind] += 1; verdicts.set(name, row);
    } else if (kind === 'merged') count.landed += 1;
    else if (kind === 'reopen') count.reopen += 1;
    else if (kind === 'claim') count.claims += 1;
    else if (kind === 'release' && STALE_RELEASE.test(String(detail.reason ?? ''))) count.stale += 1;
  }
  const perHour = value => Math.round(value * scale * 100) / 100;
  return { version: 1, windowMinutes, greenSubmitsPerHour: perHour(count.green), landedPerHour: perHour(count.landed),
    verdictsPerHour: [...verdicts.values()].sort((a, b) => a.family.localeCompare(b.family))
      .map(row => ({ family: row.family, accept: perHour(row.accept), reject: perHour(row.reject) })),
    bounced: {
      red: { count: count.red, of: count.green + count.red, share: share(count.red, count.green + count.red) },
      reject: { count: count.reject, of: count.accept + count.reject, share: share(count.reject, count.accept + count.reject) },
      reopen: { count: count.reopen, of: count.accept, share: share(count.reopen, count.accept) },
      stale: { count: count.stale, of: count.claims, share: share(count.stale, count.claims) },
    }, evidence: 'Recorded native events in the window, scaled to one hour; a stage nothing entered reads unmeasured, never 0%.' };
}

/** Render the per-hour pipeline for people. */
export function pipelinePerHourLines(report) {
  const text = row => row.share === null ? 'unmeasured' : `${(row.share * 100).toFixed(1)}% (${row.count} of ${row.of})`;
  return [`pipeline per hour (window ${report.windowMinutes} min): ${report.greenSubmitsPerHour} green submits · ${report.landedPerHour} items landed`,
    `verdicts per hour by reviewer family: ${report.verdictsPerHour.map(row => `${row.family} ${row.accept} accept / ${row.reject} reject`).join('; ') || 'none'}`,
    `bounced: red ${text(report.bounced.red)} · reject ${text(report.bounced.reject)} · reopen ${text(report.bounced.reopen)} · stale ${text(report.bounced.stale)}`];
}
