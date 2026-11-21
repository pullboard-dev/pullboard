/** A claimed item whose newest gate settled unknown goes to review once main's receipts excuse every red file [C7,P7,DJ2]. */
import * as store from '../../../../store/index.js';
import { appendNote } from '../../../../jobs/index.js';
import { queueFor } from '../queue.js';
import { mainRedFileExcuse } from './main-red-files.js';

/** The rule the move names in its settled note and gate_settled event. */
export const UNKNOWN_TO_REVIEW_RULE = 'gate.unknownToReview';

/** Limit candidate items examined per maintenance tick, including items without an unknown gate. */
const BATCH_SIZE = 8;

/** The newest note:shards.settled payload of a gate job, or null. */
function settledNote(db, job) {
  const row = db.prepare("SELECT job_step_payload AS payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'note:shards.settled' ORDER BY job_step_id DESC LIMIT 1").get(job);
  try { return row ? JSON.parse(row.payload) : null; } catch { return null; }
}

/** Every file a red phase of the receipt names in its failing cases. */
function redFiles(receipt) {
  return [...new Set((receipt?.gate?.phases ?? []).filter(phase => phase.status !== 0)
    .flatMap(phase => [...(phase.failures ?? []), ...(phase.errors ?? [])]).map(row => row?.file).filter(file => typeof file === 'string'))];
}

/**
 * In one bounded pass, hand each claimed item whose newest gate job's newest settled note says unknown to review, when its shards' combined
 * receipt is green, or every red file is one main fails at the same input key (mainRedFileExcuse) and none is a file the
 * item's own diff touches. The combined receipt re-applies through applyGateReceipt with the main-red file excuse on, so
 * the item is submitted as any excused gate is; then one settled note and one gate_settled event naming the rule are
 * appended, and no earlier step or event changes [DJ2]. A red the excuse does not cover leaves the item with its builder.
 * Why: an unknown gate held its builder's claim, next --verify offers only submitted items and the lander waits on a
 * review, so 27 of 45 claimed items sat finished and never landed (20 Nov); settleWaitingGates re-applies an unknown gate
 * only when every case keys at the gate's own main, which a receipt recorded at a later main never does [C7,#12569].
 *
 * @param {any} board
 * @param {Record<string, any>} ports - applyGateReceipt's ports; excuseMainRedFiles is forced on for the re-apply.
 * @param {{ now?: number, after?: number }} options
 * @param {{ latestGateJob: Function, offeredGate: Function, postedReceipt: Function, shardedResult: Function, applyGateReceipt: Function }} gate
 * @returns {{ after: number, moved: { job: string, item: number, outcome: string }[] }} the next cursor and re-applied gates
 */
export function handUnknownGatesToReview(board, ports, { now = Date.now(), after = 0 } = {}, gate) {
  if (queueFor(board, 'coordinator')) return { after: 0, moved: [] };
  const { db } = board;
  const rows = db.prepare(`SELECT item_id, item_owner FROM item
    WHERE item_status = 'claimed' AND item_id > ? AND item_owner IS NOT NULL
    ORDER BY item_id LIMIT ?`).all(after, BATCH_SIZE);
  const moved = [];
  for (const { item_id: item, item_owner: owner } of rows) {
    const job = gate.latestGateJob(db, item);
    if (!job || settledNote(db, job)?.outcome !== 'unknown') continue;
    const offered = gate.offeredGate(db, job);
    if (offered?.submit?.agentId !== owner) continue;
    const posted = gate.postedReceipt(db, job)?.receipt;
    const combined = posted?.gate?.proofPlan ? gate.shardedResult(db, job, posted) : posted;
    if (!combined?.gate || combined.gate.proofPlan) continue;
    const green = combined.status === 0 && combined.gate.green === true;
    const touched = new Set(offered.submit.files ?? []);
    const excused = green ? [] : mainRedFileExcuse(board, combined);
    if (!excused || redFiles(combined).some(file => touched.has(file))) continue;
    let applied;
    try { applied = gate.applyGateReceipt(board, { job, receipt: combined }, { ...ports, excuseMainRedFiles: true }); }
    catch (error) { if (!error?.code) throw error; continue; } // a coded refusal leaves the claim as it was; a later maintenance pass tries again
    if (applied?.outcome !== 'review') { moved.push({ job, item, outcome: applied?.outcome ?? 'none' }); continue; }
    const files = excused.map(row => row.file);
    store.atomic(board, () => {
      // A new row past the newest seq, never an update of the unknown note: the job's steps stay append-only [DJ2].
      appendNote(db, job, 'shards.settled', { outcome: 'review', rule: UNKNOWN_TO_REVIEW_RULE, ...(files.length ? { mainRedExcused: files } : {}) }, now);
      store.logEvent(board, 'coordinator', 'gate_settled', item, { job, outcome: green ? 'green' : 'red', class: green ? 'item' : 'main-red', rule: UNKNOWN_TO_REVIEW_RULE });
    });
    moved.push({ job, item, outcome: 'review' });
  }
  return { after: rows.length === BATCH_SIZE ? rows.at(-1).item_id : 0, moved };
}
