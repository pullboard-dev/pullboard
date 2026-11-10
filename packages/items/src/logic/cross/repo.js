/** Foreign prerequisites use only the authenticated receiving board's canonical E32 state [B24,E32,H16]. */
import { boardLinkRecord } from "../../../../kernel/index.js";
import { foreignDependencies } from "../dependencies.js";

/** Resolve one repository against current signed links, never local paths or a submitter status. */
function stateFor(board, ref, readReceivedBoardState) {
  const own = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get()?.meta_value;
  const rows = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key>=? AND meta_key<? ORDER BY meta_key')
    .all('board_link:', 'board_link;');
  const matches = [];
  for (const row of rows) {
    let record;
    try { record = boardLinkRecord(JSON.parse(row.meta_value)); } catch { continue; }
    if (record.parent.boardId === own && record.child.handle === ref.repo && !record.revocation) matches.push(record);
  }
  if (matches.length !== 1) return null;
  const record = matches[0];
  if (record.disclosure !== 'states' || record.approvals.length !== 2) return null;
  let state;
  try { state = readReceivedBoardState(board, { linkId: record.linkId, generation: record.generation, sourceBoardId: record.child.boardId }); }
  catch { return null; }
  if (!state || state.sourceBoardId !== record.child.boardId || state.destinationBoardId !== own
    || state.linkId !== record.linkId || state.generation !== record.generation || state.disclosure !== 'states'
    || !Number.isSafeInteger(state.position) || state.position < 0 || !Array.isArray(state.rows)) return null;
  const items = state.rows.filter(row => row.board === record.child.boardId && row.id === ref.id);
  if (items.length !== 1 || !['open', 'claimed', 'submitted', 'verified', 'withdrawn'].includes(items[0].state)) return null;
  return { board: record.child.boardId, status: items[0].state };
}

/** Missing, ambiguous, stale-generation or undisclosed foreign state stays an explicit blocker. */
export function foreignDependencyStates(board, item, { readReceivedBoardState }) {
  return foreignDependencies(item).map(ref => {
    const state = stateFor(board, ref, readReceivedBoardState);
    return { ...ref, ...state, status: state?.status ?? 'unavailable' };
  });
}

/** Every foreign prerequisite must be verified on its owning board's current authenticated announcement. */
export function foreignBlockers(board, item, ports) {
  return foreignDependencyStates(board, item, ports).filter(ref => ref.status !== 'verified');
}
