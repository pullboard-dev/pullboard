/** driveLanding: run one `pullboard land` as a drive-cell job, its start and end written as steps on the job row [C7]. */
import { randomUUID } from 'node:crypto';
import { createJob } from '../../../jobs/index.js';
import { finishJob } from '../../../jobs/index.js';
import { releaseLease } from '../../../jobs/index.js';
import { renewLease } from '../../../jobs/index.js';
import { takeJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { LANDING_RUN_KIND } from '../core/drive-landing.js';
import { landingRunJobId } from '../core/drive-landing.js';
import { landingRunSummary } from '../core/drive-landing.js';

/** How often a running landing renews its job lease (RFC 0008 DJ13). */
const RENEW_MS = 5_000;

/**
 * Write one job bookkeeping step, reporting instead of throwing when the board refuses it.
 *
 * Why: the job row records the landing; it must never stop one. A busy board that refused a step used to be the
 * reason recordBatchLanding defers its own job write, and the same holds here.
 *
 * @param {() => any} write
 * @param {(line: string) => void} say
 * @returns {boolean} True when the write went through.
 */
function bookkeep(write, say) {
  try { write(); return true; }
  catch (error) { say(`landing job deferred: ${error?.code ?? 'ERROR'} ${error?.message ?? error}`); return false; }
}

/**
 * Run one landing as a drive-cell job: create its row, hold its lease while `run` lands in this process, and write
 * `started` then `finished` (or `failed`) steps, so the board shows every landing run and who drives it.
 *
 * Why: landing used to spawn bin/landing-worker.js, a guardian and worker pair the job store never saw. As a job the
 * run is one row with a lease a reader can trust: a live landing renews it, a dead one lapses in two minutes.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's SQLite handle.
 * @param {{ owner: string, run: () => Promise<any>, id?: string, now?: () => number, renewMs?: number,
 *   say?: (line: string) => void }} options - run lands the batch and returns the batch engine's result.
 * @returns {Promise<any>} What run returned.
 */
export async function driveLanding(db, { owner, run, id = landingRunJobId(randomUUID()), now = Date.now, renewMs = RENEW_MS, say = () => {} }) {
  const held = bookkeep(() => {
    createJob(db, { id, kind: LANDING_RUN_KIND, now: now() });
    takeJob(db, id, owner, { now: now() });
    writeStep(db, id, 'started', { owner }, { now: now() });
  }, say);
  const heartbeat = held ? setInterval(() => { try { renewLease(db, id, owner, { now: now() }); } catch { /* the next tick retries */ } }, renewMs) : null;
  heartbeat?.unref?.();
  try {
    const result = await run();
    clearInterval(heartbeat);
    if (held) bookkeep(() => { writeStep(db, id, 'finished', landingRunSummary(result), { now: now() }); finishJob(db, id, owner, { now: now() }); }, say);
    return result;
  } catch (error) {
    clearInterval(heartbeat);
    if (held) bookkeep(() => {
      writeStep(db, id, 'failed', { code: error?.code ?? 'ERROR', message: String(error?.message ?? error) }, { now: now() });
      releaseLease(db, id, owner, { now: now() });
    }, say);
    throw error;
  }
}
