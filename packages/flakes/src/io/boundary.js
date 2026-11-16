/** Where the landing flake ratchet starts counting, shared by the ratchet and quarantine backfill [C7,D1]. */
import { flakePairs } from '../logic/ratchet.js';
import { eventHistory } from './history.js';
import { ENGINE_VERSION } from '../../../state/index.js';
import { QUARANTINE_BACKFILL_ENGINE } from '../../../state/light.js';

/** One landed batch or merged ratchet receipt, reduced to what the boundary needs; null for every other event [C7]. */
function boundaryEvent(row) {
  let detail;
  try { detail = JSON.parse(row.event_detail); } catch { return null; /* json_valid(...) used to skip these rows. */ }
  if (row.event_kind === 'landing_batch') {
    return detail?.batch?.state === 'landed' ? { event_id: row.event_id, event_kind: row.event_kind, previous: detail.batch.flakeRatchet ?? null } : null;
  }
  const ratchet = detail?.flakeRatchet;
  return ratchet && typeof ratchet === 'object' && !Array.isArray(ratchet) ? { event_id: row.event_id, event_kind: row.event_kind, previous: ratchet } : null;
}

/** Every landed batch and merged ratchet receipt, read once per connection and then only the events since [C7]. */
export function warmRatchetBoundary(board) {
  return eventHistory(board, 'ratchet-boundary', ['landing_batch', 'merged'], boundaryEvent);
}

/**
 * The last landed batch or merged ratchet receipt, its recorded snapshot, and the event its pairs count after [C7].
 * Why: scanning 11,000 batch and merge events for it cost 240 ms inside every gate-run write's lock; the history keeps
 * the answer and reads only the events after it.
 */
export function ratchetBoundary(board) {
  const row = warmRatchetBoundary(board).at(-1) ?? null;
  const previous = row?.previous ?? null;
  return { row, previous, afterEvent: previous?.eventId ?? row?.event_id ?? 0 };
}

/** Each fixed ledger test and the event its repair merged at; pairs before that merge are not live flakes. */
export function repairedAt(board, ledger) {
  return new Map(ledger.filter(row => row.status === 'fixed' && row.item != null).map(row => [JSON.stringify([row.file, row.name]),
    board.db.prepare("SELECT MAX(event_id) AS id FROM event WHERE event_kind='merged' AND item_id=?").get(row.item).id]));
}

/**
 * Every same-tree red/green pair the landing ratchet would count, on trees run since its boundary, minus pairs a merged
 * repair already answers. Only runs after the boundary are scanned. Why the engine check: an older engine's recorded
 * move replays without the backfill, so it files no extra item and later item and event ids stay as recorded [C7,H16].
 */
export function backfillPairs(board, runs, ledger) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < QUARANTINE_BACKFILL_ENGINE) return [];
  const { afterEvent } = ratchetBoundary(board), repaired = repairedAt(board, ledger);
  const trees = new Set(runs.filter(run => run.eventId > afterEvent).map(run => run.tree));
  return flakePairs(runs.filter(run => trees.has(run.tree)), { afterEvent })
    .filter(pair => !(repaired.get(JSON.stringify([pair.file, pair.name])) > pair.lastEventId));
}
