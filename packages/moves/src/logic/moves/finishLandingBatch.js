import { FLAKE_RATCHET_ENGINE } from '../../../../state/light.js';
import { QUARANTINE_VERDICT_ENGINE } from "../../../../state/light.js";
import { quarantineBatchGates } from "../../../../verify/browser.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by finishLandingBatch, discovered without a shared registry edit [C7,V4,H16]. */
import { VERDICT_REVIEW_ENGINE } from "../../../../state/light.js";
import { carriesLandingEnvironment } from "../../../../sandbox/browser.js";
import { LOCAL_LANDING_ENGINE } from "../../../../state/light.js";
import { latestLandingBatch } from "../../../../git/browser.js";
import { LANDING_ENVIRONMENT_ENGINE } from "../../../../state/light.js";
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { landingTestDefects } from "../../../../store/browser.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";
import { SUBMISSION_PROOF_ENGINE } from "../../../../state/light.js";
import { FORCED_MERGE_ENGINE } from "../../../../state/light.js";
import { LANDING_NEXT } from "../table/next.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function existingEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (board) {
    if (landingTestDefects(board).length) return LANDING_ENVIRONMENT_ENGINE;
    const id = args[0]?.id;
    if (carriesLandingEnvironment(latestLandingBatch(board, id))) return LANDING_ENVIRONMENT_ENGINE;
  }
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (board && latestLandingBatch(board, args[0]?.id)?.state === 'trunk') return LOCAL_LANDING_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  if (board) {
    const id = args[0]?.id;
    const prior = id && latestLandingBatch(board, id);
    if (prior?.invariantEvidence) return SUBMISSION_PROOF_ENGINE;
    if (prior && ['items', 'candidates'].some(key => Array.isArray(prior[key]) && prior[key].some(entry => entry && Object.hasOwn(entry, 'reviewedCommit')))) return VERDICT_REVIEW_ENGINE;
  }
  return 8;
}

/** A computed batch cannot be finished by a receiver that would ignore its event-bound authority. */
function minimumEngine(args, board, at) {
  const batch = board && latestLandingBatch(board, args[0]?.id);
  return Math.max(batch?.external ? FORCED_MERGE_ENGINE : 1, batch?.flakeRatchet ? FLAKE_RATCHET_ENGINE : 1, existingEngine(args, board, at), batch && (quarantineBatchGates(batch).length
    || Object.hasOwn(batch.proof?.receipt ?? {}, 'blockingVerdict')) ? QUARANTINE_VERDICT_ENGINE : 1);
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "finishLandingBatch", order: 46, engine: 8,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "LAND_BATCH": LANDING_NEXT.LAND_BATCH,
  "LAND_ITEM_MOVED": LANDING_NEXT.LAND_ITEM_MOVED,
  "LAND_NOT_PUSHED": LANDING_NEXT.LAND_NOT_PUSHED
}) });
