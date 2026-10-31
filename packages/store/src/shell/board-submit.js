import { reviewPatchAuthors } from "../../../verify/index.js";
import { fileKnownMainAutofile } from "../core/known-main-autofile.js";
import { KNOWN_MAIN_OWNER_PATTERN_ENGINE } from "../../../../src/known-main-owner-pattern-engine.js";

import { committedItemAuthors } from "../../../verify/index.js";
import { sealItemPatchSubmit } from "../../../../src/item-patch-submit.js";
import { checkItemPatchSubmit } from "../../../../src/item-patch-submit.js";
import * as reviewRouting from "../../../verify/index.js";
import { twoTierReviews } from "../../../verify/index.js";
import { submissionItemValues } from "./submission-record.js";
import { submissionChildrenProblem } from "./submission-record.js";
import { recordSubmissionEvent } from "./submission-record.js";
import { correctedNoVerdictReopen } from "../../../../src/reopen-history.js";
import { pendingRefreezeProblem } from "./board-read-auxiliary.js";
import { outsideBuildProblem } from "../../../../src/outside-source.js";
import { barReadyProblem } from "../../../verify/index.js";
import { getItem } from "./board-query.js";
import { listItems } from "./board-query.js";
import { mergeOnlyBasis } from "../../../merge/index.js";
import { mergeOnlyProblem } from "../../../merge/index.js";
import { prepareMergeOnlySubmit } from "../../../merge/index.js";
import { MERGE_ONLY_VERDICT_ENGINE } from "../../../../src/merge-only-verdict-engine.js";
import { atomic } from "./board-event-log.js";
import { logEvent } from "./board-event-log.js";
import { acceptedVerdict } from "../../../verify/index.js";
import { ENGINE_VERSION } from "../../../../src/machine.js";
import { IN_STATE } from "../../../../src/machine.js";
import { MOVES } from "../../../../src/machine.js";
import { Refused } from "../../../kernel/index.js";
import { retainedVerifierIdentityProblem } from "../../../../src/item-authors.js";
import { KNOWN_MAIN_REWORKS_ENGINE } from "../../../../src/known-main-reworks-engine.js";
import { requireKnownMainReworks } from "../core/known-main-reworks.js";
import { submissionProof } from "../../../state/src/core/submission-proof.js";
import { SUBMISSION_PROOF_ENGINE } from "../../../../src/move-engine-constants.js";
import { FLOW_SIZE_ENGINE } from "../../../../src/flow-size-engine.js";
import { submissionSize } from "../../../state/src/core/submission-size.js";
import { moveItem } from "./board.js";

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
export function submit(board, id, { agentId, commit, tree, files = [], policyCommit = null, note, submissionProof: proof, submissionSize: size, infra = null, gateGreen, companion, quarantineProofIds, autoMainReds, mergeOnly: recordedCarry }) {
  const autoOptions = { agentId, commit, tree, policyCommit, companion, autoMainReds, submissionProof: proof };
  if (autoMainReds && board.executionEngineVersion === undefined) autoOptions.autoMainReds = board.enginePorts.sealKnownMainAutofile(board, id, autoOptions).autoMainReds;
  let recordedProof;
  let recordedSize;
  let mainRedRepairs;
  if (companion) {
    const options = { agentId, commit, tree, gateGreen, policyCommit, submissionProof: proof, companion };
    if (board.executionEngineVersion === undefined) sealItemPatchSubmit(board, id, options);
    else checkItemPatchSubmit(board, id, options);
  }
  if (note !== undefined && (typeof note !== 'string' || !note.trim() || /[\r\n\u2028\u2029]/u.test(note))) {
    throw new Refused('USAGE', 'a submission note, when present, is one nonempty line');
  }
  atomic(board, () => { reviewRouting.requireStrictBuilderFamily(board, id, agentId);
    if (companion) checkItemPatchSubmit(board, id, { agentId, commit, tree, gateGreen, policyCommit, submissionProof: proof, companion });
    if (quarantineProofIds !== undefined) board.nativePorts.quarantine.validateQuarantineProofIds(board, getItem(board, id),
      { agentId, ids: quarantineProofIds, kind: 'submit', commit: companion?.commit ?? commit });
    const modern = (board.executionEngineVersion ?? ENGINE_VERSION) >= MERGE_ONLY_VERDICT_ENGINE;
    const basis = modern && gateGreen === true ? mergeOnlyBasis(board, getItem(board, id), {}, { acceptedVerdict }) : null;
    const mergeOnly = modern ? board.executionEngineVersion === undefined
      ? prepareMergeOnlySubmit(board, id, { commit, tree, policyCommit, gateGreen }, { getItem, acceptedVerdict, identity: { reviewPatchAuthors, committedItemAuthors, twoTierReviews } })
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
          notBuilder: found => retainedVerifierIdentityProblem(board, found, basis.by, { reviewPatchAuthors, committedItemAuthors, twoTierReviews }),
          proofNoted: () => typeof mergeOnly?.resolutionDiff === 'string' ? null : new Refused('PROOF_REQUIRED', 'record the actual merge resolution diff'),
        } : {}),
        submissionProofValid: () => {
          if (autoMainReds) for (const receipt of autoOptions.autoMainReds.candidates ?? []) board.nativePorts.quarantine.validateQuarantineVerdict(board, receipt);
          const autoResult = autoMainReds ? fileKnownMainAutofile(board, id, autoOptions, listItems(board, { all: true })) : null;
          const autoKnown = autoResult?.known;
          if (autoResult) mainRedRepairs = autoResult.repairs;
          if ((board.executionEngineVersion ?? ENGINE_VERSION) >= SUBMISSION_PROOF_ENGINE) recordedProof = submissionProof(autoKnown ? { ...proof, knownMainFailures: autoKnown } : proof, board.executionEngineVersion ?? ENGINE_VERSION);
          if ((board.executionEngineVersion ?? ENGINE_VERSION) >= KNOWN_MAIN_REWORKS_ENGINE && recordedProof?.knownMainFailures) {
            requireKnownMainReworks(recordedProof.knownMainFailures, listItems(board, { all: true }), id,
              (board.executionEngineVersion ?? ENGINE_VERSION) >= KNOWN_MAIN_OWNER_PATTERN_ENGINE);
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
      modern, gateGreen, companion, quarantineProofIds, carry, mergeOnly, recordedSize, engineVersion: board.executionEngineVersion ?? ENGINE_VERSION });
  });
  if (autoMainReds) return { mainRedRepairs };
}
