/**
 * The thin read door for `pullboard list`: the item rows the full command prints, read through the light store and
 * verdict reader alone, never the board barrel (packages/board/index.js through apps/lib/light.js). A bare list
 * paid about 300 ms against a 100 ms bar because the barrel loads about 470 of 746 modules [C7,#9091].
 * Nothing calls this yet; #9089 wires it behind list.thinRead, default off.
 */
import { trunkRef } from '../../../../../packages/sandbox/light.js';
import * as store from '../../../../../packages/store/light.js';
import { mainMergeFor } from '../read.js';
import { verdictProjector } from '../read.js';
import { repoInfo } from '../../../../../packages/git/light.js';
import { hunkFreshnessEnabled } from '../../../../../packages/config/light.js';
import { derivedStateEnabled } from '../../../../../packages/config/light.js';

/**
 * The rows `pullboard list` would print from `cwd`, or null when the full path must run it: no readable board, a
 * board a read must not open (it needs a write or an upgrade), or a read that wants the write path.
 *
 * @param {{ cwd: string, lane?: string, all?: boolean, clock?: any, conflictReader?: () => Promise<Function> }} request - conflictReader loads the merge index's mechanical conflict reader.
 * @returns {Promise<{ items: any[], needsRescope: any[], agents: any[], merging: Set<number> } | null>}
 */
export async function thinListRows({ cwd, lane, all, clock = store.systemClock, conflictReader }) {
  // With health.derivedState on the full path reads the derived-state table for verdict freshness, so the thin door steps aside [C7,#11373].
  if (derivedStateEnabled()) return null;
  const info = repoInfo(cwd);
  const board = store.openBoardForRead(`${info.commonDir}/pullboard/board.sqlite`, clock);
  if (!board) return null;
  if (!board.current || board.drifted) { store.closeBoard(board); return null; }
  try {
    const rows = store.listItems(board, { lane, all });
    // An accept whose only conflict with main is mechanical stays fresh, as on the full path; the caller's reader loads the merge index only when a row is accepted [C7,#11417].
    const residualConflicts = conflictReader && rows.some(row => row.item_status === 'verified') ? await conflictReader() : null;
    const project = verdictProjector(info.root, board, {}, { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem, trunkRef, hunkKeyed: hunkFreshnessEnabled(), residualConflicts }).project;
    const items = rows.map(project);
    const merging = new Set(rows.filter(item => !['verified', 'withdrawn'].includes(item.item_status) && mainMergeFor(board, item.item_id)).map(item => item.item_id));
    return { items, needsRescope: store.allItemsNeedingRescope(board), agents: store.listAgents(board), merging };
  } catch (error) {
    if (error instanceof store.ReadNeedsWrite || store.writeRefused(error) || store.schemaMissing(error)) return null;
    throw error;
  } finally { store.closeBoard(board); }
}
