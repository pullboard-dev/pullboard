/**
 * Gate receipts the board recorded but never applied to their item [C7,P7].
 *
 * Why: a runner's receipt post records the receipt and marks the job done in one transaction, then applies it to the
 * item in later writes. When that apply throws (a board write busy past its timeout under load, a crash, any refusal),
 * the job reads done, the item stays claimed, and nothing on its thread says why; the runner's retry finds the receipt
 * already recorded and applies nothing, so verify refuses NOT_SUBMITTED for good. The board offers these again.
 */

/** Budget: a receipt younger than this may still be mid-apply in another request, so it is left to that request. */
export const STRANDED_RECEIPT_AGE_MS = 30_000;

/** Budget: how far back a stranded receipt is looked for, and how many one claim call re-applies. */
const STRANDED_WINDOW_MS = 7 * 24 * 3_600_000;
const STRANDED_LIMIT = 20;

/**
 * The done gate jobs whose receipt never reached their item: the item's newest gate job, its item still claimed, no
 * thread fact naming the job (every applied outcome writes one or moves the item), and no shard plan still running.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ now: number }} options
 * @returns {{ job: string, receipt: Record<string, any> }[]}
 */
export function strandedGateReceipts(db, { now }) {
  const rows = db.prepare(`SELECT job.job_id, job.job_item FROM job JOIN item ON item.item_id = job.job_item
    WHERE job.job_kind = 'gate' AND job.job_step = 'done' AND item.item_status = 'claimed' AND job.job_updated BETWEEN ? AND ?
    AND job.job_id = (SELECT newest.job_id FROM job AS newest WHERE newest.job_kind = 'gate' AND newest.job_item = job.job_item ORDER BY newest.job_created DESC, newest.rowid DESC LIMIT 1)
    ORDER BY job.job_updated DESC LIMIT ?`).all(now - STRANDED_WINDOW_MS, now - STRANDED_RECEIPT_AGE_MS, STRANDED_LIMIT);
  const named = db.prepare("SELECT 1 FROM event WHERE item_id = ? AND event_kind = 'fact' AND instr(event_detail, ?) > 0 LIMIT 1");
  const posted = db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'receipt' ORDER BY job_step_seq DESC LIMIT 1");
  const found = [];
  for (const { job_id: job, job_item: item } of rows) {
    if (named.get(item, `Gate job ${job} `)) continue;
    const row = posted.get(job);
    const receipt = row ? JSON.parse(row.job_step_payload)?.receipt : null;
    // A sharded gate waits on its shards; the last shard's receipt applies it.
    if (receipt && !receipt.gate?.proofPlan) found.push({ job, receipt });
  }
  return found;
}
