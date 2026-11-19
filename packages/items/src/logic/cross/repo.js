/** Foreign prerequisites use only the authenticated receiving board's canonical E32 state [B24,E32,H16]. */
import { boardLinkRecord } from "../../../../kernel/index.js";
import { Refused } from "../../../../kernel/index.js";
import { boardLinkStates } from "../../../../kernel/index.js";
import { foreignDependencies } from "../dependencies.js";

/** The one live signed states link from this board to the child named `repo`, or the cause there is none: 'no link' or 'revoked'. */
function linkFor(board, repo) {
  const own = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get()?.meta_value;
  const rows = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key>=? AND meta_key<? ORDER BY meta_key')
    .all('board_link:', 'board_link;');
  const matches = [];
  let revoked = false;
  for (const row of rows) {
    let record;
    try { record = boardLinkRecord(JSON.parse(row.meta_value)); } catch { continue; }
    if (record.parent.boardId !== own || record.child.handle !== repo) continue;
    if (record.revocation) revoked = true;
    else matches.push(record);
  }
  if (matches.length !== 1) return { cause: revoked && matches.length === 0 ? 'revoked' : 'no link' };
  const record = matches[0];
  if (record.disclosure !== 'states' || record.approvals.length !== 2) return { cause: 'no link' };
  return { record, own };
}

/** Refuse a prerequisite on a repository this board has no live link to, naming pullboard link; items already filed stay readable [XB1]. */
export function requireLinkedForeign(board, after) {
  for (const ref of foreignDependencies(after)) {
    const { cause } = linkFor(board, ref.repo);
    if (cause) throw new Refused('FOREIGN_UNLINKED', `${ref.repo}#${ref.id} names a repository this board has no live link to (${cause})`, `pullboard link ${ref.repo}`);
  }
}

/** Resolve one repository against current signed links, never local paths or a submitter status; a failure names its cause: 'no link', 'revoked' or 'no state yet'. */
function stateFor(board, ref, readReceivedBoardState) {
  const found = linkFor(board, ref.repo);
  if (found.cause) return { cause: found.cause };
  const { record, own } = found;
  let state;
  try { state = readReceivedBoardState(board, { linkId: record.linkId, generation: record.generation, sourceBoardId: record.child.boardId }); }
  catch { return { cause: 'no state yet' }; }
  if (!state || state.sourceBoardId !== record.child.boardId || state.destinationBoardId !== own
    || state.linkId !== record.linkId || state.generation !== record.generation || state.disclosure !== 'states'
    || !Number.isSafeInteger(state.position) || state.position < 0 || !Array.isArray(state.rows)) return { cause: 'no state yet' };
  const items = state.rows.filter(row => row.board === record.child.boardId && row.id === ref.id);
  if (items.length !== 1 || !boardLinkStates(2).includes(items[0].state)) return { cause: 'no state yet' };
  return { board: record.child.boardId, status: items[0].state, announced: state.version };
}

/** Missing, ambiguous, stale-generation or undisclosed foreign state stays an explicit blocker. */
export function foreignDependencyStates(board, item, { readReceivedBoardState }) {
  return foreignDependencies(item).map(ref => {
    const state = stateFor(board, ref, readReceivedBoardState);
    return state.cause ? { ...ref, status: 'unavailable', cause: state.cause } : { ...ref, ...state };
  });
}

/** Every foreign prerequisite must be verified on its owning board's current authenticated announcement; a withdrawn one carries a hold reason, never a silent blocker [XB1]. */
export function foreignBlockers(board, item, ports) {
  return foreignDependencyStates(board, item, ports).filter(ref => ref.status !== 'verified').map(ref => (ref.status === 'withdrawn'
    ? { ...ref, hold: `${ref.repo}#${ref.id} was withdrawn on its own board; the person rules: rebuild it, withdraw this item or relink` }
    : ref));
}
