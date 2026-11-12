import { boardWriteSnapshot } from './write/preparation.js';
import { builderFamilyProblem } from '../builder/family.js';
import { BUILDER_FAMILY_REQUIRED_ENGINE } from '../../../../state/light.js';
import { requireBoardWriteSnapshot } from './write/preparation.js';
import { git } from '../../../../git/index.js';
import { tryGit } from '../../../../git/index.js';
import { gateJudgmentPath } from '../../../../verify/index.js';
import { STRICT_RENAME_ENGINE } from '../../../../state/index.js';
import { acceptMachineSubmission } from '../../../../verify/index.js';
import { machineVerificationEligible } from '../../../../verify/index.js';
import { receiptFields } from '../../../../verify/index.js';
import { MACHINE_VERDICT_ENGINE } from '../../../../state/light.js';
import { CLAUSE_INSPECTION_ENGINE } from '../../../../state/light.js';
import { clauseInspectionProblem } from '../../../../state/index.js';
import { itemThread } from './query.js';
import { proofReceipts } from './query.js';
import { reviewPatchAuthors } from "../../../../verify/index.js";
import { fileKnownMainAutofile } from "../../logic/known/main/autofile.js";
import { KNOWN_MAIN_OWNER_PATTERN_ENGINE } from "../../../../state/light.js";
import { KNOWN_MAIN_RUNNING_FILE_ENGINE } from "../../../../state/light.js";

import { committedItemAuthors } from "../../../../verify/index.js";
import { sealItemPatchSubmit } from "../../../../items/index.js";
import { checkItemPatchSubmit } from "../../../../items/index.js";
import { startItemPatchObjectionWindow } from "../../../../items/index.js";
import { requireStrictBuilderFamily } from "../../../../verify/index.js";
import { twoTierReviews } from "../../../../verify/index.js";
import { submissionItemValues } from "../submission.js";
import { submissionChildrenProblem } from "../submission.js";
import { recordSubmissionEvent } from "../submission.js";
import { correctedNoVerdictReopen } from "../../../../items/index.js";
import { pendingRefreezeProblem } from "./read/shouts.js";
import { outsideBuildProblem } from "../../../../items/index.js";
import { barReadyProblem } from "../../../../verify/index.js";
import { getItem } from "./query.js";
import { listItems } from "./query.js";
import { mergeOnlyBasis } from "../../../../merge/index.js";
import { mergeOnlyProblem } from "../../../../merge/index.js";
import { prepareMergeOnlySubmit } from "../../../../merge/index.js";
import { MERGE_ONLY_VERDICT_ENGINE } from "../../../../state/light.js";
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { acceptedVerdict } from "../../../../verify/index.js";
import { ENGINE_VERSION } from "../../../../state/index.js";
import { IN_STATE } from "../../../../state/index.js";
import { MOVES } from "../../../../state/index.js";
import { Refused } from "../../../../kernel/index.js";
import { retainedVerifierIdentityProblem } from "../../../../items/index.js";
import { KNOWN_MAIN_REWORKS_ENGINE } from "../../../../state/light.js";
import { requireKnownMainReworks } from "../../logic/known/main/reworks.js";
import { submissionProof } from "../../../../state/light.js";
import { SUBMISSION_PROOF_ENGINE } from "../../../../state/index.js";
import { FLOW_SIZE_ENGINE } from "../../../../state/light.js";
import { submissionSize } from "../../../../state/light.js";
import { moveItem } from "../board.js";
import { sealClauseInspection } from './repository.js';
export { sealClauseInspection };

