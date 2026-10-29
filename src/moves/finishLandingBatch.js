import { RIGOR_AUTO_ENGINE } from '../rigor-auto-engine.js';
/** Routing metadata owned by finishLandingBatch, discovered without a shared registry edit [C7,V4,H16]. */
import { VERDICT_REVIEW_ENGINE } from '../engine-metadata.js';
import { carriesLandingEnvironment } from '../execution-environment.js';
import { LOCAL_LANDING_ENGINE } from '../land-engine.js';
import { landingBatches } from '../landing-batch-history.js';
import { LANDING_ENVIRONMENT_ENGINE } from '../landing-environment-engine.js';
import { LANDING_LEASE_ENGINE } from '../landing-lease-engine.js';
import { landingTestDefects } from '../board-landing-test-defect-history.js';
import { BOARD_SENTINEL_ENGINE } from '../sentinel-engine.js';
import { SUBMISSION_PROOF_ENGINE } from '../move-engine-constants.js';

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (board) {
    if (landingTestDefects(board).length) return LANDING_ENVIRONMENT_ENGINE;
    const id = args[0]?.id;
    if (landingBatches(board).some(batch => batch.id === id && carriesLandingEnvironment(batch))) return LANDING_ENVIRONMENT_ENGINE;
  }
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (board && landingBatches(board).find(batch => batch.id === args[0]?.id)?.state === 'trunk') return LOCAL_LANDING_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  if (board) {
    const id = args[0]?.id;
    const prior = id && landingBatches(board).find(batch => batch.id === id);
    if (prior?.invariantEvidence) return SUBMISSION_PROOF_ENGINE;
    if (prior && ['items', 'candidates'].some(key => Array.isArray(prior[key]) && prior[key].some(entry => entry && Object.hasOwn(entry, 'reviewedCommit')))) return VERDICT_REVIEW_ENGINE;
  }
  return 8;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "finishLandingBatch", order: 46, engine: 8,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "LAND_BATCH": "adopt the recorded batch: pullboard land --adopt",
  "LAND_ITEM_MOVED": "rebuild the batch from current verified work: pullboard land",
  "LAND_NOT_PUSHED": "push the batch, then pullboard land --adopt"
}) });
