/** Read-only aggregate evidence for a case study; recorded work is not fresh execution [C7]. */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { receiptFields } from '../../../packages/gate/heavy.js';

/** Bound memory and statement lifetimes: SQLite iterators on the minimum Node can outlive their statement. */
export function* eventRows(db, kind = null) {
  const statement = db.prepare('SELECT event_id,event_kind,item_id,event_at,event_detail FROM event WHERE event_id>? AND (? IS NULL OR event_kind=?) ORDER BY event_id LIMIT 128');
  let cursor = 0;
  for (;;) {
    const page = statement.all(cursor, kind, kind);
    if (!page.length) return;
    for (const row of page) yield row;
    cursor = page.at(-1).event_id;
  }
}

/** Parse a recorded timestamp, leaving absent or damaged observations unknown. */
function timestamp(value) {
  return typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
}

/** Parse an event object without treating malformed JSON as empty evidence. */
function detailOf(value) {
  try {
    const valueObject = JSON.parse(value);
    return valueObject && typeof valueObject === 'object' && !Array.isArray(valueObject) ? valueObject : null;
  } catch { return null; }
}

/** Summarize a stated sample; missing observations never become zero-duration measurements. */
function distribution(values, population) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, population, unknown: population - sorted.length,
    meanMs: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
    medianMs: sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2 : null,
    p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null };
}

/** Recognize structured conflict causes only; free-text notes are deliberately not evidence. */
function isConflict(detail) {
  if (!detail) return false;
  if (detail.cause === 'refusal:MERGE_CONFLICT' || /^conflict:.+/u.test(detail.cause ?? '')) return true;
  if (Array.isArray(detail.causes) && detail.causes.some(cause => typeof cause === 'string' && /^conflict:.+/u.test(cause))) return true;
  return Array.isArray(detail.conflict?.files) && detail.conflict.files.length > 0
    && detail.conflict.files.every(file => typeof file === 'string' && file.length > 0 && !file.includes('\0'))
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(detail.conflict.trunk ?? '');
}

/** Bind an item's exact source head; a missing head cannot match an acceptance or replay identity. */
function commitOf(detail) {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(detail?.commit ?? '') ? detail.commit : null;
}

/** Append a nonnegative native latency only when both chronological anchors are known. */
function latency(values, end, start) {
  if (end !== null && start !== null && end >= start) values.push(end - start);
}

