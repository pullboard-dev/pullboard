import { fileSystemAdapter } from '../../../../fs/index.js';
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
import { clauseInspectionSummary } from '../../../../state/index.js';
import { clauseReceiptNotes } from '../../../../state/index.js';
import { gateClauseTickNotes } from '../../../../state/index.js';
import { clauseTicks } from '../../../../state/index.js';
import { criterionClauses } from '../../../../state/index.js';
import { testCaseTitles } from '../../../../state/index.js';
import { itemThread } from './query.js';
import { proofReceipts } from './query.js';
import { reviewPatchAuthors } from "../../../../verify/index.js";
import { fileKnownMainAutofile } from "../../logic/known/main/autofile.js";
import { KNOWN_MAIN_OWNER_PATTERN_ENGINE } from "../../../../state/light.js";
import { KNOWN_MAIN_RUNNING_FILE_ENGINE } from "../../../../state/light.js";

import { committedItemAuthors } from "../../../../verify/index.js";
import { sealItemPatchSubmit } from "../../../../items/index.js";
import { fileMiss } from "../../../../items/index.js";
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
import { insertItem } from "./add.js";
import { validateItemAddition } from "./add.js";
import { appendFact } from "./fact.js";
import { movesLiveEnabled } from "../../../../config/index.js";
import { loadMachineSettings } from "../../../../config/index.js";
import { boundProofReceipt } from "../receipts.js";
import { movesShadowEnabled } from "../../../../config/index.js";

/** A moves.live machine setting, a file read: call it before a board write opens, never inside one [C7,#8385]. */
export const liveSetting = table => movesLiveEnabled(table);

/** The moves.shadow machine setting, a file read: call it before a board write opens, never inside one [C7,#8379]. */
export const shadowSetting = () => movesShadowEnabled();

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
import { sendBackDependents } from './item/after-gate.js';
import { recordAfterGateRebuild } from './item/after-gate-report.js';
import { reopen } from './reopen.js';
import { release } from './release.js';

const fs = fileSystemAdapter();
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
  // Once review defaults are active an edit in place to a gate path is standard, so only a configured sensitive path's rename stays strict [C7,#8575].
  const defaults = Boolean(board.db.prepare("SELECT 1 FROM board_meta WHERE meta_key='review_default:active'").get());
  const strictRenames = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++], oldPath = fields[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const newPath = fields[i++];
      const sensitive = configured.some(path => oldPath === path || path.endsWith('/') && oldPath.startsWith(path));
      if (status.startsWith('R') && (!defaults && gateJudgmentPath(oldPath) || sensitive)) strictRenames.push([oldPath, newPath]);
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
  PREPARED_SUBMITS.set(prepared, { board, id, snapshot: sealed, reads: submitReads(board, id, prepared) });
  return prepared;
}

/**
 * The reads a submit takes that do not depend on its own write: the builder-family policy, the moves.shadow and
 * moves.live settings, and the green proofs and committed case titles a native clause inspection reads.
 * Why here: a submit preflight dry-runs the whole submit inside one rolled-back write, so every read in submit() held
 * the board's one write lock (756 preflight holds, 3.5 M ms in #10713). Read with no lock held and bound to the
 * prepared snapshot, so the writer still refuses a board that changed since (#10850) [C7].
 */
function submitReads(board, id, options) {
  const { commit, policyCommit = null, clausePolicyCommit, submissionProof: proof, inspectClauses, titleTicks } = options;
  const familyPolicyCommit = policyCommit ?? clausePolicyCommit;
  const familyPolicy = (board.executionEngineVersion ?? ENGINE_VERSION) >= BUILDER_FAMILY_REQUIRED_ENGINE && board.gitRoot && familyPolicyCommit
    ? board.enginePorts.sandboxPolicyReads.policyAt(board.gitRoot, familyPolicyCommit).config.verify.family : 'off';
  // A replayed submit decides inspection from its recorded policy in submit(); only the native seal is known here.
  const proofs = board.executionEngineVersion === undefined && ENGINE_VERSION >= CLAUSE_INSPECTION_ENGINE && inspectClauses === true
    ? inspectionReads(board, id, commit, proof, titleTicks === true) : null;
  // The moves.shadow and moves.live.submit settings are file reads, so they are read here, before any write opens [C7,#8379,#8384].
  return { familyPolicy, proofs, shadow: board.movesShadow ?? shadowSetting(), live: (board.movesLive?.submit ?? movesLiveEnabled('submit')) === true };
}

