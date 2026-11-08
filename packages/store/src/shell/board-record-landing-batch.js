import { FLAKE_RATCHET_ENGINE } from '../../../../src/flake-ratchet-engine.js';
import { quarantineBatchGates } from "../../../verify/index.js";
import { now } from "./board-query.js";
import { atomic } from "./board-event-log.js";
import { logEvent } from "./board-event-log.js";
import { guardLandingWrite } from "../core/board-landing-lease.js";
import { ENGINE_VERSION } from "../../../state/index.js";
import { VERDICT_REVIEW_ENGINE } from "../../../state/index.js";
import { LOCAL_LANDING_ENGINE } from "../../../../src/land-engine.js";
import { Refused } from "../../../kernel/index.js";
import { invariantEvidence } from "../../../items/index.js";
import { preserveInvariantEvidence } from "../../../items/index.js";
import { validateLandingBatch } from "../../../items/index.js";
import { validateLandingRevision } from "../../../items/index.js";
import { SUBMISSION_PROOF_ENGINE } from "../../../../src/move-engine-constants.js";
import { latestLandingBatch } from "../../../git/index.js";
import { NATIVE_FLAKE_ENGINE } from "../../../../src/flake-engine.js";
import { carriesFlakeDiagnostics } from "../../../../src/flake-engine.js";
import { coordinatorOnly } from "./board.js";

/** Append one coordinator-owned batch revision without changing the board schema [B3,R3]. */
export function recordLandingBatch(board, { agentId, batch, revision = 0, landingFence }) {
  coordinatorOnly(agentId, 'records landing batches');
  board.nativePorts.landingEnvironment.requireBatch(board, batch);
  if (carriesFlakeDiagnostics(batch) && (board.executionEngineVersion ?? ENGINE_VERSION) < NATIVE_FLAKE_ENGINE) {
    throw new Refused('ENGINE_VERSION', `typed landing diagnostics require engine ${NATIVE_FLAKE_ENGINE}; upgrade Pullboard`);
  }
  if (batch?.state === 'trunk' && (board.executionEngineVersion ?? ENGINE_VERSION) < LOCAL_LANDING_ENGINE) throw new Refused('ENGINE_VERSION', `landing on the local trunk requires engine ${LOCAL_LANDING_ENGINE}; upgrade Pullboard`);
  const evidence = (board.executionEngineVersion ?? ENGINE_VERSION) >= SUBMISSION_PROOF_ENGINE ? invariantEvidence(batch?.invariantEvidence) : undefined;
  if (batch?.flakeRatchet !== undefined) {
    const snapshot = batch.flakeRatchet;
    if ((board.executionEngineVersion ?? ENGINE_VERSION) < FLAKE_RATCHET_ENGINE) throw new Refused('ENGINE_VERSION', 'flake ratchet snapshots need the current engine');
    if (snapshot?.version !== 1 || !Number.isSafeInteger(snapshot.eventId) || snapshot.eventId < 0
      || !Array.isArray(snapshot.quarantines) || snapshot.count !== snapshot.quarantines.length
      || snapshot.quarantines.some(row => typeof row.file !== 'string' || typeof row.name !== 'string' || !Number.isSafeInteger(row.item) || row.item <= 0)) {
      throw new Refused('LAND_BATCH', 'the flake ratchet snapshot needs its event boundary, count and named filed quarantines');
    }
  }
  validateLandingBatch(batch, revision);
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= VERDICT_REVIEW_ENGINE
    && batch.items.some(entry => Object.hasOwn(entry, 'reviewedCommit') && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(entry.reviewedCommit ?? ''))) {
    throw new Refused('LAND_BATCH', 'a landing batch needs its exact base, tip, items, state, owner and log path; run pullboard land');
  }
  return atomic(board, () => {
    guardLandingWrite(board, landingFence);
    const previous = latestLandingBatch(board, batch.id);
    if (previous?.flakeRatchet && (!batch.flakeRatchet || ['pushed', 'trunk'].includes(previous.state) && JSON.stringify(previous.flakeRatchet) !== JSON.stringify(batch.flakeRatchet))) throw new Refused('LAND_BATCH', 'preserve the published flake ratchet snapshot');
    if (batch.flakeRatchet && !(batch.state === 'trunk' && batch.owner === 'coordinator-train' && !previous)
      && JSON.stringify(previous?.flakeRatchet ?? null) !== JSON.stringify(batch.flakeRatchet)) {
      const maxEvent = board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id;
      if (batch.flakeRatchet.eventId > maxEvent) throw new Refused('LAND_BATCH', 'the flake ratchet event boundary must already exist');
      const changed = board.db.prepare(`SELECT 1 FROM event WHERE event_id>? AND event_kind IN
        ('test-quarantine','flake-observation','flake-repair','gate-run','accept','reject','reopen','withdraw','merged') LIMIT 1`).get(batch.flakeRatchet.eventId);
      if (changed) throw new Refused('BOARD_BUSY', 'flake evidence or repair status changed before the landing snapshot was recorded; retry the landing');
    }
    board.nativePorts.landingEnvironment.requireRevision(board, previous, batch);
    preserveInvariantEvidence(previous, evidence, board.executionEngineVersion ?? ENGINE_VERSION);
    validateLandingRevision(previous, batch, revision);
    if (batch.proof?.receipt) board.nativePorts.quarantine.validateQuarantineVerdict(board, batch.proof.receipt, { historical: true });
    for (const gate of quarantineBatchGates(batch)) board.nativePorts.quarantine.validateQuarantineGate(board, gate, { historical: true });
    const recorded = { ...batch, revision: revision + 1, updatedAt: now(board) };
    delete recorded.invariantEvidence;
    if (evidence) recorded.invariantEvidence = evidence;
    logEvent(board, agentId, 'landing_batch', null, { batch: recorded });
    return recorded;
  });
}