/** Aggregate one immutable native event table over (from,to], with history used only for anchors/deduplication. */
export function eventMetrics(boardPath, { from, to }) {
  const start = timestamp(from), end = timestamp(to);
  if (start === null || end === null || start >= end) throw new TypeError('event metrics require valid from < to timestamps');
  /** Select only timestamped events in the requested half-open window. */
  const inWindow = at => at !== null && at > start && at <= end;
  const claims = new Map(), acceptances = new Map(), submittedHeads = new Map(), submitHistory = new Map();
  const merged = new Set(), receipts = new Map(), landedItems = new Set(), submittedItems = new Set();
  const landedSubmitCounts = new Map();
  const claimToLand = [], acceptToLand = [];
  const unknown = { timestamps: 0, details: 0, landingIdentity: 0, receiptIdentity: 0, conflictingReceiptIds: 0, receiptTimestamps: 0 };
  let landings = 0, submits = 0, conflictReopens = 0, windowEvents = 0;
  let db;
  try {
    db = new DatabaseSync(boardPath, { readOnly: true });
    db.exec('BEGIN');
    for (const event of eventRows(db)) {
      const at = timestamp(event.event_at), detail = detailOf(event.event_detail);
      if (at === null) unknown.timestamps += 1;
      if (!detail) unknown.details += 1;
      const selected = inWindow(at);
      if (selected) windowEvents += 1;
      const item = Number.isSafeInteger(event.item_id) && event.item_id > 0 ? event.item_id : null;
      const commit = commitOf(detail);
      if (item !== null && event.event_kind === 'claim') claims.set(item, at);
      // A landing commit differs from the submitted source; bind acceptance to the current submission.
      if (item !== null && event.event_kind === 'accept') {
        if (commit && submittedHeads.get(item) === commit) acceptances.set(item, { commit, at });
        else acceptances.delete(item);
      }
      if (item !== null && ['reject', 'reopen', 'withdraw', 'patch', 'edit'].includes(event.event_kind)) acceptances.delete(item);
      if (item !== null && event.event_kind === 'submit') {
        submittedHeads.set(item, commit);
        acceptances.delete(item);
        const history = submitHistory.get(item) ?? [];
        history.push(at); submitHistory.set(item, history);
        if (selected) { submits += 1; submittedItems.add(item); }
      }
      if (selected && event.event_kind === 'reopen' && isConflict(detail)) conflictReopens += 1;
      if (event.event_kind === 'merged') {
        if (item === null || !commit) { if (selected) unknown.landingIdentity += 1; }
        else if (!merged.has(`${item}:${commit}`)) {
          merged.add(`${item}:${commit}`);
          if (selected) {
            landings += 1; landedItems.add(item);
            landedSubmitCounts.set(item, (submitHistory.get(item) ?? []).filter(value => value !== null && value <= at).length);
            latency(claimToLand, at, claims.get(item) ?? null);
            const accepted = acceptances.get(item);
            latency(acceptToLand, at, accepted && accepted.commit === submittedHeads.get(item) ? accepted.at : null);
          }
        }
      }
      if (event.event_kind === 'proof-run' || event.event_kind === 'gate-run' && detail?.run?.timing) {
        const nativeRun = event.event_kind === 'gate-run' ? receiptFields(detail.run) : null;
        const receipt = event.event_kind === 'gate-run' ? nativeRun : detail?.receipt;
        if (!receipt || typeof receipt.id !== 'string' || !receipt.id.trim()) {
          if (selected) unknown.receiptIdentity += 1;
          continue;
        }
        const receiptAt = timestamp(receipt.at);
        if (receiptAt === null) unknown.receiptTimestamps += 1;
        const signature = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
        const previous = receipts.get(receipt.id);
        if (previous) {
          if (previous.signature !== signature && !previous.conflicting) {
            previous.conflicting = true; unknown.conflictingReceiptIds += 1;
          }
        } else receipts.set(receipt.id, { signature, receipt: { kind: receipt.kind, durationMs: nativeRun ? receipt.timing.wallMs : receipt.durationMs,
          full: receipt.full, environment: receipt.environment, node: nativeRun?.timing.node ?? null, reused: receipt.reused },
          selected: inWindow(receiptAt), conflicting: false });
      }
    }
    db.exec('ROLLBACK');
  } finally { db?.close(); }
  const submitDurations = [], fullDurations = [], nodes = new Set();
  let receiptPopulation = 0, submitPopulation = 0, fullPopulation = 0, reused = 0, reuseUnknown = 0;
  for (const { receipt, selected, conflicting } of receipts.values()) {
    if (!selected || conflicting) continue;
    receiptPopulation += 1;
    const duration = typeof receipt.durationMs === 'number' && Number.isFinite(receipt.durationMs) && receipt.durationMs > 0 ? receipt.durationMs : null;
    if (receipt.kind === 'submit') { submitPopulation += 1; if (duration !== null) submitDurations.push(duration); }
    if (receipt.full === true) { fullPopulation += 1; if (duration !== null) fullDurations.push(duration); }
    if (typeof (receipt.node ?? receipt.environment?.node) === 'string') nodes.add(receipt.node ?? receipt.environment.node);
    if (receipt.reused === true) reused += 1;
    else if (receipt.reused !== false) reuseUnknown += 1;
  }
  const cohortCounts = [...landedSubmitCounts.values()];
  const hours = (end - start) / 3_600_000;
  return {
    window: { from: new Date(start).toISOString(), to: new Date(end).toISOString(), bounds: '(from,to]', hours, events: windowEvents },
    population: 'native event records; receipt durations describe recorded runs, not fresh coverage',
    landings: { n: landings, distinctItems: landedItems.size, perHour: landings / hours, deduplication: 'first item+commit globally in native event order' },
    claimToLand: distribution(claimToLand, landings),
    acceptToLand: { ...distribution(acceptToLand, landings),
      scope: 'latest acceptance of latest submitted source head before landing; submit/reject/reopen/withdraw/patch/edit invalidate prior acceptance' },
    submits: { n: submits, distinctItems: submittedItems.size, perSubmittedItem: submittedItems.size ? submits / submittedItems.size : null },
    landedCohortSubmits: { items: landedItems.size, n: cohortCounts.reduce((sum, value) => sum + value, 0),
      perItem: landedItems.size ? cohortCounts.reduce((sum, value) => sum + value, 0) / landedItems.size : null,
      scope: "recorded timestamped submits through each item's latest landing in window" },
    conflictReopens: { n: conflictReopens, landingDenominator: landings, perLanding: landings ? conflictReopens / landings : null,
      scope: 'window reopen events with typed conflict cause/metadata only' },
    proofReceipts: { n: receiptPopulation, deduplication: 'native receipt id globally; conflicting ids excluded',
      windowTimestamp: 'receipt.at only; absent/invalid timestamps excluded, never inferred from event recording time',
      submitReceiptDuration: { ...distribution(submitDurations, submitPopulation), phaseMeaning: 'unknown; recorded receipt.durationMs only' },
      fullSuite: { ...distribution(fullDurations, fullPopulation), evidence: fullPopulation ? 'explicit receipt.full === true only' : 'missing explicit full-suite receipts' },
      reuse: { explicitReused: reused, unknown: reuseUnknown }, runtimeNodes: [...nodes].sort(),
      qualification: 'native timing.wallMs is admitted controller wall time, including executor preparation and command; overlapping shard attempts are not summed. Legacy receipt.durationMs phase meaning stays unknown. Native timing.node names the suite process; legacy runtime is executor metadata, deeper runtimes unknown' },
    unknown: { ...unknown, scope: 'invalid history anchors/deduplication inputs across the full recorded event table' },
  };
}