/** Seal rename evidence from exact Git objects and accepted sensitive-path policy before replication [V4,H16]. */
export function sealStrictRenames(board, id, options) {
  if (!board.gitRoot) return options;
  const base = getItem(board, id)?.item_claim_head;
  if (!base || !options.commit) return options;
  // An unavailable or mismatched source has no rename evidence to seal; it gets ordinary review, never a Git error [V4,H16].
  const diff = tryGit(board.gitRoot, ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--name-status', '-z', base, options.commit]);
  if (diff.status !== 0) return options;
  const fields = diff.stdout.split('\0');
  const policy = options.clausePolicyCommit
    ? board.enginePorts.sandboxPolicyReads.policyAt(board.gitRoot, options.clausePolicyCommit)
    : board.enginePorts.sandboxPolicyReads.mainPolicy(board.gitRoot);
  const configured = policy.config.intake?.sensitivePaths ?? [];
  if (!Array.isArray(configured) || configured.some(path => typeof path !== 'string' || !path))
    throw new Refused('BAD_CONFIG', 'intake.sensitivePaths must name relative sensitive files or directory prefixes');
  const strictRenames = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++], oldPath = fields[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const newPath = fields[i++];
      const sensitive = configured.some(path => oldPath === path || path.endsWith('/') && oldPath.startsWith(path));
      if (status.startsWith('R') && (gateJudgmentPath(oldPath) || sensitive)) strictRenames.push([oldPath, newPath]);
    }
  }
  return { ...options, strictRenames };
}

const PREPARED_SUBMITS = new WeakMap();

