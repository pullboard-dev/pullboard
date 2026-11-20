/** A sprint landing's exact-tree record rides its landed batch, and landing.exactTreeCheck refuses a receipt without a green one [V38,#12179]. */
import { createHash } from 'node:crypto';
import { itemPace } from '../../../../store/index.js';
import { logEvent } from '../../../../store/index.js';

/**
 * Read a land receipt's exact-tree record when it landed a sprint item: the record carries the sha256 digest of the job's sprint
 * static and test commands as commandsDigest. A steady or strict item reads nothing and writes nothing here.
 * With the check on and no green record for a sprint item, a blocked batch naming why is written and `refused` is true.
 * `landed(merged)` writes the landed batch carrying the record when a sprint item was merged.
 * @param {any} board
 * @param {{ job: string, receipt: Record<string, any>, offered: Record<string, any>, items: Array<{ id: number, item: any }>, enabled?: boolean }} landing
 * @returns {{ refused: boolean, landed: (merged: number[]) => void }}
 */
export function exactTreeGate(board, { job, receipt, offered, items, enabled }) {
  const sprinted = items.filter(({ item }) => itemPace(item) === 'sprint').map(({ id }) => id);
  if (!sprinted.length) return { refused: false, landed() {} };
  const commands = JSON.stringify({ static: offered.payload?.sprint?.static ?? null, testCommand: offered.payload?.sprint?.testCommand ?? null });
  const record = receipt.exactTree && typeof receipt.exactTree === 'object' ? { ...receipt.exactTree, commandsDigest: createHash('sha256').update(commands).digest('hex') } : null;
  const batch = state => ({ id: job, state, items: items.map(({ id }) => ({ id })), tip: receipt.trunk, ...(record ? { exactTree: record } : {}) });
  if (enabled === true && record?.result !== 'green') {
    const message = `landing.exactTreeCheck is on and land job ${job} carries ${record ? `a ${record.result ?? 'not green'} exact-tree record` : 'no exact-tree record'} for sprint item ${sprinted.map(id => `#${id}`).join(', ')}; the items stay unmerged`;
    logEvent(board, 'coordinator', 'landing_batch', null, { batch: { ...batch('blocked'), refusal: { code: 'LAND_EXACT_TREE', message } } });
    return { refused: true, landed() {} };
  }
  return { refused: false, landed(merged) { if (record && merged.some(id => sprinted.includes(id))) logEvent(board, 'coordinator', 'landing_batch', null, { batch: { ...batch('landed'), items: merged.map(id => ({ id })) } }); } };
}
