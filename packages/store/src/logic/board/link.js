/** Read the exact native E32 receiving projection without loading the network sender [E32,B24,H16]. */
import { Refused } from "../../../../kernel/light.js";
import { boardLinkName } from "../../../../kernel/index.js";
import { boardReferenceId } from "../../../../kernel/index.js";

/** Read detached canonical state installed by authenticated receiveBoardState, never a caller snapshot. */
export function readReceivedBoardState(board, { linkId, generation, sourceBoardId }) {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Refused('BOARD_LINK_FORMAT', 'use a positive link generation');
  const key = `board_link_state:${boardLinkName(linkId)}:${generation}:${boardReferenceId(sourceBoardId)}`;
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key);
  return row ? JSON.parse(row.meta_value) : null;
}
