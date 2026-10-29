import { committedItemAuthors } from './review-independence.js';
import { sealItemPatchSubmit } from './item-patch-submit.js';
import { checkItemPatchSubmit } from './item-patch-submit.js';
import * as reviewRouting from './review-routing.js';
import { twoTierReviews } from './review-independence.js';
import { submissionItemValues } from './submission-record.js';
import { submissionChildrenProblem } from './submission-record.js';
import { recordSubmissionEvent } from './submission-record.js';
import { correctedNoVerdictReopen } from './reopen-history.js';
import { pendingRefreezeProblem } from './board-read-auxiliary.js';
import { outsideBuildProblem } from './outside-source.js';
import { barReadyProblem } from './bar-readiness.js';
import { getItem } from './board-query.js';
import { listItems } from './board-query.js';
import { mergeOnlyBasis } from './merge-only-verdict.js';
import { mergeOnlyProblem } from './merge-only-verdict.js';
import { prepareMergeOnlySubmit } from './merge-only-submit.js';
import { MERGE_ONLY_VERDICT_ENGINE } from './merge-only-verdict-engine.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { acceptedVerdict } from './verdict-reviews.js';
import { ENGINE_VERSION } from './machine.js';
import { IN_STATE } from './machine.js';
import { MOVES } from './machine.js';
import { Refused } from './refused.js';
import { retainedVerifierIdentityProblem } from './item-authors.js';
import { KNOWN_MAIN_REWORKS_ENGINE } from './known-main-reworks-engine.js';
import { requireKnownMainReworks } from './known-main-reworks.js';
import { submissionProof } from '../packages/state/src/core/submission-proof.js';
import { SUBMISSION_PROOF_ENGINE } from './move-engine-constants.js';
import { FLOW_SIZE_ENGINE } from './flow-size-engine.js';
import { submissionSize } from '../packages/state/src/core/submission-size.js';
import { moveItem } from './board.js';

/**
 * Submit your claimed item at a commit (V4, V6). The caller has already checked the tree is clean
 * and run the gate green at that commit.
 *
 * Work a verifier rejected comes back only at a new head, so "done again" can never be the same
 * code declared twice.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, commit: string, tree: string, files?: string[], policyCommit?: string, note?: string }} at - `files`: what the
 *   item's own commits changed since its claim; a rework adds to what the first attempt changed.
 */