/** The green proofs of this exact commit and, with titleTicks, the case titles its proof files declare there. */
function inspectionReads(board, id, commit, proof, titleTicks) {
  return { greenFiles: greenProofFiles(board, id, commit), outcomes: greenProofOutcomes(board, id, commit),
    cases: titleTicks ? committedTitleCases(board, commit, proof?.files) : [] };
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
 * @param {{ agentId: string, commit: string, tree: string, files?: string[], policyCommit?: string, note?: string }} options - `files`: what the
 *   item's own commits changed since its claim; a rework adds to what the first attempt changed.
 */
export function submit(board, id, options) {
  options = prepareSubmit(board, id, options);
  const { snapshot, reads } = PREPARED_SUBMITS.get(options);
  requireBoardWriteSnapshot(board, snapshot, 'submit');
  const { strictRenames, agentId, commit, tree, files = [], policyCommit = null, note, submissionProof: proof, submissionSize: size, inspectClauses, folderTicks: sealedFolderTicks, titleTicks: sealedTitleTicks, clausePolicyCommit, infra = null, gateGreen, companion, pulledPlan = null, quarantineProofIds, autoMainReds, mergeOnly: recordedCarry, tooling = null } = options;
  const { familyPolicy, shadow, live } = reads;
  let inspect = inspectClauses === true, folderTicks = sealedFolderTicks === true, titleTicks = sealedTitleTicks === true;
  if (board.executionEngineVersion !== undefined && board.executionEngineVersion >= CLAUSE_INSPECTION_ENGINE && board.gitRoot) {
    if (!clausePolicyCommit || clausePolicyCommit !== policyCommit) throw new Refused('NO_POLICY', 'the sealed inspection policy must match the submission policy');
    const policy = board.enginePorts.sandboxPolicyReads.policyAt(board.gitRoot, clausePolicyCommit);
    inspect = policy.config.verify.inspectClauses === true; folderTicks = policy.config.verify.folderTicks === true; titleTicks = policy.config.verify.titleTicks === true;
    if (inspect !== (inspectClauses === true)) throw new Refused('NO_POLICY', 'the sealed inspection setting does not match its accepted policy');
  }

  const autoOptions = { agentId, commit, tree, policyCommit, companion, autoMainReds, submissionProof: proof };
  if (autoMainReds && board.executionEngineVersion === undefined) autoOptions.autoMainReds = board.enginePorts.sealKnownMainAutofile(board, id, autoOptions).autoMainReds;
  let recordedProof;
  let recordedSize;
  let mainRedRepairs;
  if (companion) {
    // pulledPlan: a pulled gate's own plan, which the board host read from the runner's receipt [P7].
    const options = { agentId, commit, tree, gateGreen, policyCommit, submissionProof: proof, companion, pulledPlan };
    if (board.executionEngineVersion === undefined) sealItemPatchSubmit(board, id, options);
    else checkItemPatchSubmit(board, id, options);
  }
  if (note !== undefined && (typeof note !== 'string' || !note.trim() || /[\r\n\u2028\u2029]/u.test(note))) {
    throw new Refused('USAGE', 'a submission note, when present, is one nonempty line');
  }
  const clauseInspection = (found, { greenFiles, outcomes, cases }) => clauseInspectionProblem(found, itemThread(board, id), { head: commit, greenFiles,
    gateFiles: new Set((Array.isArray(proof?.files) ? proof.files : []).filter(file => /\.test\.js$/u.test(file))), folderTicks, titleTicks, cases, outcomes });
  // shadow: the commit compare is recorded under moves.shadow; live: with moves.live.submit on, the COMMIT table's event is the one logged [C7,#8379,#8384].
  atomic(board, () => {
    requireBoardWriteSnapshot(board, snapshot, 'submit');
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
          ? clauseInspection(found, reads.proofs ?? inspectionReads(board, id, commit, proof, titleTicks)) : null,
        criterionUnchanged: null,
        treeClean: null,
        nothingUntracked: null,
        hasCommit: null,
        withinLane: null,
        trunkMergeClean: null,
        trunkInCandidate: null,
        noUnverifiedStack: null,
        infraExplained: null, // The CLI checks the claimed Git diff before this transition.
        doctrineHolds: null,
        gateConfigured: null, queuedItemLease: null,
        gateGreen: null,
        proofRecorded: null, // The CLI records and validates native receipts before sealing submit; replay needs no origin files.
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
      modern, gateGreen, companion, quarantineProofIds, carry, mergeOnly, recordedSize, engineVersion: board.executionEngineVersion ?? ENGINE_VERSION, shadow, live });
    // claims.fileLease on: a submission whose changed files part from the predicted ones leaves a miss on the item [C7,#8522].
    const miss = board.fileLease && !carry ? fileMiss(getItem(board, id), files, board.fileLease.hubs) : null;
    if (miss) logEvent(board, agentId, 'file_miss', id, miss);
    startItemPatchObjectionWindow(board, id, { agentId, commit }, { logEvent });
    // A parent resubmitted at a new head sends back each dependent built on the old one [C7,#11808].
    sendBackDependents(board, id, { head: commit }, { reopen, release, appendFact, recordAfterGateRebuild });
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

/** The per-case outcomes every green proof of this exact commit recorded, so a file whose cases were all skipped is not proof. */
function greenProofOutcomes(board, id, commit) {
  return proofReceipts(board, id).filter(receipt => receipt.green === true && receipt.commit === commit)
    .flatMap(receipt => Array.isArray(receipt.testOutcomes) ? receipt.testOutcomes : []);
}

const EDGE_FILED = /^Edge follow-up filed as #\d+/u;

/**
 * File the one follow-up item for the import edges a settled submission adds, under the submitted item, and note it there.
 * Nothing is filed for no edge or when an earlier settle already filed one. Why here: the submitter holds a claim and may change
 * only that item, so the board host files it at settle, as it files main-red repairs; one per item, not one per resubmit (#8874) [C7].
 *
 * @param {any} board
 * @param {number} id - The submitted item.
 * @param {{ agentId: string, edges: { from: string, to: string }[] }} filing
 * @returns {number | null} The follow-up's id, or null when none was filed.
 */
export function fileEdgeFollowUp(board, id, { agentId, edges }) {
  if (!edges.length || itemThread(board, id).some(entry => entry.type === 'fact' && EDGE_FILED.test(String(entry.text)))) return null;
  const listed = edges.slice(0, 12).map(edge => `${edge.from} -> ${edge.to}`).join('\n');
  const plural = edges.length === 1 ? '' : 's';
  const item = { by: agentId, lane: getItem(board, id).item_lane, title: `Review the ${edges.length} import edge${plural} added by #${id}`, route: 'strong', specIds: [], parentId: id, after: [],
    criterion: '1. Each import edge listed in the brief is kept or removed, with the reason given [reasoning].',
    brief: `Filed when the gate settled #${id}, whose diff adds ${edges.length} import edge${plural}:\n${listed}${edges.length > 12 ? `\n... and ${edges.length - 12} more` : ''}` };
  return atomic(board, () => {
    const filed = insertItem(board, item, validateItemAddition(board, item));
    appendFact(board, id, { agentId, kind: 'note', text: `Edge follow-up filed as #${filed}: ${edges.length} new import edge${plural} (submit.edgeFollowUps).` });
    return filed;
  });
}

/** The case titles the proof's test files declare at the submitted commit, for verify.titleTicks (#8880) [C7]. */
function committedTitleCases(board, commit, files) {
  return (Array.isArray(files) ? files : [])
    .flatMap(file => { const shown = tryGit(board.gitRoot, ['show', `${commit}:${file}`]); return shown.status === 0 ? testCaseTitles(file, shown.stdout) : []; });
}

/** A run id (UUID) holds hex groups a sha reader would take for commits, so it is cut from a tick before its shas are read. */
const RUN_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gu;
const CITED_SHA = /\b[0-9a-f]{7,40}\b/gu;
/** The stable ID that opens a case title, such as `store.io-board-submit.some-case:`. */
const CASE_ID = /^([a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9-]*)+):/u;

/**
 * One note per [test] clause (declared or undeclared) the holder has not ticked at `head` whose latest tick by an earlier
 * author names gate-run test files that a green gate passed at `head` and that hold the same content at a commit the tick
 * cites. The note names the gate run, the head, the earlier author and the cited commit, so the thread keeps which run
 * proved the clause and which tick mapped it to its files. [command], [measurement], [reasoning] and [screenshot] clauses
 * never carry. Why: a rework seat merges main and resubmits, the earlier holder's ticks cite older heads, a sharded gate's
 * combined proof keeps no per-case outcomes, and accept refused CLAUSE_UNTICKED on a green gate (#9176, #11858) [C7].
 *
 * @param {object} board - The open board; board.gitRoot holds the cited commits.
 * @param {object} item - The submitted item.
 * @param {object[]} thread - The item's thread, oldest first.
 * @param {{ gateFiles: Set<string>, outcomes?: { file: string, name: string, passed: boolean, skipped: boolean }[], head: string }} run - Files the green gate ran, its per-case outcomes and the head it proved.
 * @returns {string[]} Note texts for the item's thread.
 */
export function carriedClauseTickNotes(board, item, thread, { gateFiles, outcomes = [], head }) {
  if (!board.gitRoot || !/^[0-9a-f]{7,64}$/u.test(String(head ?? ''))) return [];
  const rows = Array.isArray(outcomes) ? outcomes.filter(row => row && typeof row.file === 'string' && typeof row.name === 'string') : [];
  const criterion = item.item_criterion;
  const held = clauseTicks(thread, item.item_owner, { criterion, head });
  const latest = new Map();
  for (const entry of thread) if (entry.type === 'fact' && entry.kind === 'note' && entry.by && entry.by !== item.item_owner) { latest.delete(entry.by); latest.set(entry.by, true); }
  const authors = [...latest.keys()].reverse().map(author => ({ author, ticks: clauseTicks(thread, author, { criterion }) }));
  const shown = new Map();
  const content = (sha, file) => {
    const key = `${sha}:${file}`;
    if (!shown.has(key)) { const read = tryGit(board.gitRoot, ['show', key]); shown.set(key, read.status === 0 ? String(read.stdout) : null); }
    return shown.get(key);
  };
  const notes = [];
  for (const clause of criterionClauses(criterion)) {
    if (held.has(clause.number) || (clause.kind !== null && clause.kind !== 'test')) continue;
    for (const { author, ticks } of authors) {
      const tick = ticks.get(clause.number);
      if (tick?.kind !== 'test') continue;
      const named = new Set([...gateFiles].filter(file => file && tick.evidence.includes(file)));
      const cases = rows.filter(row => gateFiles.has(row.file) && tick.evidence.includes(CASE_ID.exec(row.name)?.[1] ?? '\0'));
      for (const row of cases) named.add(row.file);
      if (!named.size) continue;
      const ran = rows.filter(row => named.has(row.file));
      if (ran.some(row => !row.skipped && !row.passed) || cases.some(row => row.skipped || !row.passed)) continue;
      if ([...named].some(file => ran.some(row => row.file === file) && !ran.some(row => row.file === file && row.passed && !row.skipped))) continue;
      const cited = String(tick.evidence).toLowerCase().replace(RUN_ID, ' ').match(CITED_SHA) ?? [];
      const sha = cited.find(one => [...named].every(file => { const before = content(one, file); return before !== null && before === content(head, file); }));
      if (!sha) continue;
      const files = [...named].sort().join(' ');
      notes.push(`clause ${clause.number} [test]: gate run of ${files} green at ${String(head).slice(0, 12)}, carried from ${author}'s tick at ${sha.slice(0, 12)}; ${files} unchanged since ${sha.slice(0, 12)}`);
      break;
    }
  }
  return notes;
}

/**
 * The clause checklist notes a settled submission earns, as the inline submit appended them: a green gate's tick note
 * for each [test] clause naming a file it ran green, then the "inspection, clause by clause:" summary. Why here: the
 * pulled settle runs on the board host and reaches the clause readers only through this cell [C7,V4].
 *
 * @param {object} board - The open board.
 * @param {number} id - The submitted item.
 * @param {{ gateFiles: Set<string>, outcomes: object[], head: string, green: boolean, folderTicks?: boolean, titleTicks?: boolean }} run - Files the gate ran, their per-case outcomes, the head proved, whether the gate was green, and main's verify.folderTicks (#8847).
 * @param {(text: string) => void} append - Appends one note, so each tick is on the thread before the summary reads it.
 */
export function clauseInspectionNotes(board, id, { gateFiles, outcomes, head, green, folderTicks = false, titleTicks = false }, append) {
  if (green) for (const text of gateClauseTickNotes(getItem(board, id), itemThread(board, id), { gateFiles, outcomes, head, folderTicks, titleTicks })) append(text);
  if (green) for (const text of carriedClauseTickNotes(board, getItem(board, id), itemThread(board, id), { gateFiles, outcomes, head })) append(text);
  // The fail-before, pass-after receipt, stored once: the gate's green head rows against the recorded runs of the base commit [C7].
  const base = getItem(board, id).item_claim_head;
  if (green) for (const text of clauseReceiptNotes(getItem(board, id), itemThread(board, id), { gateFiles, baseRows: recordedBaseRows(board, base), outcomes, head, baseCommit: base })) append(text);
  const summary = clauseInspectionSummary(getItem(board, id), itemThread(board, id), { gateFiles, head, folderTicks, titleTicks, cases: outcomes });
  if (summary) append(summary);
}

/**
 * The outcome rows of every recorded main comparison of the item's base commit: the base half of a clause's
 * fail-before receipt. Why: the gate's receipt store already holds each case's outcome and failure kind (#8049), so the
 * judge reads what ran and nothing reruns at submit [C7].
 *
 * @param {object} board - The open board, whose native ports find its receipt store.
 * @param {string | null | undefined} base - The item's base commit (claim head).
 * @returns {{ file: string, name: string, passed: boolean, skipped: boolean, failure?: string }[]} Empty when none was recorded.
 */
export function recordedBaseRows(board, base) {
  const { boardReceiptStore, readGateReceipt } = board.nativePorts?.patchProof ?? {};
  if (!/^[a-f0-9]{40}$/u.test(base ?? '') || !boardReceiptStore) return [];
  const store = boardReceiptStore(board);
  let names = [];
  try { names = store ? fs.list(store) : []; } catch { return []; }
  const listed = new Set(names);
  const known = MAIN_RED_ROWS.get(store) ?? new Map();
  MAIN_RED_ROWS.set(store, known);
  for (const name of known.keys()) if (!listed.has(name)) known.delete(name);
  return names.filter(name => /^[a-f0-9-]{36}\.json$/u.test(name)).flatMap(name => {
    if (!known.has(name)) {
      const receipt = readGateReceipt(store, name.slice(0, -5));
      // A receipt that did not read (still being written) is not remembered, so the next call reads it again.
      if (!receipt) return [];
      known.set(name, receipt.kind === 'main-red' && Array.isArray(receipt.testOutcomes) ? { head: receipt.head, testOutcomes: receipt.testOutcomes } : null);
    }
    const row = known.get(name);
    return row && row.head === base ? row.testOutcomes : [];
  });
}

/** What recordedBaseRows kept of each receipt file already read, by receipt store path: null for a receipt that is not main-red. A receipt file never changes once written, so each is read once per process [C7]. */
const MAIN_RED_ROWS = new Map();

/**
 * Record the machine accept for a green pulled gate receipt on a submitted, machine-eligible item; false when the receipt
 * is not green, names no receipts, or the item is not eligible. Why: c77c8f38cf made submit pulled-only and dropped the
 * machine-verified path, so the receipt side is the one place the proof of a pulled gate can stand in for a reviewer [C7,#10253].
 */
export function acceptPulledMachine(board, run, summary) {
  const ids = summary?.machineReceipts;
  if (run.run_item == null || summary?.gate?.green !== true || !Array.isArray(ids) || !ids.length) return false;
  const item = getItem(board, run.run_item);
  if (item?.item_status !== 'submitted') return false;
  const files = (item.item_files ?? '').split('\n').filter(Boolean);
  const options = { commit: item.item_commit, tree: item.item_tree, policyCommit: run.run_base ?? summary.gate.source, agentId: item.item_built_by, files,
    machineReceipts: ids.map(receiptId => boundProofReceipt(board, { receiptId })) };
  return Boolean(acceptMachineSubmission(board, item, options, { getItem, moveItem, logEvent }));
}

/**
 * The first failing clause of a pulled gate's machine receipts, by clause number (0 is the frozen check), or null when none
 * failed or the item is not machine-eligible. A receipt fails when it is not green or its command exited non-zero [C7,#10254].
 *
 * @returns {{ clause: number, command: string, receipt: string } | null}
 */
export function failedMachineClause(board, run, summary) {
  const ids = summary?.machineReceipts;
  if (run.run_item == null || !Array.isArray(ids) || !ids.length) return null;
  const item = getItem(board, run.run_item);
  if (item?.item_status !== 'submitted') return null;
  const files = (item.item_files ?? '').split('\n').filter(Boolean);
  const authorization = machineVerificationEligible(board, item, files);
  if (!authorization) return null;
  const commands = [{ clause: 0, command: JSON.parse(item.item_frozen).check }, ...authorization.commands];
  for (const [index, entry] of commands.entries()) {
    if (ids[index] === undefined) return null;
    const receipt = boundProofReceipt(board, { receiptId: ids[index] });
    if (receipt.green !== true || (receipt.proof?.exitCode ?? 0) !== 0) return { clause: entry.clause, command: entry.command, receipt: receipt.id };
  }
  return null;
}

/** Whether a green pulled gate may record the machine accept (#10253): off by default; only an exact `true` turns it on. */
export function machineVerifyPulledOn() {
  return loadMachineSettings().gate?.machineVerifyPulled === true;
}
