import { RIGOR_AUTO_ENGINE } from '../rigor-auto-engine.js';
/** Routing metadata owned by recordLandingBatch, discovered without a shared registry edit [C7,V4,H16]. */
import { VERDICT_REVIEW_ENGINE } from '../engine-metadata.js';
import { carriesLandingEnvironment } from '../execution-environment.js';
import {
  NATIVE_FLAKE_ENGINE,
  carriesFlakeDiagnostics,
} from '../flake-engine.js';
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
  if (carriesLandingEnvironment(args[0]?.batch)) return LANDING_ENVIRONMENT_ENGINE;
  if (board) {
    if (landingTestDefects(board).length) return LANDING_ENVIRONMENT_ENGINE;
    const id = args[0]?.batch?.id;
    if (landingBatches(board).some(batch => batch.id === id && carriesLandingEnvironment(batch))) return LANDING_ENVIRONMENT_ENGINE;
  }
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (args[0]?.batch?.state === 'trunk') return LOCAL_LANDING_ENGINE;
  if (carriesFlakeDiagnostics(args[0]?.batch)) return NATIVE_FLAKE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  if (args[0]?.batch?.invariantEvidence !== undefined) return SUBMISSION_PROOF_ENGINE;
  if (board) {
    const id = args[0]?.batch?.id;
    const prior = id && landingBatches(board).find(batch => batch.id === id);
    if (prior?.invariantEvidence) return SUBMISSION_PROOF_ENGINE;
    if (prior && ['items', 'candidates'].some(key => Array.isArray(prior[key]) && prior[key].some(entry => entry && Object.hasOwn(entry, 'reviewedCommit')))) return VERDICT_REVIEW_ENGINE;
  }
  if (args[0]?.batch && ['items', 'candidates'].some(key => Array.isArray(args[0].batch[key]) && args[0].batch[key].some(entry => entry && typeof entry === 'object' && Object.hasOwn(entry, 'reviewedCommit')))) return VERDICT_REVIEW_ENGINE;
  return 8;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "recordLandingBatch", order: 42, engine: 8,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "ENGINE_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
  "LAND_BATCH": "adopt the recorded batch: pullboard land --adopt"
}) });
