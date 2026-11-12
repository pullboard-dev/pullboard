/** Sufficient per-cause state for resume, without retaining or replaying raw history [D1,N19]. */
import { causeProblem } from '../../../store/index.js';
import { causeReading } from '../../../store/index.js';
import { eventCauses } from '../../../store/index.js';
import { isMergeConflict } from '../../../store/index.js';
import { parseSpec } from '../../../spec/index.js';
import { readRigorSource } from '../../../store/index.js';
import { automaticSourceFromText } from '../../../store/index.js';
import { readAutomaticRigorSource } from '../../../store/index.js';

/** Match the legacy notice reader's typed person decline, including old row-shaped metadata. */
function declineKey(event, detail, person) {
  if (event.event_kind !== 'row_decision' || event.event_by !== person || detail.record?.decision !== 'decline'
    || typeof detail.record.source !== 'string') return null;
  let rows;
  try { rows = parseSpec(`## Source\n${detail.record.source}\n`).rows; }
  catch { return null; } // Optional historical metadata cannot refuse an otherwise valid move.
  return rows.length === 1 ? (readRigorSource(rows[0].source)
    ?? readAutomaticRigorSource(automaticSourceFromText(rows[0].text)))?.key ?? null : null;
}

/** Only the person's typed never-again fact immediately qualifies a cause. */
function neverKey(event, detail, person) {
  return event.event_kind === 'fact' && event.event_by === person && detail.neverAgain === true
    && typeof detail.cause === 'string' && !causeProblem(detail.cause) ? detail.cause : null;
}

/** Return only the small set of cause shards that this event can change. */
export function rigorCounterKeys(event, person) {
  const detail = JSON.parse(event.event_detail);
  return [...new Set([...eventCauses(event), neverKey(event, detail, person), declineKey(event, detail, person)]
    .filter(key => key && !isMergeConflict(key)))];
}

/** Describe one cause's event contribution for the persistent writer and bounded in-memory fold. */
export function rigorCounterChange(key, event, person) {
  const detail = JSON.parse(event.event_detail);
  return { never: neverKey(event, detail, person) === key, caused: eventCauses(event).includes(key),
    declined: declineKey(event, detail, person) === key, commit: detail.commit };
}

/** Initialize a cause independently of its event's age or its current repeat eligibility. */
function emptyCause(key) {
  return { key, reads: causeReading(key), items: [], seen: [], occurrences: 0,
    healthOccurrences: 0, flakeOccurrences: 0, neverAgain: false, declined: null };
}

/** Fold one relevant event; item and commit insertion order matches the independent legacy oracle. */
export function advanceRigorCounter(previous, key, event, person) {
  const next = previous ? structuredClone(previous) : emptyCause(key);
  const { never, caused, declined, commit } = rigorCounterChange(key, event, person);
  if ((never || caused) && event.item_id !== null && !next.seen.includes(event.item_id)) next.seen.push(event.item_id);
  if (never || caused) {
    let item = next.items.find(row => row.id === event.item_id);
    if (event.item_id !== null && !item) { item = { id: event.item_id, commits: [] }; next.items.push(item); }
    if (never) next.neverAgain = true;
    else {
      next.occurrences += 1;
      if (event.event_kind === 'flake-observation') next.flakeOccurrences += 1;
      if (['health-failure', 'sentinel-failure'].includes(event.event_kind)) next.healthOccurrences += 1;
      if (item && commit && !item.commits.includes(commit)) item.commits.push(commit);
    }
  }
  if (declined) next.declined = [...next.seen];
  return next;
}

/** A decline stays quiet for old items even when they fail again at a new commit. */
export function rigorCounterEligible(cause) {
  const repeated = cause.neverAgain || cause.healthOccurrences >= 2 || cause.flakeOccurrences >= 2
    || cause.items.length >= 2 || cause.items.some(item => item.commits.length >= 2);
  return Boolean(repeated && (!cause.declined || cause.items.some(item => !cause.declined.includes(item.id))));
}

/** Expose the exact legacy report shape, without internal counters or person-decline snapshots. */
export function rigorCounterResult(cause) {
  return { key: cause.key, reads: cause.reads, occurrences: cause.occurrences, neverAgain: cause.neverAgain,
    items: cause.items.map(item => ({ id: item.id, commits: [...item.commits] })).sort((a, b) => a.id - b.id) };
}

/** Preserve the legacy report's deterministic presentation order across independently stored shards. */
export function sortRigorCounters(causes) {
  return causes.sort((a, b) => Number(b.neverAgain) - Number(a.neverAgain) || b.items.length - a.items.length
    || b.occurrences - a.occurrences || a.key.localeCompare(b.key));
}
