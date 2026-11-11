/** A posted gate-job receipt becomes its item's gate result on the board: green submits the item for review, red hands it back to its builder [P7]. */
import * as store from '../../../store/index.js';
import { jobQueueCall } from './jobs.js';

const PROJECT_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0\n\r]{1,4096}$/u;
// Budget: a red's failing parts are named one line each, bounded so a fact stays a readable record.
const PART_TEXT = 600;

/** The newest gate job offered for an item, so an older candidate's receipt reads as stale. */
function latestGateJob(db, item) {
  return db.prepare("SELECT job_id FROM job WHERE job_kind = 'gate' AND job_item = ? ORDER BY job_created DESC, rowid DESC LIMIT 1").get(item)?.job_id ?? null;
}

/** The job's kind, item, candidate, base and the submit fields its offer recorded; null when the job is gone. */
function offeredGate(db, job) {
  const row = db.prepare(`SELECT job.job_kind, job.job_item, job.job_candidate, job.job_base, step.job_step_payload FROM job JOIN job_step AS step
    ON step.job_step_job = job.job_id AND step.job_step_name = 'offered' AND step.job_step_seq = 0 WHERE job.job_id = ?`).get(job);
  if (!row) return null;
  const request = JSON.parse(row.job_step_payload).request ?? null;
  return { kind: row.job_kind, item: row.job_item, candidate: row.job_candidate, main: row.job_base, submit: request?.submit ?? null };
}

/** One line per part that failed: analysis refusals, red phases with their output's tail, or the job's own error. */
export function failingParts(receipt) {
  const gate = receipt?.gate ?? {};
  const clip = text => String(text ?? '').replace(/\s+/gu, ' ').trim().slice(-PART_TEXT);
  const parts = [];
  if (gate.error) parts.push(`gate: ${clip(gate.error)}`);
  if (gate.analysis?.infra) parts.push(`infrastructure: ${clip(typeof gate.analysis.infra === 'string' ? gate.analysis.infra : JSON.stringify(gate.analysis.infra))}`);
  for (const refusal of gate.analysis?.refusals ?? []) parts.push(`${refusal.part} ${refusal.code ?? 'REFUSED'}: ${clip(refusal.message)}`);
  for (const phase of gate.phases ?? []) if (phase.status !== 0) parts.push(`${phase.role} exited ${phase.status ?? phase.signal}: ${clip(phase.tail)}`);
  if (!parts.length && receipt?.status !== 0) parts.push(`the gate job exited ${receipt?.status ?? receipt?.signal}`);
  return parts;
}

/**
 * Apply one newly recorded gate-job receipt to its item. The receipt counts only while it is for the item's current
 * candidate: the newest gate job offered for the item, its source, still claimed by the seat that submitted it at the
 * same frozen bar. Anything else is stale: the receipt stays recorded on the job and the item is left as it is.
 *
 * Green records the item's submission at the candidate, as a green submit would, so it routes to review. Red keeps the
 * item claimed by its builder, records the failing parts on its thread and shouts them to the builder.
 *
 * Why here: the receipt is the gate's result, and the board host only writes rows; it starts no process and no gate.
 *
 * @param {any} board - The open board, with gitRoot set when the board host holds the repository.
 * @param {{ job: string, receipt: Record<string, any> }} posted
 * @returns {{ applied: boolean, outcome: 'review' | 'red' | 'stale' | 'not-gate', reason?: string }}
 */
export function applyGateReceipt(board, { job, receipt }) {
  const offered = offeredGate(board.db, job);
  if (!offered || offered.kind !== 'gate' || !Number.isSafeInteger(offered.item)) return { applied: false, outcome: 'not-gate' };
  const { item: id, candidate, main, submit } = offered;
  const item = store.getItem(board, id);
  const stale = !submit ? 'the job carries no submit record'
    : latestGateJob(board.db, id) !== job ? 'a newer gate job was offered for this item'
    : receipt?.gate?.source !== undefined && receipt.gate.source !== candidate ? 'the receipt judged another source'
    : item?.item_status !== 'claimed' || item.item_owner !== submit.agentId ? 'the item is no longer claimed by the seat that submitted it'
    : item.item_frozen_digest !== submit.digest ? 'the item\'s bar was refrozen since the submit' : null;
  if (stale) return { applied: false, outcome: 'stale', reason: stale };
  const green = receipt?.status === 0 && receipt?.gate?.green === true;
  let parts = failingParts(receipt);
  if (green) {
    const files = Array.isArray(receipt.gate.analysis?.proofFiles) ? receipt.gate.analysis.proofFiles.filter(file => typeof file === 'string' && PROJECT_FILE.test(file)) : [];
    try {
      store.submit(board, id, { agentId: submit.agentId, commit: candidate, tree: submit.tree, files: submit.files ?? [], policyCommit: main, gateGreen: true,
        submissionProof: { version: 1, files, full: false, deferred: false, reason: `pulled gate job ${job}` } });
      store.appendFact(board, id, { agentId: submit.agentId, kind: 'note', text: `Gate job ${job} green at ${candidate.slice(0, 12)} on main ${String(main).slice(0, 12)}; submitted for review.` });
      return { applied: true, outcome: 'review' };
    } catch (error) {
      // A green gate whose submission the board refuses goes back to the builder with the refusal, never lost in a log.
      if (!error?.code) throw error;
      parts = [`submit ${error.code}: ${error.message}`];
    }
  }
  store.appendFact(board, id, { agentId: submit.agentId, kind: 'measurement', text: `Gate job ${job} ${green ? 'green but not submitted' : 'red'} at ${candidate.slice(0, 12)}; failing parts:\n${parts.join('\n')}` });
  // The shout only wakes the builder; the fact above is the record, so a refused shout leaves the red recorded.
  try {
    store.shout(board, { from: 'coordinator', to: submit.agentId, lanes: [], item: id,
      text: `#${id} gate red at ${candidate.slice(0, 7)}: ${parts[0] ?? 'see pullboard show'}`.slice(0, 280) });
  } catch (error) { if (error?.code === undefined) throw error; }
  return { applied: true, outcome: 'red' };
}

/**
 * Answer one job queue call on an open board, applying each newly recorded receipt to it: the board API's jobs route.
 *
 * @param {any} board - The open board, gitRoot set to the board host's repository.
 * @param {Record<string, any>} body
 * @param {Parameters<typeof jobQueueCall>[2]} options
 */
export function boardJobQueueCall(board, body, options) {
  return jobQueueCall(board.db, body, { ...options, onReceipt: posted => applyGateReceipt(board, posted) });
}
