/** The gate-queue snapshot a runner's pull claim records: the queued gate jobs, the leases, the runners seen and this serve process's start [C7]. */
import { store } from './moves.js';

/** When this serve process started: a restart shows in the gate-queue events as a new value. */
const SERVE_STARTED_AT = Date.now();
/** How long a runner that called claim stays in a gate-queue snapshot's runnersSeen. */
const RUNNER_SEEN_MS = 120_000;
/** Per open board: the runners that called claim and when, and the last snapshot this process appended. Process memory only, so no read of past events [C7]. */
const QUEUE_SNAPSHOTS = new WeakMap();

/** The reads a gate-queue snapshot makes: queued gate jobs in offer order by job_step_updated, and the count holding a live lease by job_lease_live. */
export const QUEUED_GATES_SQL = "SELECT job_id FROM job WHERE job_step = 'offered' AND job_kind = 'gate' ORDER BY job_updated, job_id";
export const LEASED_GATES_SQL = "SELECT count(*) AS n FROM job WHERE job_lease_owner IS NOT NULL AND job_lease_until > ? AND job_kind = 'gate'";

/**
 * Append one gate-queue fleet event for a runner's pull claim when the queue differs from the last one this process appended:
 * { queued, leased, runnersSeen, serveStartedAt }. At most one append per call, two indexed reads, no read of past events.
 * Why: an item's gate-queued stretch had no record of why it waited; an item's jobs-ahead is its position in queued.
 *
 * @param {any} board
 * @param {{ runner?: string }} body
 * @param {number} now
 * @returns {boolean} whether an event was appended
 */
export function recordGateQueue(board, body, now) {
  const state = QUEUE_SNAPSHOTS.get(board) ?? { seen: new Map(), last: null };
  QUEUE_SNAPSHOTS.set(board, state);
  if (typeof body?.runner === 'string') state.seen.set(body.runner, now);
  for (const [runner, at] of state.seen) if (now - at > RUNNER_SEEN_MS) state.seen.delete(runner);
  const queued = board.db.prepare(QUEUED_GATES_SQL).all().map(row => row.job_id);
  const leased = board.db.prepare(LEASED_GATES_SQL).get(now).n;
  const snapshot = { queued, leased, runnersSeen: [...state.seen.keys()].sort(), serveStartedAt: SERVE_STARTED_AT };
  const key = JSON.stringify(snapshot);
  if (key === state.last) return false;
  // The snapshot is advisory: a refused or failed append never fails the runner's claim, and the next claim tries it again.
  try { store.logEvent(board, 'coordinator', 'gate-queue', null, snapshot); } catch { return false; }
  state.last = key;
  return true;
}
