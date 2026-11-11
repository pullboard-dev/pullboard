/** The hook-time reminder of committed work a seat has not submitted [I6,C7]. */
import { join } from 'node:path';
import * as store from '../../../../packages/store/index.js';
import { openBoardForRead } from '../logic/native.js';

/**
 * Warn only when committed work has advanced beyond this seat's recorded claim head.
 * Why: the git facts arrive as ports so this library file imports no git cell and the CLI owns the process work.
 *
 * @param {{ root: string, commonDir: string, head: string|null, advanced: (claimHead: string) => boolean }} ports - The checkout, its head, and whether work moved on from a claim head.
 * @param {{ write: (text: string) => unknown }} out - Where the reminder goes.
 */
export function warnUnsubmittedWork({ root, commonDir, head, advanced }, out = process.stdout) {
  const board = openBoardForRead(join(commonDir, 'pullboard', 'board.sqlite'));
  if (!board) return;
  try {
    const agent = store.agentAt(board, root);
    if (!agent || !head) return;
    const items = store.listItems(board, { all: true }).filter(item => item.item_status === 'claimed'
      && item.item_owner === agent.agent_id && item.item_claim_head && item.item_claim_head !== head
      && advanced(item.item_claim_head));
    if (items.length) out.write(`Committed work on ${items.map(item => '#' + item.item_id).join(', ')} is not submitted. Run pullboard submit <id> --wait when it is ready.\n`);
  } finally { store.closeBoard(board); }
}
