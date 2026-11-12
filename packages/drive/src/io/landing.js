/** driveLanding: run one `pullboard land` as a drive-cell job, its start and end written as steps on the job row [C7]. */
import { randomUUID } from 'node:crypto';
import { createJob } from '../../../jobs/index.js';
import { finishJob } from '../../../jobs/index.js';
import { releaseLease } from '../../../jobs/index.js';
import { renewLease } from '../../../jobs/index.js';
import { takeJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { LANDING_RUN_KIND } from '../logic/landing.js';
import { landingRunJobId } from '../logic/landing.js';
import { landingRunSummary } from '../logic/landing.js';

/** How often a running landing renews its job lease (RFC 0008 DJ13). */
const RENEW_MS = 5_000;

/**
 * How long a landing batch may make no progress before it ends, when the repository sets no landing.stall (#3186).
 * Why 2 minutes: a 10-minute cut was the only end of a stall, and one stall on 11 Nov cost 10 minutes of a 1-2 minute
 * accepted-to-landed target; the heartbeat checks every RENEW_MS, so a stall ends within 5 s of the limit [C7,#5816].
 */
export const LANDING_STALL_MS = 2 * 60_000;

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
 * Given `watch`, the heartbeat also checks the batch's progress: once nothing moved for `watch.stallAfterMs` (2
 * minutes by default, #3186, #5816), it calls `watch.stall()` once, the batch ends, and a run that returns stalled is
 * marked failed with its lease freed, so the next landing can start (#3477).
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's SQLite handle.
 * @param {{ owner: string, run: () => Promise<any>, id?: string, now?: () => number, renewMs?: number,
 *   say?: (line: string) => void, watch?: { stallAfterMs?: number, lastProgressAt: () => number, stall: (limitMs: number) => void } }} options
 *   run lands the batch and returns the batch engine's result.
 * @returns {Promise<any>} What run returned.
 */
export async function driveLanding(db, { owner, run, id = landingRunJobId(randomUUID()), now = Date.now, renewMs = RENEW_MS, say = () => {}, watch }) {
  const held = bookkeep(() => {
    createJob(db, { id, kind: LANDING_RUN_KIND, now: now() });
    takeJob(db, id, owner, { now: now() });
    writeStep(db, id, 'started', { owner }, { now: now() });
  }, say);
  let stalled = false;
  /** Renew the lease, and end a batch that made no progress for the stall limit. */
  const beat = () => {
    if (held) { try { renewLease(db, id, owner, { now: now() }); } catch { /* the next tick retries */ } }
    const limit = watch?.stallAfterMs ?? LANDING_STALL_MS;
    if (watch && !stalled && now() - watch.lastProgressAt() >= limit) { stalled = true; watch.stall(limit); }
  };
  const heartbeat = held || watch ? setInterval(beat, renewMs) : null;
  heartbeat?.unref?.();
  try {
    const result = await run();
    clearInterval(heartbeat);
    // A batch ended for making no progress (#3186, #3477) fails its run and frees the lease, so the next landing starts.
    if (held && result?.stalled) bookkeep(() => {
      writeStep(db, id, 'failed', { code: 'LAND_STALLED', message: String(result.stallDescription ?? 'the batch made no progress'), ...landingRunSummary(result) }, { now: now() });
      releaseLease(db, id, owner, { now: now() });
    }, say);
    else if (held) bookkeep(() => { writeStep(db, id, 'finished', landingRunSummary(result), { now: now() }); finishJob(db, id, owner, { now: now() }); }, say);
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