export function submit(board, id, { agentId, commit, tree, files = [], policyCommit = null, note, submissionProof: proof, submissionSize: size, infra = null, gateGreen, companion, mergeOnly: recordedCarry }) {
  let recordedProof;
  let recordedSize;
  if (companion) {
    const options = { agentId, commit, tree, gateGreen, policyCommit, submissionProof: proof, companion };
    if (board.executionEngineVersion === undefined) sealItemPatchSubmit(board, id, options);
    else checkItemPatchSubmit(board, id, options);
  }
  if (note !== undefined && (typeof note !== 'string' || !note.trim() || /[\r\n\u2028\u2029]/u.test(note))) {
    throw new Refused('USAGE', 'a submission note, when present, is one nonempty line');
  }
  atomic(board, () => { reviewRouting.requireStrictBuilderFamily(board, id, agentId);
    const modern = (board.executionEngineVersion ?? ENGINE_VERSION) >= MERGE_ONLY_VERDICT_ENGINE;
    const basis = modern && gateGreen === true ? mergeOnlyBasis(board, getItem(board, id), {}, { acceptedVerdict }) : null;
    const mergeOnly = modern ? board.executionEngineVersion === undefined
      ? prepareMergeOnlySubmit(board, id, { commit, tree, policyCommit, gateGreen }, { getItem, acceptedVerdict, identity: { committedItemAuthors, twoTierReviews } })
      : recordedCarry ?? null : null;
    const carry = Boolean(mergeOnly);
    const carriedProblem = found => mergeOnlyProblem(board, found, mergeOnly, { commit, tree, policyCommit }, { acceptedVerdict });
    const notYours = () => new Refused('NOT_YOURS', `item #${id} is not claimed by you; claim it first`);
    moveItem(board, id, 'submit', {
      ...(carry ? { transition: MOVES.find(move => move.verb === 'submit-merge') } : {}),
      checks: {
        joined: null, checkProvesSomething: null,
        barReady: found => barReadyProblem(board, found),
        [IN_STATE]: notYours,
        isHolder: (found) => outsideBuildProblem(board, found) ?? (found.item_owner === agentId ? null : notYours()),
        correctionRefrozen: () => pendingRefreezeProblem(board, id),
        criterionUnchanged: null,
        treeClean: null,
        nothingUntracked: null,
        hasCommit: null,
        withinLane: null,
        trunkMergeClean: null,
        sourcePlaced: null, // The CLI checks exact committed placement before any proof or ordered submit.
        trunkInCandidate: null,
        noUnverifiedStack: null,
        infraExplained: null, // The CLI checks the claimed Git diff before this transition.
        doctrineHolds: null,
        gateConfigured: null, queuedItemLease: null,
        gateGreen: null,
        proofRecorded: null, // The CLI records and validates native receipts before sealing submit; replay needs no origin files.
        treeStillDuringGate: null,
        ...(carry ? {
          mergeOnlyRecorded: carriedProblem,
          atSubmittedCommit: null, // The same post-gate HEAD check binds both submission paths.
          notBuilder: found => retainedVerifierIdentityProblem(board, found, basis.by, { committedItemAuthors, twoTierReviews }),
          proofNoted: () => typeof mergeOnly?.resolutionDiff === 'string' ? null : new Refused('PROOF_REQUIRED', 'record the actual merge resolution diff'),
        } : {}),
        submissionProofValid: () => {
          if ((board.executionEngineVersion ?? ENGINE_VERSION) >= SUBMISSION_PROOF_ENGINE) recordedProof = submissionProof(proof, board.executionEngineVersion ?? ENGINE_VERSION);
          if ((board.executionEngineVersion ?? ENGINE_VERSION) >= KNOWN_MAIN_REWORKS_ENGINE && recordedProof?.knownMainFailures) {
            requireKnownMainReworks(recordedProof.knownMainFailures, listItems(board, { all: true }), id);
          }
          if ((board.executionEngineVersion ?? ENGINE_VERSION) >= FLOW_SIZE_ENGINE) recordedSize = submissionSize(size, commit);
          return null;
        },
        childrenDone: () => submissionChildrenProblem(board, id),
        headIsNew: (found) => {
          const engineVersion = board.executionEngineVersion ?? ENGINE_VERSION;
          const rejectedHead = board.db.prepare(
            "SELECT 1 FROM verdict WHERE item_id = ? AND verdict_decision = 'REJECT' AND verdict_commit = ? AND (? < 9 OR verdict_digest = ?) LIMIT 1",
          ).get(id, commit, engineVersion, found.item_frozen_digest);
          const sameReopenedHead = found.item_verdict === null && found.item_commit === commit
            && !(engineVersion >= 11 && correctedNoVerdictReopen(board, id, commit));
          return rejectedHead || sameReopenedHead
            ? new Refused('HEAD_NOT_NEW', `#${id} already has a submission at ${commit.slice(0, 12)}; commit the rework first`)
            : null;
        },
      },
      before: () => { if (carry) logEvent(board, agentId, 'merge-only-accept', id, { ...mergeOnly, by: basis.by }); },
      set: found => submissionItemValues(board, found, { agentId, commit, tree, files, carry, basis }),
    });
    recordSubmissionEvent(board, id, { agentId, commit, tree, policyCommit, note, recordedProof, infra,
      modern, gateGreen, companion, carry, mergeOnly, recordedSize, engineVersion: board.executionEngineVersion ?? ENGINE_VERSION });
  });
}
