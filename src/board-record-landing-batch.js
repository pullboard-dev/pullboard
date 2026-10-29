import { now } from './board-query.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { guardLandingWrite } from './board-landing-lease.js';
import { ENGINE_VERSION } from './machine.js';
import { VERDICT_REVIEW_ENGINE } from './machine.js';
import { LOCAL_LANDING_ENGINE } from './land-engine.js';
import { Refused } from './refused.js';
import { invariantEvidence } from './submit-invariants.js';
import { preserveInvariantEvidence } from './submit-invariants.js';
import { validateLandingBatch } from './submit-invariants.js';
import { validateLandingRevision } from './submit-invariants.js';
import { SUBMISSION_PROOF_ENGINE } from './move-engine-constants.js';
import { landingBatches } from './git-landing-batches.js';
import { NATIVE_FLAKE_ENGINE } from './flake-engine.js';
import { carriesFlakeDiagnostics } from './flake-engine.js';
import { coordinatorOnly } from './board.js';

/** Append one coordinator-owned batch revision without changing the board schema [B3,R3]. */
export function recordLandingBatch(board, { agentId, batch, revision = 0, landingFence }) {
  coordinatorOnly(agentId, 'records landing batches');
  board.nativePorts.landingEnvironment.requireBatch(board, batch);
  if (carriesFlakeDiagnostics(batch) && (board.executionEngineVersion ?? ENGINE_VERSION) < NATIVE_FLAKE_ENGINE) {
    throw new Refused('ENGINE_VERSION', `typed landing diagnostics require engine ${NATIVE_FLAKE_ENGINE}; upgrade Pullboard`);
  }
  if (batch?.state === 'trunk' && (board.executionEngineVersion ?? ENGINE_VERSION) < LOCAL_LANDING_ENGINE) throw new Refused('ENGINE_VERSION', `landing on the local trunk requires engine ${LOCAL_LANDING_ENGINE}; upgrade Pullboard`);
  const evidence = (board.executionEngineVersion ?? ENGINE_VERSION) >= SUBMISSION_PROOF_ENGINE ? invariantEvidence(batch?.invariantEvidence) : undefined;
  validateLandingBatch(batch, revision);
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= VERDICT_REVIEW_ENGINE
    && batch.items.some(entry => Object.hasOwn(entry, 'reviewedCommit') && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(entry.reviewedCommit ?? ''))) {
    throw new Refused('LAND_BATCH', 'a landing batch needs its exact base, tip, items, state, owner and log path; run pullboard land');
  }
  return atomic(board, () => {
    guardLandingWrite(board, landingFence);
    const previous = landingBatches(board).find((entry) => entry.id === batch.id);
    board.nativePorts.landingEnvironment.requireRevision(board, previous, batch);
    preserveInvariantEvidence(previous, evidence, board.executionEngineVersion ?? ENGINE_VERSION);
    validateLandingRevision(previous, batch, revision);
    const recorded = { ...batch, revision: revision + 1, updatedAt: now(board) };
    delete recorded.invariantEvidence;
    if (evidence) recorded.invariantEvidence = evidence;
    logEvent(board, agentId, 'landing_batch', null, { batch: recorded });
    return recorded;
  });
}
