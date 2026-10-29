import { releaseReasonProblem } from './release-reasons.js';
import { staleClaimRelease } from './board-stale-claim-release.js';
/** Ordinary claim/review releases, including recorded coordinator gone-seat observations. */
import { Refused } from './refused.js';
import {
  ENGINE_VERSION,
  MOVES,
  IN_STATE,
  REOPEN_FIRST_REFUSAL_ENGINE,
} from './machine.js';
import { firstRefusal } from './board-item-read.js';
import { GONE_CLAIM_ENGINE } from './gone-claim-engine.js';
import { ROUTING_RULES_ENGINE } from './routing-rules-engine.js';

/** Validate frozen maintenance evidence without reading a replica's private presence cache. */
function goneRelease(board, item, actor, observation) {
  if (observation === undefined) return null;
  const at = observation?.lastSeen;
  const seen = typeof at === 'string' ? Date.parse(at) : NaN;
  const now = board.clock.now().getTime();
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < GONE_CLAIM_ENGINE) {
    throw new Refused('ENGINE_VERSION', 'gone-seat releases require the gone-claim engine; upgrade every linked writer');
  }
  if (actor !== 'coordinator' || item.item_status !== 'claimed' || item.item_owner !== observation?.seat
    || !(item.item_lease_until > board.clock.now().toISOString()) || !Number.isFinite(seen)
    || new Date(seen).toISOString() !== at || now - seen < 1_800_000
    || Object.keys(observation).some(key => !['seat', 'lastSeen'].includes(key))) {
    throw new Refused('NOT_YOURS', 'gone-seat maintenance requires the coordinator, a live claim, and its holder last seen at least 30 minutes ago');
  }
  return { seat: observation.seat, lastSeen: at };
}

/** Apply the existing ordinary release transition with narrowly frozen maintenance authority. */
export function releaseClaim(board, id, agentId, note, observation, dependencies, reasonCode) {
  const { atomic, itemById, reviewHolder, reviewReleaseNoteProblem, setItem, moveItem, logEvent, insertShout } = dependencies;
  // A string fourth argument is the release reason code; an object is a coordinator's frozen observation.
  if (typeof observation === 'string') { reasonCode = observation; observation = undefined; }
  return atomic(board, () => {
    if (reasonCode !== undefined || (board.executionEngineVersion ?? ENGINE_VERSION) >= ROUTING_RULES_ENGINE) {
      const bad = releaseReasonProblem(reasonCode, note);
      if (bad) throw bad;
    }
    const item = itemById(board, id);
    const stale = staleClaimRelease(board, item, agentId, note, observation);
    const gone = stale ? null : goneRelease(board, item, agentId, observation);
    if (item.item_status === 'submitted') {
      if (reviewHolder(board, item) !== agentId) {
        throw new Refused('NOT_YOURS', `item #${id} review is not reserved by you; ask its current reviewer to release it, or take a free review with pullboard next --verify`);
      }
      const currentEngine = board.executionEngineVersion ?? ENGINE_VERSION;
      const problem = currentEngine >= 5 ? reviewReleaseNoteProblem(board, id, agentId, note) : null;
      if (problem) throw problem;
      const reason = typeof note === 'string' ? note.trim() : '';
      setItem(board, id, { item_review_by: null, item_review_until: null });
      if (currentEngine >= 5) logEvent(board, agentId, 'release', id, { review: true, reason, ...(reasonCode === undefined ? {} : { reasonCode }) });
      else logEvent(board, agentId, 'release', id);
      return true;
    }
    const window = (board.executionEngineVersion ?? ENGINE_VERSION) >= REOPEN_FIRST_REFUSAL_ENGINE ? firstRefusal(board, id) : null;
    moveItem(board, id, 'release', {
      transition: (board.executionEngineVersion ?? ENGINE_VERSION) < REOPEN_FIRST_REFUSAL_ENGINE ? { ...MOVES.find(move => move.verb === 'release'), from: ['claimed'] } : null,
      checks: {
        joined: null,
        [IN_STATE]: () => new Refused('NOT_YOURS', `item #${id} is not claimed by you`),
        releaseOwnsWork: (found) => (stale || gone || found.item_owner === agentId || found.item_status === 'open' && window?.builder === agentId ? null : new Refused('NOT_YOURS', `item #${id} is not claimed by you`)),
        reviewReleaseExplained: null, // Claimed releases do not free a submitted review.
      },
      set: () => ({ item_owner: null, item_lease_until: null }),
    });
    logEvent(board, agentId, 'release', id, stale ? { staleClaim: stale, reason: stale.reason, ...(reasonCode === undefined ? {} : { reasonCode }) } : gone ? { goneSeat: gone, reason: `Released gone seat ${gone.seat}; last seen ${gone.lastSeen}.`, ...(reasonCode === undefined ? {} : { reasonCode }) } : reasonCode === undefined ? undefined : { reasonCode, ...(typeof note === 'string' && note.trim() ? { reason: note.trim() } : {}) });
    if (stale) insertShout(board, { from: 'sentinel', to: stale.holder,
      text: `Coordinator released your stale claim on #${id}: ${stale.reason.slice(0, 180)}. Last activity ${stale.lastActivity}.`, lanes: [], detail: { item: id } });
    return false;
  });
}
