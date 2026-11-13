import { LAND_COLLISION_ENGINE } from "../../../../state/light.js";
import { itemById } from "./query.js";
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { acceptedVerdict } from "../../../../verify/index.js";
import { checkedLandingCommit } from "../../../../verify/index.js";
import { guardLandingWrite } from "../../logic/board/landing/lease.js";
import { ENGINE_VERSION } from "../../../../state/index.js";
import { VERDICT_REVIEW_ENGINE } from "../../../../state/index.js";
import { LOCAL_LANDING_ENGINE } from "../../../../state/light.js";
import { Refused } from "../../../../kernel/index.js";
import { latestLandingBatch } from "../../../../git/index.js";
import { coordinatorOnly } from "../board.js";
import { merged } from "./merged.js";
import { recordLandingBatch } from "./record/landing/batch.js";
import { persistShout } from "./shout.js";

/** Atomically record a pushed batch's first-containing merges and one main-moved receipt [B3,R3]. */
export function finishLandingBatch(board, { agentId, id, tip, landingFence }) {
  coordinatorOnly(agentId, 'finishes a landing');
  board.nativePorts.landingEnvironment.requireTrunk(board);
  return atomic(board, () => {
    guardLandingWrite(board, landingFence);
    const batch = latestLandingBatch(board, id);
    if (!batch || batch.tip !== tip) throw new Refused('LAND_BATCH', 'the pushed tip must match its recorded batch; run pullboard land --adopt');
    board.nativePorts.landingEnvironment.requireStoredBatch(board, batch);
    if (batch.state === 'landed') return batch;
    board.nativePorts.quarantine.validateQuarantineLandingProof(board, batch);
    if (batch.state !== 'pushed' && !(batch.state === 'trunk' && (board.executionEngineVersion ?? ENGINE_VERSION) >= LOCAL_LANDING_ENGINE)) throw new Refused('LAND_NOT_PUSHED', 'record a successful push before landing receipts; run pullboard land --adopt');
    for (const entry of batch.items) {
      const item = itemById(board, entry.id);
      if (batch.external) {
        // A named landing of commits proven elsewhere: the receipt is a forced merge, whatever the item's status [C7,#5559].
        if (item.item_merged_commit && item.item_merged_commit !== entry.merge) throw new Refused('LAND_ITEM_MOVED', `item #${entry.id} already has another landing receipt; read pullboard show ${entry.id}`);
        if (!item.item_merged_commit) merged(board, entry.id, { agentId, commit: entry.merge, forced: 'landed by the coordinator through pullboard land --items' });
        continue;
      }
      if (item.item_commit !== entry.commit || item.item_status !== 'verified') {
        throw new Refused('LAND_ITEM_MOVED', `item #${entry.id} changed after the batch was gated; rebuild its landing`);
      }
      if ((board.executionEngineVersion ?? ENGINE_VERSION) >= VERDICT_REVIEW_ENGINE
        && (entry.reviewedCommit ?? entry.commit) !== checkedLandingCommit(board, item)) {
        throw new Refused('LAND_ITEM_MOVED', `item #${entry.id} was re-reviewed after the batch was gated; rebuild its landing`);
      }
      if (item.item_merged_commit && item.item_merged_commit !== entry.merge) {
        throw new Refused('LAND_ITEM_MOVED', `item #${entry.id} already has another landing receipt; read pullboard show ${entry.id}`);
      }
      const accepted = acceptedVerdict(board, item);
      if ((board.executionEngineVersion ?? ENGINE_VERSION) < VERDICT_REVIEW_ENGINE
        && accepted?.review?.head && accepted.review.head !== (entry.reviewedCommit ?? entry.commit)) {
        // An old client may already have pushed B before a newer client checked C.
        // Record physical history without lending C's proof to B or wedging replay.
        logEvent(board, agentId, 'landing-review-moved', entry.id, {
          code: 'LAND_ITEM_MOVED', batch: id, verdict: accepted.verdict_id,
          checked: accepted.review.head, landed: entry.merge,
        });
      }
      if (!item.item_merged_commit) merged(board, entry.id, { agentId, commit: entry.merge });
    }
    logEvent(board, agentId, 'main-moved', null, { sha: tip, batch: id, items: batch.items.map((entry) => entry.id) });
    tellDeferredLandingReviews(board, batch);
    return recordLandingBatch(board, { agentId, batch: { ...batch, state: 'landed' }, revision: batch.revision, landingFence });
  });
}

/** Notify each deferred item's current audience once, in the landed transition's transaction. */
function tellDeferredLandingReviews(board, batch) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < LAND_COLLISION_ENGINE) return;
  for (const deferred of batch.blocked ?? []) {
    if (deferred.code !== 'LAND_FILE_OVERLAP') continue;
    const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(deferred.id);
    if (!item || item.item_status !== 'verified' || item.item_merged_commit) continue;
    const reviewer = item.item_review_by ?? item.item_verified_by ?? 'coordinator';
    persistShout(board, { from: 'landing', to: `item:${item.item_id}`,
      text: `#${item.item_id} waited for overlapping files while batch ${batch.id} landed at ${batch.tip}. ${reviewer}: merge current main into the reviewed commit and record a fresh merge-only re-accept before the next batch; no builder cycle or reopening is needed.`,
      detail: { item: item.item_id, batch: batch.id, files: deferred.files, reviewer } });
  }
}