/** Seal repository reads before taking the write lock, bound to this native connection and snapshot. */
export function prepareSubmit(board, id, options) {
  const known = PREPARED_SUBMITS.get(options);
  if (known?.board === board && known.id === id) return options;
  const snapshot = boardWriteSnapshot(board);
  if (board.executionEngineVersion === undefined && ENGINE_VERSION >= CLAUSE_INSPECTION_ENGINE) {
    options = sealClauseInspection(board, id, options);
    options = sealStrictRenames(board, id, options);
  }
  // The seal's own "policy re-frozen" fact is this preparation's write on this connection, not a stale board: only
  // another connection's commit voids the seal, and the write checks from after it. Counting the fact as a change
  // refused every submit after a landing-only policy change, so a queued gate retried it forever (#3516).
  const sealed = boardWriteSnapshot(board);
  if (sealed.version !== snapshot.version) requireBoardWriteSnapshot(board, snapshot, 'submit');
  const prepared = Object.freeze({ ...options });
  PREPARED_SUBMITS.set(prepared, { board, id, snapshot: sealed });
  return prepared;
}

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
export function submit(board, id, options) {
  options = prepareSubmit(board, id, options);
  requireBoardWriteSnapshot(board, PREPARED_SUBMITS.get(options).snapshot, 'submit');
  const { strictRenames, agentId, commit, tree, files = [], policyCommit = null, note, submissionProof: proof, submissionSize: size, inspectClauses, clausePolicyCommit, infra = null, gateGreen, companion, quarantineProofIds, autoMainReds, mergeOnly: recordedCarry, tooling = null } = options;
  const familyPolicyCommit = policyCommit ?? clausePolicyCommit;
  const familyPolicy = (board.executionEngineVersion ?? ENGINE_VERSION) >= BUILDER_FAMILY_REQUIRED_ENGINE && board.gitRoot && familyPolicyCommit
    ? board.enginePorts.sandboxPolicyReads.policyAt(board.gitRoot, familyPolicyCommit).config.verify.family : 'off';
  let inspect = inspectClauses === true;
  if (board.executionEngineVersion !== undefined && board.executionEngineVersion >= CLAUSE_INSPECTION_ENGINE && board.gitRoot) {
    if (!clausePolicyCommit || clausePolicyCommit !== policyCommit) throw new Refused('NO_POLICY', 'the sealed inspection policy must match the submission policy');
    const policy = board.enginePorts.sandboxPolicyReads.policyAt(board.gitRoot, clausePolicyCommit);
    inspect = policy.config.verify.inspectClauses === true;
    if (inspect !== (inspectClauses === true)) throw new Refused('NO_POLICY', 'the sealed inspection setting does not match its accepted policy');
  }

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
  atomic(board, () => {
    requireBoardWriteSnapshot(board, PREPARED_SUBMITS.get(options).snapshot, 'submit');
    if ((board.executionEngineVersion ?? ENGINE_VERSION) >= STRICT_RENAME_ENGINE && strictRenames !== undefined) {
      if (!Array.isArray(strictRenames) || strictRenames.some(pair => !Array.isArray(pair) || pair.length !== 2 || !pair.every(path => typeof path === 'string' && path.length > 0))) throw new Refused('BAD_REVIEW_POLICY', 'invalid strict rename witness');
      if (strictRenames.length) board.db.prepare('INSERT OR REPLACE INTO board_meta(meta_key, meta_value) VALUES (?, ?)').run(`strict_rename:${id}`, JSON.stringify(strictRenames));
    }
    if ((board.executionEngineVersion ?? ENGINE_VERSION) >= MACHINE_VERDICT_ENGINE && options.machineReceipts !== undefined
      && (!Array.isArray(options.machineReceipts) || options.machineReceipts.some(receipt => !receiptFields(receipt)))) throw new Refused('MACHINE_PROOF', 'machine evidence must contain valid native receipts');
    requireStrictBuilderFamily(board, id, agentId);
    const familyProblem = builderFamilyProblem(board, getItem(board, id), agentId, familyPolicy);
    if (familyProblem) throw familyProblem;
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
        clausesInspected: found => (board.executionEngineVersion ?? ENGINE_VERSION) >= CLAUSE_INSPECTION_ENGINE && inspect
          ? clauseInspectionProblem(found, itemThread(board, id), { head: commit, greenFiles: greenProofFiles(board, id, commit), gateFiles: new Set((Array.isArray(proof?.files) ? proof.files : []).filter(file => /\.test\.js$/u.test(file))) }) : null,
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
          const runningFile = (board.executionEngineVersion ?? ENGINE_VERSION) >= KNOWN_MAIN_RUNNING_FILE_ENGINE;
          const autoResult = autoMainReds ? fileKnownMainAutofile(board, id, autoOptions, listItems(board, { all: true }), runningFile) : null;
          const autoKnown = autoResult?.known;
          if (autoResult) mainRedRepairs = autoResult.repairs;
          if ((board.executionEngineVersion ?? ENGINE_VERSION) >= SUBMISSION_PROOF_ENGINE) recordedProof = submissionProof(autoKnown ? { ...proof, knownMainFailures: autoKnown } : proof, board.executionEngineVersion ?? ENGINE_VERSION);
          if ((board.executionEngineVersion ?? ENGINE_VERSION) >= KNOWN_MAIN_REWORKS_ENGINE && recordedProof?.knownMainFailures) {
            requireKnownMainReworks(recordedProof.knownMainFailures, listItems(board, { all: true }), id,
              (board.executionEngineVersion ?? ENGINE_VERSION) >= KNOWN_MAIN_OWNER_PATTERN_ENGINE, runningFile);
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
    recordSubmissionEvent(board, id, { agentId, commit, tree, policyCommit, note, recordedProof, infra, tooling,
      modern, gateGreen, companion, quarantineProofIds, carry, mergeOnly, recordedSize, engineVersion: board.executionEngineVersion ?? ENGINE_VERSION });
    startItemPatchObjectionWindow(board, id, { agentId, commit }, { logEvent });
    if ((board.executionEngineVersion ?? ENGINE_VERSION) >= MACHINE_VERDICT_ENGINE
      && options.machineReceipts !== undefined && machineVerificationEligible(board, getItem(board, id), files)) {
      if (gateGreen !== true || companion || recordedProof?.knownMainFailures) throw new Refused('MACHINE_PROOF', 'machine acceptance needs an entirely green composed submission without companions or known reds');
      acceptMachineSubmission(board, getItem(board, id), options, { getItem, moveItem, logEvent });
    }
  });
  if (autoMainReds) return { mainRedRepairs };
}


/** The test files every green proof of this exact commit ran, so a tick naming one of them is already proven. */
function greenProofFiles(board, id, commit) {
  return new Set(proofReceipts(board, id).filter(receipt => receipt.green === true && receipt.commit === commit)
    .flatMap(receipt => (receipt.testRuntimes ?? []).map(row => row?.file).filter(Boolean)));
}
