/**
 * One board rerun of a sharded gate's new reds: when every case a red gate fails is new against main (not a main red,
 * not unknown) and at most three files fail, the board offers one shard job for just those files before the red applies.
 * Why: a red only in files that load-flake on a busy runner went back to a builder whose seat was already gone, and the
 * next builder resubmitted the same commit; a rerun on a quieter moment settles it with no agent [C7,P7].
 */
import { readPayload } from '../../../../jobs/index.js';
import { offerJob } from '../jobs.js';
import { offeredRequest } from '../jobs.js';
import { SHARD_JOB_KIND } from '../jobs.js';
import { queueFor } from '../queue.js';

// Budget: a rerun is for a flake in a few files; a red wider than this is the item's own.
const RETRY_MAX_FILES = 3;

/** Quote one word for a shell, as the gate's planner quotes the files it names. */
function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** The id of the one retry shard of a gate job. */
export function retryShardId(parent) {
  return `${parent}:shard:retry`;
}

/**
 * Offer the one retry shard of a red sharded gate.
 *
 * @param {any} board
 * @param {{ parent: string, combined: Record<string, any>, compared: { cases: { file: string, onMain: boolean | null }[] } | null }} input
 * @returns {{ retried: boolean }} retried is true only when this call offered the shard.
 */
export function retryNewReds(board, { parent, combined, compared }) {
  const cases = compared?.cases ?? [];
  const files = [...new Set(cases.map(row => row.file))];
  if (!cases.length || cases.some(row => row.onMain !== false) || !files.length || files.length > RETRY_MAX_FILES) return { retried: false };
  const { db } = board;
  if (queueFor(board, 'coordinator')) return { retried: false };
  const id = retryShardId(parent);
  if (db.prepare('SELECT 1 FROM job WHERE job_id = ?').get(id)) return { retried: false };
  const first = db.prepare("SELECT job_id, job_item, job_candidate, job_base FROM job WHERE job_kind = ? AND job_id LIKE ? ORDER BY job_created, job_id LIMIT 1").get(SHARD_JOB_KIND, `${parent}:shard:%`);
  const request = first ? offeredRequest(db, first.job_id) : null;
  const plan = db.prepare("SELECT job_step_payload AS payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'receipt' ORDER BY job_step_seq DESC LIMIT 1").get(parent);
  const runner = plan ? readPayload(db, plan.payload)?.receipt?.gate?.proofPlan?.runner : null;
  if (!request?.input?.data || typeof runner !== 'string' || !runner.trim()) return { retried: false };
  const offered = db.prepare("SELECT job_step_payload AS payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered' AND job_step_seq = 0").get(first.job_id);
  const needs = offered ? JSON.parse(offered.payload).needs ?? [] : [];
  const command = `${runner.trim()} ${files.map(file => shellWord('./' + file)).join(' ')}`;
  const { ledger, ...shard } = request.input.data.shard ?? {};
  offerJob(db, { id, kind: SHARD_JOB_KIND, priority: 'gate', needs, item: first.job_item, candidate: first.job_candidate, base: first.job_base,
    request: { ...request, input: { ...request.input, data: { ...request.input.data, shard: { ...shard, index: 1, of: 1, files, command } } } } });
  return { retried: true };
}
