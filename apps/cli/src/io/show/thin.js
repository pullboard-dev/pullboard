/**
 * The thin read door for `pullboard show`: a plain item's facts (the item, the seats and its history), read through the
 * light store and verdict reader alone, never the board barrel. Any item whose show also reads a receipt, a refusal, the
 * thread, typed fields, related links, an after-gate list, a submit or a foreign wait steps aside for the full path,
 * which keeps those heavy sections [C7,#12412].
 * Nothing calls this yet; the next slice wires it.
 */
import { trunkRef } from '../../../../../packages/sandbox/light.js';
import * as store from '../../../../../packages/store/light.js';
import { verdictProjector } from '../read.js';
import { dependencyReferences } from '../../../../../packages/items/light.js';
import { repoInfo } from '../../../../../packages/git/light.js';
import { hunkFreshnessEnabled } from '../../../../../packages/config/light.js';
import { derivedStateEnabled } from '../../../../../packages/config/light.js';

/** The event kinds whose presence makes the full show print a refusal, a thread entry, a submit or a proof receipt. */
const HEAVY_KINDS = new Set(['fact', 'note', 'comment', 'reject', 'reopen', 'release', 'reject_returned', 'submit_handoff_returned', 'submit', 'proof-run']);

/** Whether `table` has any row for the item under `column`; a board without the table has none. */
function hasRows(board, table, column, id) {
  const made = board.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return Boolean(made) && Boolean(board.db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(id));
}

/**
 * The facts `pullboard show <id>` would print for a plain item, or null when the full path must run it: no readable
 * board, a drifted board, an unknown item, or an item carrying any heavy section.
 *
 * @param {{ cwd: string, id: number, clock?: any, conflictReader?: () => Promise<Function> }} request - conflictReader loads the merge index's mechanical conflict reader.
 * @returns {Promise<{ item: any, agents: any[], history: any[] } | null>}
 */
export async function thinShowFacts({ cwd, id, clock = store.systemClock, conflictReader }) {
  // With health.derivedState on the full path reads the derived-state table for verdict freshness, so the thin door steps aside [C7,#11373].
  if (derivedStateEnabled()) return null;
  const info = repoInfo(cwd);
  const board = store.openBoardForRead(`${info.commonDir}/pullboard/board.sqlite`, clock);
  if (!board) return null;
  if (!board.current || board.drifted) { store.closeBoard(board); return null; }
  try {
    // An id the board does not hold is the full path's NO_ITEM refusal to word, so the door steps aside for it.
    let stored;
    try { stored = store.getItem(board, id); } catch (error) { if (error?.code === 'NO_ITEM') return null; throw error; }
    if (!stored || stored.item_merged_commit) return null;
    const history = store.events(board, { itemId: id });
    if (history.some(event => HEAVY_KINDS.has(event.event_kind)) || store.proofReceipts(board, id).length > 0) return null;
    if (hasRows(board, 'item_field', 'item_id', id) || hasRows(board, 'item_related', 'item_low', id) || hasRows(board, 'item_related', 'item_high', id)) return null;
    if (board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key = ?').get(`after_gate:${id}`)) return null;
    if (stored.item_after && dependencyReferences(stored).some(ref => ref.kind !== 'local')) return null;
    if (store.submitHandoff(board, id)) return null;
    // An accept whose only conflict with main is mechanical stays fresh, as on the full path; the caller's reader loads the merge index only for an accepted item [C7,#11417].
    const residualConflicts = conflictReader && stored.item_status === 'verified' ? await conflictReader() : null;
    const item = verdictProjector(info.root, board, {}, { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem, trunkRef, hunkKeyed: hunkFreshnessEnabled(), residualConflicts }).project(stored);
    const meta = key => board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`${key}:${id}`);
    const failureLines = meta('main_red_failure_lines');
    if (failureLines) item.main_red_failure_lines = JSON.parse(failureLines.meta_value);
    if (meta('item_check_timing')?.meta_value === 'true') item.item_check_timing = true;
    const landingPhases = meta('landing_phases');
    if (landingPhases) item.landing_phases = JSON.parse(landingPhases.meta_value);
    return { item, agents: store.listAgents(board), history };
  } catch (error) {
    if (error instanceof store.ReadNeedsWrite || store.writeRefused(error) || store.schemaMissing(error)) return null;
    throw error;
  } finally { store.closeBoard(board); }
}
