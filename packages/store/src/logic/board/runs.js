/**
 * The board's run rows as a projection of its events, and the receipt summary a run keeps [B2,R2].
 *
 * Why: every run row is written by a move and logged in that move's event, so replay rebuilds the run table from the
 * event log with no runs file present (~/pbseat/coord/runner-store-design.md, sections 1 and 4). The summary is capped
 * so a receipt never grows the board: strings over 200 bytes and lists over 24 entries become their hash and size.
 */
import { createHash } from 'node:crypto';

/** The event a queued run writes. */
export const RUN_QUEUED_EVENT = 'run_queued';

/** The event an applied receipt writes. */
export const RUN_APPLIED_EVENT = 'run_applied';

/** Longest string and list a summary keeps whole. */
const STRING_BYTES = 200;
const LIST_ENTRIES = 24;

/** The stand-in for a value too large to keep: its sha256 and its size in bytes. */
function digestOf(text) {
  return { sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) };
}

/**
 * A receipt cut down to what a gate or land decision reads: long strings and long lists become `{ sha256, bytes }`.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function runSummary(value) {
  if (typeof value === 'string') return Buffer.byteLength(value) > STRING_BYTES ? digestOf(value) : value;
  if (Array.isArray(value)) return value.length > LIST_ENTRIES ? digestOf(JSON.stringify(value)) : value.map(runSummary);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, runSummary(entry)]));
  return value;
}

/**
 * Rebuild run rows from board events, oldest first: a queued event creates the row, an applied event settles it.
 *
 * @param {{ event_at: string, item_id: number|null, event_kind: string, event_detail: string }[]} events
 * @returns {Record<string, any>[]} Rows shaped like the run table, ordered by job id.
 */
export function runRowsFromEvents(events) {
  const rows = new Map();
  for (const event of events) {
    const detail = JSON.parse(event.event_detail);
    const at = Date.parse(event.event_at);
    if (event.event_kind === RUN_QUEUED_EVENT && !rows.has(detail.job)) {
      rows.set(detail.job, { run_job: detail.job, run_kind: detail.kind, run_item: event.item_id, run_candidate: detail.candidate ?? null,
        run_base: detail.base ?? null, run_state: 'queued', run_attempt: 0, run_outcome: null, run_summary: null, run_record: null,
        run_lease_owner: null, run_lease_until: 0, run_created: at, run_updated: at });
    }
    const row = rows.get(detail.job);
    if (event.event_kind === RUN_APPLIED_EVENT && row) {
      Object.assign(row, { run_state: detail.state, run_attempt: detail.attempt, run_outcome: detail.outcome, run_summary: JSON.stringify(detail.summary), run_updated: at });
    }
  }
  return [...rows.values()].sort((a, b) => (a.run_job < b.run_job ? -1 : a.run_job > b.run_job ? 1 : 0));
}
