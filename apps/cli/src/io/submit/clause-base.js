/** The base-commit run of each [test] clause's named file, recorded on the board before submit judges fail-before [C7,#8090]. */
import { committedTest } from '../../../../../packages/gate/heavy.js';
import { clauseTestFiles } from '../../../../../packages/state/index.js';
import { recordedMainComparison } from './recorded.js';

/**
 * Run each [test] clause's named file at the item's base commit and record its receipt, so the fail-before check has
 * data to judge. A file with a recorded base run is not run again, and a file the base commit lacks cannot fail there,
 * so it is skipped with its reason. Why: nothing produced the base run #8053 reads, so a clause could never prove it
 * failed before the change; recording through the main comparison keeps one run path and one receipt store [C7].
 *
 * @param {string} root - The item folder (any checkout of the repository).
 * @param {object} item - The claimed item row.
 * @param {{ gateFiles: Set<string>, recordedRows: { file: string }[], record?: (receiptId: string) => Promise<void>, onWait?: (state: object) => void }} context - Files the gate will run, base rows already recorded, and the receipt recorder.
 * @param {{ compare?: typeof recordedMainComparison, exists?: typeof committedTest }} [ports] - The comparison and the base-file probe; a test may watch what is run.
 * @returns {Promise<{ ran: string[], skipped: { file: string, reason: string }[] }>}
 */
export async function recordClauseBaseRuns(root, item, { gateFiles, recordedRows, record, onWait }, { compare = recordedMainComparison, exists = committedTest } = {}) {
  const base = item.item_claim_head;
  const ran = [], skipped = [];
  if (!/^[a-f0-9]{40}$/u.test(base ?? '')) return { ran, skipped };
  const have = new Set(recordedRows.map(row => row.file));
  for (const file of clauseTestFiles(item, gateFiles).filter(name => !have.has(name))) {
    if (!exists(root, base, file)) { skipped.push({ file, reason: 'the file does not exist at the base commit' }); continue; }
    try {
      const run = await compare(root, { tests: [{ file, passed: false }] }, onWait, '', { commit: base, detailed: true, onMeasuredReceipt: record });
      if (run.unavailable) skipped.push({ file, reason: run.unavailable }); else ran.push(file);
    } catch (error) { skipped.push({ file, reason: error?.message ?? 'the base run failed' }); }
  }
  return { ran, skipped };
}

/**
 * Record the base runs a claimed item's [test] clauses need, from what the board holds: the item, the base rows already
 * recorded and the files the gate will run. Why: submit's fail-before check reads these rows before the gate queues, so
 * they must exist first; a refusal here is left to that check, which names it [C7].
 *
 * @param {object} ctx - The command context.
 * @param {number} id - The item being submitted.
 * @param {{ withBoard: Function, ordered: Function, resourceAgent: Function, store: object, gateTestFiles: Function, recordMainComparison: Function }} deps - The command's own board ports.
 * @returns {Promise<{ ran: string[], skipped: { file: string, reason: string }[] }>}
 */
export async function recordBaseRunsForSubmit(ctx, id, { withBoard, ordered, resourceAgent, store, gateTestFiles, recordMainComparison }) {
  const root = ctx.info.root;
  const held = withBoard(ctx, board => {
    const item = store.getItem(board, id);
    return item?.item_status === 'claimed' ? { item, rows: store.recordedBaseRows(board, item.item_claim_head) } : null;
  });
  if (!held) return { ran: [], skipped: [] };
  return recordClauseBaseRuns(root, held.item, { gateFiles: gateTestFiles(root, held.item), recordedRows: held.rows,
    record: receiptId => recordMainComparison(ctx, receiptId, { ordered, withBoard, resourceAgent }) });
}
