/** The two callers of the one finish sequence: a hand landing (`pullboard merged`) and a batch landing (`pullboard land`) [C7]. */
import { Refused } from '../../../kernel/index.js';
import { createJob } from '../../../jobs/index.js';
import { isObjectId } from '../../../pin/index.js';
import { LANDING_JOB_KIND } from '../logic/jobs.js';
import { batchLandingJobId } from '../logic/jobs.js';
import { mergedLandingJobId } from '../logic/jobs.js';
import { finishSequence } from './sequence.js';

/**
 * Answer a finish sequence that could not finish with the refusal its code names.
 *
 * @param {{ done: boolean, code?: string, job: { id: string, leaseOwner: string | null } }} result
 * @returns {void}
 */
function requireDone(result) {
  if (result.done) return;
  if (result.code === 'JOB_LEASED') {
    throw new Refused('JOB_LEASED', `landing ${result.job.id} is held by ${result.job.leaseOwner ?? 'another driver'}; it continues from its saved steps when that lease lapses (2 minutes), so run the command again then.`);
  }
  throw new Refused(result.code ?? 'LAND_UNFINISHED', `landing ${result.job.id} stopped before merge; read its steps with pullboard show and land again once its proof is green.`);
}

/**
 * The payloads a finished landing wrote, by step name.
 *
 * @param {{ steps: { name: string, payload: any }[] }} job
 * @returns {Record<string, any>}
 */
function payloads(job) {
  return Object.fromEntries(job.steps.map(step => [step.name, step.payload]));
}

/**
 * Record a hand landing through the finish sequence: the work is already on trunk, so merge answers the commit the
 * caller named and every other step is the caller's own check, record and publish work.
 *
 * Why: `pullboard merged` ran its own sequence in one process, so a run killed between the board record and the
 * code map left no trace of how far it got. As job steps, a rerun with the same items and commit continues from the
 * last written step, and a finished one answers the same commit without recording a second merge (RFC 0008 DJ3, DJ11).
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's SQLite handle.
 * @param {{ repo: string, ids: number[], commit: string, base?: string, owner: string, now?: () => number,
 *   check?: (context: object) => any, record: (context: object) => any, publish?: (context: object) => any }} options
 *   check runs before anything is written and may refuse; record writes the board; publish runs after the record.
 * @returns {Promise<{ commit: string, ids: number[], ran: string[], resumed: boolean, written: Record<string, any> }>}
 */
export async function landMerged(db, { repo, ids, commit, base, owner, now = Date.now, check = () => ({}), record, publish = () => ({}) }) {
  if (!Array.isArray(ids) || !ids.length) throw new Refused('LAND_ITEMS', 'a hand landing names at least one item: pass { ids }.');
  if (!isObjectId(commit)) throw new Refused('LAND_MERGE', 'a hand landing names the full landed commit id: pass { commit }.');
  if (typeof record !== 'function') throw new Refused('LAND_STEP_HANDLER', 'finishSequence needs a record step: pass { record(context) }.');
  const id = mergedLandingJobId(ids, commit);
  createJob(db, { id, kind: LANDING_JOB_KIND, item: ids[0], candidate: commit, base: isObjectId(base) ? base : commit, now: now() });
  const steps = {
    /** The caller's checks, then the items; a refusal here writes nothing. */
    async select(context) { return { items: ids, ...((await check(context)) ?? {}) }; },
    /** The landed commit sits on its own parent. */
    compose: () => ({ candidate: commit, base: isObjectId(base) ? base : commit }),
    /** A hand landing is proved by the caller's checks in select. */
    prove: () => ({ verdict: 'green', proof: 'hand' }),
    /** Idempotent: the merge already happened, so this answers the same commit on every run. */
    merge: () => ({ commit }),
    record,
    publish,
  };
  const result = await finishSequence(db, id, { owner, repo, steps, now });
  requireDone(result);
  const written = payloads(result.job);
  return { commit: written.merge.commit, ids, ran: result.ran, resumed: result.ran.length < result.job.steps.length, written };
}

/**
 * Record a landed batch through the finish sequence, so `pullboard land` and `pullboard merged` share one sequence
 * and the landing writes the tooling pin for its tip.
 *
 * Why: the batch engine already selected, composed, gated, merged and recorded the batch; its landing job keeps
 * those facts as steps keyed by the batch id, so a repeat is a no-op and the merge answers the batch's own tip.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's SQLite handle.
 * @param {{ repo: string, batch: { id: string, tip: string, base?: string, state: string, items?: { id: number }[] },
 *   owner: string, now?: () => number }} options
 * @returns {Promise<{ commit: string, ran: string[] } | null>} Null when the batch did not land.
 */
export async function landBatch(db, { repo, batch, owner, now = Date.now }) {
  if (!batch || batch.state !== 'landed' || !isObjectId(batch.tip)) return null;
  const base = isObjectId(batch.base) ? batch.base : batch.tip;
  const items = (batch.items ?? []).map(entry => entry.id);
  const id = batchLandingJobId(batch.id);
  createJob(db, { id, kind: LANDING_JOB_KIND, item: items[0] ?? null, candidate: batch.tip, base, now: now() });
  const steps = {
    select: () => ({ items, batch: batch.id }),
    compose: () => ({ candidate: batch.tip, base }),
    prove: () => ({ verdict: 'green', proof: 'batch', batch: batch.id }),
    merge: () => ({ commit: batch.tip }),
    record: () => ({ batch: batch.id, items }),
    publish: () => ({}),
  };
  const result = await finishSequence(db, id, { owner, repo, steps, now });
  requireDone(result);
  return { commit: payloads(result.job).merge.commit, ran: result.ran };
}
