/** Capture one board's release priority before joining the machine resource transaction [C7,V4]. */
import { runnerBoardFile } from '../../../resources/index.js';
// The store's board-read door: the gate-slot path ranks releases without loading the whole store (#4142).
import { openBoardReadOnly } from '../../../store/light.js';
import { boardId } from '../../../store/light.js';
import { listItems } from '../../../store/light.js';
import { milestones } from '../../../store/light.js';
import { localReleaseRank } from '../logic/rank.js';

/**
 * Capture the item's roadmap rank once, without opening or migrating a board for writing.
 * The first unfinished local milestone is current; later milestones follow, then completed earlier
 * milestones, then unplanned work. External references are neither counted nor opened. Board identity joins worktrees and local relay replicas of
 * the same board. A checkout with no board has no release identity and keeps its queue position.
 * Why outside resources.js: remote workers ship only its small trusted runtime, not the board.
 *
 * @param {string} root - The gate caller's checkout.
 * @param {string|number} item - The local item id, or empty for an unplanned run.
 * @returns {{ board: string, rank: number }|undefined}
 */
export function captureReleaseQueue(root, item) {
  if (item === undefined || item === null || item === '') return undefined;
  const file = runnerBoardFile(root);
  if (!file) return undefined;
  const db = openBoardReadOnly(file);
  try {
    const board = { db, clock: { now: () => new Date() } };
    return { board: boardId(board), rank: localReleaseRank(releaseRankInputs(board), item) };
  } finally { db.close(); }
}

/** Read only the canonical roadmap fields that rank local releases, without loading milestone writers.
 * Lease projection changes claimed to open only; both remain unfinished. Roadmap shipping excludes
 * withdrawn local items, retains missing ids, and never resolves external references for queue rank.
 */
function releaseRankInputs(board) {
  const items = new Map(listItems(board, { all: true }).map(item => [item.item_id, item]));
  return milestones(board).map(milestone => ({ items: milestone.items.map(id => ({
    id, status: typeof id === 'number' ? items.get(id)?.item_status ?? 'missing' : 'unavailable',
  })).filter(item => item.status !== 'withdrawn') }));
}

export { localReleaseRank } from '../logic/rank.js';
