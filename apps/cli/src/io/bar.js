import { stripPerItemFullSuiteCriterion } from '../../../../packages/items/index.js';
import { COORDINATOR } from '../../../../packages/config/index.js';
import { Refused } from '../../../../packages/kernel/index.js';

const ACTIVE = new Set(['open', 'claimed', 'submitted']);
const REASON = 'S10 full-suite strip';

/** Apply the one-time S10 cleanup using the native ordered edit for each candidate. */
export async function sweepFullSuiteBars({ board, agent, listItems, edit }) {
  if (agent !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator can sweep item bars');
  const changed = [];
  const skipped = [];
  for (const item of listItems(board, { all: true })) {
    if (!ACTIVE.has(item.item_status)) continue;
    const result = stripPerItemFullSuiteCriterion(item.item_criterion);
    if (!result.removed.length) continue;
    if (!result.criterion) {
      skipped.push({ id: item.item_id, code: 'EMPTY_CRITERION', reason: 'removing the out-of-scope sentence would leave no criterion' });
      continue;
    }
    try {
      await edit(item.item_id, {
        agentId: agent,
        criterion: result.criterion,
        reason: REASON,
        preserveFrozen: true,
      });
      changed.push({ id: item.item_id, removed: result.removed });
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      skipped.push({ id: item.item_id, code: error.code, reason: error.message });
    }
  }
  return { changed, skipped };
}
