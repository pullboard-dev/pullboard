import { releaseReasonProblem } from "./release-reasons.js";
import { releaseExitClaim } from "./exit-rules-state.js";
import { staleClaimRelease } from "./board-stale-claim-release.js";
/** Ordinary claim/review releases, including recorded coordinator gone-seat observations. */
import { Refused } from "../../../kernel/core.js";
import {
  ENGINE_VERSION,
  MOVES,
  IN_STATE,
  REOPEN_FIRST_REFUSAL_ENGINE,
} from "../../../../src/machine.js";
import { firstRefusal } from "./board-item-read.js";
import { GONE_CLAIM_ENGINE } from "../../../../src/gone-claim-engine.js";
import { RELEASE_TWICE_HOLD_ENGINE } from "../../../../src/release-twice-hold-engine.js";
import { RELEASE_REASONS_ENGINE } from "../../../state/index.js";

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
    if (reasonCode !== undefined || (board.executionEngineVersion ?? ENGINE_VERSION) >= RELEASE_REASONS_ENGINE) {
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
    const exitHandoff = releaseExitClaim(board, id, agentId, note);
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
    logEvent(board, agentId, 'release', id, exitHandoff ? { exitHandoff, reason: note, ...(reasonCode === undefined ? {} : { reasonCode }) } : stale ? { staleClaim: stale, reason: stale.reason, ...(stale.expiredClaim ? { expiredClaim: stale.expiredClaim, reopenFirstRefusal: stale.reopenFirstRefusal } : {}), ...(reasonCode === undefined ? {} : { reasonCode }) } : gone ? { goneSeat: gone, reason: `Released gone seat ${gone.seat}; last seen ${gone.lastSeen}.`, ...(reasonCode === undefined ? {} : { reasonCode }) } : reasonCode === undefined ? undefined : { reasonCode, ...(typeof note === 'string' && note.trim() ? { reason: note.trim() } : {}) });
    // Count only ordinary coded claim releases since the coordinator last lifted a hold.
    if (!stale && !gone && !exitHandoff && reasonCode && !item.item_hold_reason
      && (board.executionEngineVersion ?? ENGINE_VERSION) >= RELEASE_TWICE_HOLD_ENGINE) {
      const releases = board.db.prepare(`SELECT event_by, event_detail FROM event WHERE item_id = ? AND event_kind = 'release'
        AND event_id > COALESCE((SELECT MAX(event_id) FROM event WHERE item_id = ? AND event_kind = 'unhold_item'), 0)
        ORDER BY event_id DESC`).all(id, id).filter(row => {
          const detail = JSON.parse(row.event_detail);
          return detail.reasonCode && !detail.review && !detail.staleClaim && !detail.goneSeat && !detail.exitHandoff;
        }).slice(0, 2);
      if (releases.length === 2) {
        const reasons = releases.reverse().map(row => {
          const detail = JSON.parse(row.event_detail);
          return `${row.event_by}: ${detail.reasonCode}${detail.reason ? ` (${detail.reason})` : ''}`;
        }).join('; ');
        const reason = `Released twice: ${reasons}`;
        setItem(board, id, { item_hold_reason: reason, item_hold_by: 'coordinator', item_hold_at: board.clock.now().toISOString() });
        logEvent(board, 'coordinator', 'hold_item', id, { reason, automatic: 'release-twice' });
        insertShout(board, { from: 'sentinel', to: 'coordinator', text: `#${id} held after two releases: ${reasons}`, lanes: [], detail: { item: id } });
      }
    }
    if (stale) insertShout(board, { from: 'sentinel', to: stale.holder,
      text: `Coordinator released your stale claim on #${id}: ${stale.reason.slice(0, 180)}. Last activity ${stale.lastActivity}.`, lanes: [], detail: { item: id } });
    return false;
  });
}
