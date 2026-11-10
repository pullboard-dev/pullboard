import { AUTOMATIC_DISPATCH_ENGINE } from "../../../../state/light.js";
import { SPEC_REFREEZE } from "../../../../spec/index.js";
import { UNCHANGED_REFREEZE_ENGINE } from "../../../../state/light.js";
import { pendingRefreeze } from "./read/shouts.js";
import { barReadyProblem } from "../../../../verify/index.js";
import { isHeld } from "./query.js";
import { current } from "./query.js";
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { COORDINATOR } from "../../../../config/index.js";
import { ENGINE_VERSION } from "../../../../state/index.js";
import { IN_STATE } from "../../../../state/index.js";
import { MOVES } from "../../../../state/index.js";
import { Refused } from "../../../../kernel/index.js";
import { moveItem } from "../board.js";
import { onlyCoordinator } from "../board.js";

/**
 * Freeze the current criterion and rows again (V2,V3). A pending coordinator correction is
 * adopted within its live claim, keeping the holder, lease and base; other refreezes reopen the
 * item so its next claim builds against the bar a verdict will check. Identical bars preserve
 * the validated item unchanged; historical engines retain release-on-refreeze behavior.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, freeze: (item: any) => { text: string, digest: string } }} who
 * @returns {{ before: string | null, after: string, retainedClaim?: true }}
 */
export function refreeze(board, id, { agentId, freeze, [SPEC_REFREEZE]: specCorrection = false }) {
  specCorrection &&= (board.executionEngineVersion ?? ENGINE_VERSION) >= AUTOMATIC_DISPATCH_ENGINE;
  return atomic(board, () => {
    let frozen = null;
    let unchanged = false;
    const currentItem = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(id);
    const pending = currentItem ? pendingRefreeze(board, id) : [];
    const retainsClaim = (board.executionEngineVersion ?? ENGINE_VERSION) >= 8
      && currentItem?.item_status === 'claimed' && isHeld(board, currentItem) && (pending.length > 0 || specCorrection);
    const transition = MOVES.find((move) => move.verb === 'refreeze' && move.to === (retainsClaim ? 'claimed' : 'open'));
    const item = moveItem(board, id, 'refreeze', {
      checks: {
        joined: null,
        barReady: found => specCorrection ? null : barReadyProblem(board, found),
        specRefreezeAllowed: found => found.item_status !== 'verified' || (specCorrection && !found.item_merged_commit)
          ? null : new Refused('CLOSED', `item #${id} is ${found.item_status}`),
        coordinatorOnly: () => onlyCoordinator(agentId, 'refreezes a criterion'),
        holderOrCoordinator: (found) => {
          const live = current(board, found);
          return live.item_owner === agentId || agentId === COORDINATOR
            ? null
            : new Refused('NOT_YOURS', `item #${id} is not claimed by you; only its holder or the coordinator refreezes it`);
        },
        [IN_STATE]: (found) => new Refused('CLOSED', `item #${id} is ${found.item_status}`),
        rowsInForce: (found) => {
          try {
            frozen = freeze(found);
            unchanged = (board.executionEngineVersion ?? ENGINE_VERSION) >= UNCHANGED_REFREEZE_ENGINE
              && (found.item_status !== 'claimed' || isHeld(board, found))
              && frozen.text === found.item_frozen && frozen.digest === found.item_frozen_digest;
            return null;
          } catch (error) {
            if (error instanceof Refused) return error;
            throw error;
          }
        },
      },
      set: () => ({
        item_frozen: frozen.text,
        item_frozen_digest: frozen.digest,
        ...(specCorrection ? { item_verdict: null, item_verified_by: null, item_review_by: null, item_review_until: null } : {}),
        ...(!retainsClaim ? { item_owner: null, item_lease_until: null } : {}),
      }),
      transition,
      unchanged: () => unchanged,
    });
    const keptClaim = retainsClaim || unchanged && currentItem?.item_status === 'claimed' && isHeld(board, currentItem);
    logEvent(board, agentId, 'refreeze', id, { before: item.item_frozen_digest, after: frozen.digest, ...(keptClaim ? { retainedClaim: true } : {}), ...(unchanged ? { unchanged: true } : {}) });
    return { before: item.item_frozen_digest, after: frozen.digest, ...(keptClaim ? { retainedClaim: true } : {}), ...(unchanged ? { unchanged: true } : {}) };
  });
}
