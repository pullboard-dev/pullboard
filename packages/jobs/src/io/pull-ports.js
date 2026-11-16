/** The pull adapter's lease and record ports, bound to the board's job table [C7]. */
import { renewLease } from './lease.js';
import { takeJob } from './lease.js';
import { jobView } from './store.js';
import { writeStep } from './store.js';

/**
 * The `lease` and `record` ports a pull adapter takes, over the jobs table of a SQLite board.
 *
 * Why: the adapter only knows ports, so nothing outside tests could lease a queued job to a pull runner or write its
 * result down; these bind the ports to the same lease and step rows every other driver uses, so a pulled shard is
 * one more writer of the job row, not a second ledger.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ now?: () => number }} [options]
 * @returns {{ lease: { take: (job: string, runner: string) => boolean, renew: (job: string, runner: string) => boolean }, record: (job: string, shard: string, payload: object) => void }}
 */
export function jobsPullPorts(db, { now = Date.now } = {}) {
  return {
    lease: {
      // A job the table does not hold is not takeable: the offer waits for its row rather than failing the take.
      take: (job, runner) => jobView(db, job) !== null && takeJob(db, job, runner, { now: now() }).taken,
      renew: (job, runner) => renewLease(db, job, runner, { now: now() }),
    },
    record: (job, shard, payload) => { writeStep(db, job, `shard.${shard}`, payload, { now: now() }); },
  };
}
