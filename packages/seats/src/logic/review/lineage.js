/** Native seat identity and verifier-standing readers do not load registration or board writers [C7,V1,H16]. */
import { agentParent } from '../parent.js';
import { COORDINATOR } from '../../../../config/index.js';
import {
  ENGINE_VERSION,
  VERIFIER_STANDING_ENGINE,
} from '../../../../state/index.js';
import { Refused } from '../../../../kernel/light.js';

/**
 * The seat that created this one, as its engine-48 registration recorded it: an agent id,
 * `machine` for a join no seat made, or null for a seat registered before engine 48.
 *
 * @param {any} board
 * @param {string} id
 * @returns {string | null}
 */
export function agentCreator(board, id) {
  return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`agent_creator:${id}`)?.meta_value ?? null;
}

/**
 * Whether a relay replica enrolled this seat from its creator's receipt-bound registration (#579).
 *
 * @param {any} board
 * @param {string} id
 * @returns {boolean}
 */
export function seatEnrolled(board, id) {
  return Boolean(board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key = ?').get(`agent_enrolled:${id}`));
}

/**
 * The machine registration lineage a relay-enrolled seat descends from: the person-set coordinator
 * token of the machine that made its line (#579), or null when it was never recorded.
 *
 * @param {any} board
 * @param {string} id
 * @returns {string | null}
 */
export function seatLineage(board, id) {
  return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`agent_lineage:${id}`)?.meta_value ?? null;
}

/**
 * Why this seat may not verify the builder's item on a linked board, or null when it may. The
 * seat's creators are walked up to the coordinator: the builder, a join no seat made (`machine`),
 * or a seat registered before engine 48 anywhere on the way means no standing. The coordinator
 * stands only on a credential the person set up.
 *
 * @param {any} board
 * @param {string} verifier
 * @param {string} builder
 * @param {number} itemId
 * @returns {Refused | null}
 */
export function standingProblem(board, verifier, builder, itemId) {
  const standing = board.verifierStanding;
  if (!standing || (board.executionEngineVersion ?? ENGINE_VERSION) < VERIFIER_STANDING_ENGINE) return null;
  const refuse = (why) => new Refused('VERIFIER_STANDING',
    `${verifier} cannot verify work built by ${builder} on this linked board: ${why}; ask the coordinator to make an independent verifier from the main checkout: pullboard worktree <lane> --model "<model name>"`);
  if (builder === COORDINATOR) {
    // The person stands above every seat; otherwise only a seat from another machine's line may.
    if (standing.person) return null;
    const refuseOwn = (why) => new Refused('VERIFIER_STANDING', `${verifier} cannot verify work the coordinator built on this linked board: ${why}; a seat from another machine's registration lineage, or the person, verifies it`);
    const built = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`item_lineage:${itemId}`)?.meta_value ?? null;
    const lineage = seatLineage(board, verifier);
    if (!built || !lineage) return refuseOwn('the machine lineage of the build or of this seat was not recorded');
    if (built === lineage) return refuseOwn('this seat shares the building machine\'s registration lineage');
    for (let seat = verifier, seen = new Set(); seat !== COORDINATOR; seat = agentCreator(board, seat)) {
      if (seen.has(seat) || !seatEnrolled(board, seat)) return refuseOwn(`${seat} was not enrolled through the relay`);
      seen.add(seat);
    }
    return null;
  }
  const seen = new Set();
  for (let seat = verifier; ;) {
    if (seat === COORDINATOR) {
      return standing.root || seat !== verifier ? null
        : refuse('the coordinator credential was not set up by the person; run pullboard relay on in the main checkout once');
    }
    if (seen.has(seat)) return refuse('its line of creating seats loops');
    seen.add(seat);
    const creator = agentCreator(board, seat);
    if (creator === 'machine') return refuse(`${seat} joined without a creating seat`);
    if (creator === builder) return refuse(`${seat} was created by the builder`);
    if (creator === null || !seatEnrolled(board, seat)) {
      return refuse(`${seat} was not enrolled by its creating seat through the relay`);
    }
    seat = creator;
  }
}

/** A root session is its own parent, even while its missing parent is displayed as unknown. */
export function effectiveAgentParent(board, id) {
  return agentParent(board, id)
    ?? board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`agent_session:${id}`)?.meta_value
    ?? `seat:${id}`;
}
