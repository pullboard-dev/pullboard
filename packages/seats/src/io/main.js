/**
 * Seats (B3, H2, V1): who each registered agent is on the board, read from the agent table and the
 * metadata kept beside it: its model, its route, and from engine 48 the seat that created it, whether
 * the relay enrolled it, and its machine lineage. Verifier standing on a linked board (#579) is
 * decided here from that line of creators. board.js registers seats; the store's board queries own the agent readers.
 */
import { Refused } from '../../../kernel/index.js';
import { agentParent } from '../logic/parent.js';

/** The board's coordinator hold travels with its seats: one main checkout coordinates a linked board (#347). */
export { coordinatorHolder } from './hold.js';

/** Save or clear a model label without changing the shared SQLite schema. */
export function saveAgentModel(board, id, model) {
  if (model === null || model === undefined) {
    board.db.prepare('DELETE FROM board_meta WHERE meta_key = ?').run(`agent_model:${id}`);
    return;
  }
  board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value')
    .run(`agent_model:${id}`, model);
}

/**
 * The route an agent joined on; strong for the coordinator and for ids the board does not know.
 *
 * @param {any} board
 * @param {string} agentId
 * @returns {string}
 */
export function routeOf(board, agentId) {
  return board.db.prepare('SELECT agent_route FROM agent WHERE agent_id = ?').get(agentId)?.agent_route ?? 'strong';
}

/**
 * The id an engine-48 registration gives a new seat: the named one when it is the lane's form and
 * free, otherwise the lane's first free number from its count. Skipping taken numbers keeps a named
 * seat from colliding with the next unnamed one.
 *
 * @param {any} board
 * @param {string} lane
 * @param {number} total
 * @param {string | undefined} named
 * @returns {string}
 */
export function newSeatId(board, lane, total, named) {
  if (named === undefined) return firstFreeSeatId(board, lane, total);
  const number = typeof named === 'string' && named.startsWith(`${lane}-`) ? named.slice(lane.length + 1) : '';
  if (!/^[1-9][0-9]{0,8}$/.test(number) || Number(number) <= total || board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(named)) {
    throw new Refused('BAD_SEAT_ID', `a new ${lane} seat is named ${lane}-<n> above the lane's count and not yet taken; register again without a name`);
  }
  return named;
}

/**
 * The lane's first seat number above its count that no seat holds yet.
 *
 * @param {any} board
 * @param {string} lane
 * @param {number} total
 * @returns {string}
 */
function firstFreeSeatId(board, lane, total) {
  let n = total + 1;
  while (board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(`${lane}-${n}`)) n += 1;
  return `${lane}-${n}`;
}

/**
 * The id the next registration in a lane gets when it names none, for a creator that must
 * predict it before sealing the move (the relay receipt names the target seat).
 *
 * @param {any} board
 * @param {string} lane
 * @returns {string}
 */
export function nextSeatId(board, lane) {
  const { total } = board.db.prepare('SELECT COUNT(*) AS total FROM agent WHERE agent_lane = ?').get(lane);
  return firstFreeSeatId(board, lane, total);
}

/**
 * Run board work under linked-board verifier standing (#579): a relay replica replaying an
 * engine-48 move, or a linked CLI previewing one. `root` says whether the acting coordinator's
 * relay credential was set up by the person. Unlinked boards never enter this, so who may verify
 * there is unchanged.
 *
 * @template T
 * @param {any} board
 * @param {{ root: boolean, person?: boolean, lineage?: string | null }} standing
 * @param {() => T} work
 * @returns {T}
 */
export function withVerifierStanding(board, standing, work) {
  const previous = board.verifierStanding;
  board.verifierStanding = { root: standing.root === true, person: standing.person === true,
    lineage: typeof standing.lineage === 'string' ? standing.lineage : null };
  try { return work(); }
  finally {
    if (previous === undefined) delete board.verifierStanding;
    else board.verifierStanding = previous;
  }
}

export { agentParent } from '../logic/parent.js';
export {
  agentCreator,
  seatEnrolled,
  seatLineage,
  standingProblem,
  effectiveAgentParent,
} from '../logic/review/lineage.js';

/** Persist the joined session independently of its parent, so a root and its children share independence. */
export function saveAgentSession(board, id, digest) {
  const key = `agent_session:${id}`;
  const previous = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(key)?.meta_value;
  if (previous && previous !== digest) throw new Refused('PARENT_SESSION_CHANGED', 'this seat already belongs to another session; create a fresh worktree and join there');
  if (!previous) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(key, digest);
}

/** Persist a parent once, preserving author independence across later joins. */
export function saveAgentParent(board, id, digest) {
  const previous = agentParent(board, id);
  if (previous && previous !== digest) throw new Refused('PARENT_SESSION_CHANGED', 'this seat already belongs to another parent session; create a fresh worktree and join there');
  const own = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`agent_session:${id}`)?.meta_value;
  if (!previous && own && own !== digest) throw new Refused('PARENT_SESSION_CHANGED', 'this seat already joined as its own parent session; create a fresh worktree to declare another parent');
  if (!previous) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`agent_parent_session:${id}`, digest);
}
