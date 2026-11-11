import { FLAKE_RATCHET_ENGINE } from '../../../../state/light.js';
import { QUARANTINE_VERDICT_ENGINE } from "../../../../state/light.js";
import { quarantineBatchGates } from "../../../../verify/browser.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by recordLandingBatch, discovered without a shared registry edit [C7,V4,H16]. */
import { VERDICT_REVIEW_ENGINE } from "../../../../state/light.js";
import { carriesLandingEnvironment } from "../../../../sandbox/browser.js";
import {
  NATIVE_FLAKE_ENGINE,
  carriesFlakeDiagnostics,
} from "../../../../state/light.js";
import { LOCAL_LANDING_ENGINE } from "../../../../state/light.js";
import { latestLandingBatch } from "../../../../git/browser.js";
import { LANDING_ENVIRONMENT_ENGINE } from "../../../../state/light.js";
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { landingTestDefects } from "../../../../store/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";
import { SUBMISSION_PROOF_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function existingEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (carriesLandingEnvironment(args[0]?.batch)) return LANDING_ENVIRONMENT_ENGINE;
  if (board) {
    if (landingTestDefects(board).length) return LANDING_ENVIRONMENT_ENGINE;
    const id = args[0]?.batch?.id;
    if (carriesLandingEnvironment(latestLandingBatch(board, id))) return LANDING_ENVIRONMENT_ENGINE;
  }
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (args[0]?.batch?.state === 'trunk') return LOCAL_LANDING_ENGINE;
  if (carriesFlakeDiagnostics(args[0]?.batch)) return NATIVE_FLAKE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  if (args[0]?.batch?.invariantEvidence !== undefined) return SUBMISSION_PROOF_ENGINE;
  if (board) {
    const id = args[0]?.batch?.id;
    const prior = id && latestLandingBatch(board, id);
    if (prior?.invariantEvidence) return SUBMISSION_PROOF_ENGINE;
    if (prior && ['items', 'candidates'].some(key => Array.isArray(prior[key]) && prior[key].some(entry => entry && Object.hasOwn(entry, 'reviewedCommit')))) return VERDICT_REVIEW_ENGINE;
  }
  if (args[0]?.batch && ['items', 'candidates'].some(key => Array.isArray(args[0].batch[key]) && args[0].batch[key].some(entry => entry && typeof entry === 'object' && Object.hasOwn(entry, 'reviewedCommit')))) return VERDICT_REVIEW_ENGINE;
  return 8;
}

/** Optional computed evidence requires its own floor without changing any old first-match rule. */
function minimumEngine(args, board, at) {
  return Math.max(args[0]?.batch?.flakeRatchet ? FLAKE_RATCHET_ENGINE : 1, existingEngine(args, board, at), (quarantineBatchGates(args[0]?.batch).length || Object.hasOwn(args[0]?.batch?.proof?.receipt ?? {}, 'blockingVerdict')) ? QUARANTINE_VERDICT_ENGINE : 1);
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "recordLandingBatch", order: 42, engine: 8,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "ENGINE_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
  "LAND_BATCH": "adopt the recorded batch: pullboard land --adopt"
}) });
