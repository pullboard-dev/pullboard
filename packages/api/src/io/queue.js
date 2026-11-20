/** The offer path of the runner-store split: a job queued through the board's runs port instead of written to the board [B2,P7]. */
import { boardRunsHolder } from './store.js';
import { queueRun } from './store.js';
import { runsPort } from './store.js';
import { jobView } from '../../../jobs/index.js';

/**
 * The queue an offer goes through while the board's runs_store flag is on, or null while it is off.
 * Why: every offer reads this one answer, so with the flag off nothing about an offer changes and a board that never
 * turned the flag on never creates a runs file (~/pbseat/coord/runner-store-design.md, section 2).
 *
 * @param {any} board - An open board.
 * @param {string} by - The agent the run's event is logged under.
 * @param {{ file?: string }} [options] - file: the board's file path; read from the open board when omitted. A board with no file (memory) has no runs file to open, so it queues nowhere.
 * @returns {{ board: any, runs: { db: import('node:sqlite').DatabaseSync }, port: ReturnType<typeof runsPort>, by: string } | null}
 */
export function queueFor(board, by, { file } = {}) {
  const path = file ?? board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (!path) return null;
  const runs = boardRunsHolder(board, path);
  return runs ? { board, runs, port: runsPort(runs), by } : null;
}

/**
 * Queue one offered job: intent on the runs file, the run row on the board, then the offer on the runs file (queueRun).
 * The runs file's job keeps the same offered row an offerJob would write, so a runner claims it the same way.
 *
 * @param {NonNullable<ReturnType<typeof queueFor>>} queue
 * @param {{ id: string, kind: string, item: number | null, candidate: string | null, base: string | null, request: Record<string, unknown> | null, offered: Record<string, unknown> }} job - offered: the offered step's payload.
 * @returns {ReturnType<typeof jobView>} The job as the runs file holds it.
 */
export function queueOffer(queue, { id, kind, item, candidate, base, request, offered }) {
  queueRun(queue.board, queue.port, { by: queue.by, id, kind, item, candidate, base, request: request ?? {}, payload: offered });
  return jobView(queue.runs.db, id);
}
