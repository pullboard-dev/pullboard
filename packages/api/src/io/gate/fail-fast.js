/** The gate's fail-fast move: an item-owned red shard ends the gate's other open shards unrun [C7,P7]. */
import { readPayload } from '../../../../jobs/index.js';
import { endJobs } from '../jobs.js';
import { retryShardId } from './retry.js';

/**
 * The detail of a shard job's withdrawn step, or null when it was never withdrawn. Why: a shard ended unrun (endStaleShardOffers)
 * posts no receipt, and its gate's red should say why it ended and what to do, not only that no proof phase ran (#12166).
 */
function endedDetail(db, job) {
  const row = db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'withdrawn' ORDER BY job_step_id DESC LIMIT 1").get(job);
  if (!row) return null;
  try { const detail = readPayload(db, row.job_step_payload)?.detail; return typeof detail === 'string' && detail ? detail : null; } catch { return null; }
}

/**
 * With gate.failFastShards on, a shard that posts red where every failing case is the item's own (the shard is a job error, or each failing case
 * is not on main) ends the gate's other open shard jobs unrun, so the red applies now and no runner spends minutes on shards the red already decided.
 * A red only in cases main also fails ends nothing; the gate waits for the rest as before. The gate's readers come in as `gate`, as the gate module sits above this one.
 *
 * @returns {string[]} The shard jobs ended.
 */
export function endShardsOnItemRed(board, { parent, job, ports }, gate) {
  if (job === retryShardId(parent)) return [];
  const gateReceipt = gate.postedReceipt(board.db, parent)?.receipt;
  const posted = gate.postedReceipt(board.db, job);
  if (!gateReceipt?.gate?.proofPlan || !posted) return [];
  const shardGate = posted.receipt?.gate ?? {};
  if (posted.receipt?.status === 0 && shardGate.green === true && (shardGate.phases ?? []).find(row => row.role === 'proof')?.status === 0) return [];
  let own = Boolean(shardGate.error);
  if (!own) {
    const one = gate.combinedReceipt(gateReceipt, [{ job, posted }], { signatures: ports.settleOnMainReceipt === true });
    const compared = gate.compareGateWithMain(board, one, gate.offeredGate(board.db, parent)?.main, ports.compareWithMain ?? null);
    own = Boolean(compared?.cases.length) && compared.cases.every(row => row.onMain === false);
  }
  if (!own) return [];
  const open = gate.shardJobs(board.db, parent).filter(row => row.job_step !== 'done' && row.job_id !== job).map(row => row.job_id);
  return endJobs(board.db, open, { reason: `ended unrun: shard ${job} posted a red in the item's own cases, so the gate applies that red now; resubmit runs the full gate again`, now: Number.isFinite(ports.receiptNow) ? ports.receiptNow : Date.now() });
}
