import { parseSpec } from '../../../../../packages/spec/light.js';
import { environmentAdapter } from '../../../../../packages/env/index.js';
import { submitReferenceReminders } from '../../../../../packages/spec/index.js';
import { committedReader } from '../../../../../packages/moves/index.js';
import { requireKernelApproval } from '../../../../../packages/verify/index.js';
import { frozenTestsProblem } from '../../../../../packages/verify/index.js';
import { authorSplitProblem } from '../../../../../packages/verify/index.js';
import { testAuthorNotes } from '../../../../../packages/verify/index.js';
import { seatFamily } from '../../../../../packages/items/index.js';
import { itemFolderIdentity } from '../item/folder.js';
import { itemFolderPath } from '../item/folder/identity.js';
import { seatRoot } from '../item/folder/identity.js';
import { writeItemMarker } from '../item/folder/identity.js';
import { pushHostedItemBranch } from '../../../../../packages/runners/index.js';
import { checkoutBranch } from '../../../../../packages/git/index.js';
import { heartbeatCommand } from '../presence.js';
import { mergeSubmissionMain } from '../../../../../packages/merge/index.js';
import { composeSubmissionMain } from '../../../../../packages/merge/index.js';
import { requireNonEmptySubmit } from '../empty.js';
import { proofOnlyTicked } from '../empty.js';
import { submitProofOnly } from '../../../../../packages/config/index.js';
import { submitComposeAsObject } from '../../../../../packages/config/index.js';
import { composesOnRunner } from '../submit/handoff/compose-on-runner.js';
import { submitClauseMarks } from '../../../../../packages/config/index.js';
import { criterionClauses } from '../../../../../packages/state/index.js';
import { clauseInspectionProblem } from '../../../../../packages/state/index.js';
import { clauseReceiptProblem } from '../../../../../packages/state/index.js';
import { staleHeadLines } from '../../../../../packages/state/index.js';
import { checkRunTickNotes } from '../../../../../packages/state/index.js';
import { testRunTickNotes } from '../../../../../packages/state/index.js';
import { recordedToolCommits } from '../../../../../packages/git/index.js';
import { toolRegenerationSource } from '../../../../../packages/git/index.js';
import { regenerateToolChange } from '../../../../../packages/sandbox/index.js';
import { regenerateDeclaredFiles } from '../../../../../packages/gate/heavy.js';
import {
  pendingSubmitHandoff,
  submitHandoff,
} from '../../../../../packages/store/index.js';
import {
  isSubmitHandoffWorker,
  copySubmitHandoffOrigin,
  submitHandoffPolicy,
  requireSubmitHandoffExecution,
} from '../../../../../packages/sandbox/index.js';
import { machineVerificationEligible } from '../../../../../packages/verify/index.js';
import { join } from 'node:path';
export { doctrineExecutionPhases } from '../submit/gate.js';
import { gateRunnerAdmission } from '../../../../../packages/config/index.js';
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { submitAuthorizationMode } from '../../../../../packages/config/index.js';
import { withBoardRead as waitBoardRead } from '../context.js';
import { prepareItemPatchSubmit } from '../../../../../packages/items/index.js';
import { normalizeItemPatch } from '../../../../../packages/items/index.js';
import { validateItemPatchInput } from '../../../../../packages/items/index.js';
import { completeMoveHandoff } from '../../../../../packages/verify/index.js';
import {
  barReadySetting,
  barReadyProblem,
} from '../../../../../packages/verify/index.js';
import { barCheckWarning } from '../../../../../packages/verify/index.js';
import { barCheckState } from '../../../../../packages/verify/index.js';
import { dryRunReviewChecklist } from '../../../../../packages/verify/index.js';
import { dryRunReviewArm } from '../../../../../packages/verify/index.js';
import { dryRunReviewMode } from '../../../../../packages/verify/index.js';
/** The pullboard submit command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import { agentSessionDigest } from '../../../../../packages/person/index.js';
import {
  refuseProvesNothing,
} from '../../../../../packages/verify/index.js';
import {
  COORDINATOR,
} from '../../../../../packages/config/index.js';
import {
  contains,
  git,
  headCommit,
  isClean,
  treeUntouched,
  tryGit,
  untracked,
} from '../../../../../packages/git/index.js';
import {
  machineNameProblems,
} from '../../../../../packages/commits/index.js';
import * as infraNotes from '../../../../../packages/commits/index.js';
import { checkRangeMessages } from '../../../../../packages/commits/light.js';
import {
  pairPrefix,
} from '../../../../../packages/flakes/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  relayRecovered,
} from '../../../../../packages/link/index.js';
import { requireRedSubmitProgress } from '../submit/red-progress.js';
import { restoreMergedHead } from '../submit/red-progress.js';
import { refuseHeldElsewhere } from '../../../../../packages/seats/index.js';
import { submitPreflight } from '../../../../../packages/items/index.js';
import {
  refuseUnreviewable,
} from '../../../../../packages/verify/index.js';
import { changedLines } from '../../../../../packages/items/index.js';
import { missingCheckFiles } from '../../../../../packages/items/index.js';
import { refuseMissingCheckFile } from '../../../../../packages/config/index.js';
import { pendingFromJobRow } from '../../../../../packages/config/index.js';
import { recoverFromJobRow } from '../../../../../packages/config/index.js';
import { gateJunitReport } from '../../../../../packages/config/index.js';
import {
  dependencySnapshots,
  frozenCheck,
  itemPolicy,
  mainPolicy,
  policyAt,
  requireTrunkMerge,
  submissionPaths,
} from '../../../../../packages/sandbox/index.js';
import { nextOnce } from '../entry.js';
import { withBoardRead } from '../entry.js';
import { context } from '../entry.js';
import { filesSince } from '../entry.js';
import { gateTestFiles } from '../entry.js';
import { titleCases } from '../submit.js';
import { junitTickNotes } from '../submit.js';
import { clauseMarksNote } from '../submit.js';
import { freezer } from '../entry.js';
import { idArg } from '../entry.js';
import { ordered } from '../entry.js';
import { refuseUnsubmittableStack } from '../entry.js';
import { reportSubmission } from '../entry.js';
import { whoAmI } from '../entry.js';
import { claimOrdered } from '../entry.js';
import { claimFreezer } from '../entry.js';
import { withBoard } from '../entry.js';
import { resourceAgent } from '../board/access.js';
import { recordBaseRunsForSubmit } from '../submit/clause-base.js';
import { recordMainComparison } from '../../../../../packages/flakes/index.js';
import { actOn } from '../entry.js';
import { recordedRecovery } from '../../../../../packages/state/index.js';
import { topUpClaims } from '../next.js';
import { mainRedBaselinesToRetake } from '../../../../../packages/store/index.js';
import { mainRedItemCases } from '../../../../../packages/store/index.js';
import { checkBaseline as retakeCheckBaseline } from '../../../../../packages/gate/heavy.js';
import { waitForSubmitGate } from '../submit/wait.js';
import { runStaticPreflight } from '../submit/preflight.js';
import { requireStaticPreflight } from '../submit/preflight.js';
import { changedSince } from '../submit/preflight.js';
import { requireSlicePaths } from '../submit/slice-paths.js';
import { recordGateSpan } from '../../../../../packages/resources/index.js';
import { reportPreflight } from '../submit/preflight.js';

/**
 * Report wall time without sharing the execution closures of unrelated submit stages, and record it as the stage's span for an open gate's telemetry [C7].
 */
function reportSubmitStage(ctx, name, start) {
  const elapsed = performance.now() - start;
  ctx.io.say(`submit ${name}: ${(elapsed / 1000).toFixed(2)}s`);
  const end = Date.now();
  recordGateSpan({ phase: name === 'authorization and source' ? 'authorization' : name.replaceAll(' ', '-'), start: end - elapsed, end, outcome: 'done' });
}

/** Write one phase's wall time to stderr when PULLBOARD_SUBMIT_MARKS is set, so a slow submit names the phase that spent it [C7]. */
export function submitMark(phase, startMs) {
  if (environmentAdapter().get('PULLBOARD_SUBMIT_MARKS')) process.stderr.write(`submit-mark ${phase}: ${Date.now() - startMs} ms\n`);
}

/**
 * Run one step of the authorization stage and record it as its own gate span (phase "authorization-<step>"), so the
 * stage's median can be traced to the step that spends it: the whole stage had no sub-spans (p50 14.5 s, 584 spans) [C7].
 *
 * @template T
 * @param {string} step
 * @param {() => T} work
 * @returns {T}
 */
function authorizationStep(step, work) {
  const start = Date.now();
  const finish = outcome => { submitMark(`authorization/${step}`, start); recordGateSpan({ phase: `authorization-${step}`, start, end: Date.now(), outcome }); };
  let value;
  try { value = work(); } catch (error) { finish('failed'); throw error; }
  if (typeof value?.then !== 'function') { finish('done'); return value; }
  return /** @type {any} */ (value.then(result => { finish('done'); return result; }, error => { finish('failed'); throw error; }));
}

/**
 * Submit: a clean tree, nothing untracked, the gate green at HEAD, then the board (V4).
 *
 * The cheap checks run before the gate, so a submit that cannot succeed fails fast.
 *
 * @param {any} ctx
 * @param {number} id
 * @returns {Promise<number>}
 */
/** Keep the full failure list in the item fact and bound the automatic decision shout. */
export function boundedMainRedShout(id, failures, main) {
  const prefix = `#${id}: known main red with no open Main red item: `;
  const suffix = ` fails identically on main at ${main.slice(0, 12)}; file or assign its repair. See pullboard show ${id}.`;
  const detail = failures.map(red => `${red.file} (${red.names.join('; ')})`).join('; ');
  const room = Math.max(0, 400 - Array.from(prefix + suffix).length);
  const chars = Array.from(detail);
  const excerpt = chars.length > room ? chars.slice(0, Math.max(0, room - 1)).join('') + '…' : detail;
  return prefix + excerpt + suffix;
}

/**
 * Which red check cases open Main red repairs' own checks fail on this main. A repair whose recorded baseline names no
 * failing case, or was taken on another main, is re-taken on this main first (#2594).
 */
export function mainRedCheckCases(root, failures, items, id, main, retaken) {
  const files = [...new Set(failures.map(row => row.file))];
  for (const item of mainRedBaselinesToRetake(items, files, id, main)) {
    if (!retaken.has(item.item_id)) retaken.set(item.item_id, retakeCheckBaseline(root, item.item_check, { main }));
  }
  return mainRedItemCases(failures, items, id, main, retaken);
}

/** The tree of a commit, which for a composed submit is not the checkout's tree. */
function commitTree(root, commit) { return git(root, ['rev-parse', `${commit}^{tree}`]).trim(); }

/**
 * Submit the item from the checkout it is built in, running the submit checks and recording the move.
 *
 * @param {object} ctx
 * @param {number} id
 * @param {object} infra
 * @param {object|null} [companionInput]
 * @returns {Promise<*>}
 */
export async function submitHere(ctx, id, infra, companionInput = null) {
  const { root } = ctx.info;
  const submitVerify = (submitHandoffPolicy(ctx) ?? mainPolicy(root)).config.verify;
  const inspectClauses = submitVerify.inspectClauses === true;
  const failBefore = submitVerify.failBefore === true;
  const folderTicks = submitVerify.folderTicks === true, titleTicks = submitVerify.titleTicks === true, gateFilesOf = item => gateTestFiles(root, item, { folderTicks, titleTicks }); // verify.folderTicks (#8847), verify.titleTicks (#8880) [C7]
  const recovered = relayRecovered(root, {}, ctx.io);
  if (recovered?.operation === 'submit' && recovered.args[0] === id) {
    const preflight = withBoard(ctx, (board) => {
      const me = whoAmI(ctx, board);
      if (recovered.args[1]?.agentId !== me.id) return null;
      if (recordedRecovery(board, recovered)) return { me, recorded: true };
      const item = store.getItem(board, id);
      const trunk = requireTrunkMerge(root, recovered.args[1].commit);
      requireKernelApproval(board, { root, base: trunk.commit, commit: recovered.args[1].commit, item: id });
      if (barReadySetting(board).enabled && (recovered.args[1].policyCommit !== trunk.commit || !contains(root, trunk.commit, recovered.args[1].commit))) {
        throw new Refused('MAIN_NOT_COMPOSED', 'the unrecorded recovered submission has no proof for current main; run pullboard inbox to synchronize its original receipt, or ask the coordinator to resolve the pending move before a fresh submit; the original request is retained');
      }
      refuseUnsubmittableStack(root, board, item, recovered.args[1].commit, trunk);
      return { me, recorded: false };
    });
    if (preflight) {
      await withBoard(ctx, async (board) => await ordered(ctx, board, 'submit', recovered.args));
      return reportSubmission(ctx, id, recovered.args[1].commit,
        { green: true, report: 'recovered the original submission; its gate ran before the original send' });
    }
  }
  // A pulled submit's own move is its gate-offer note; a lost reply to it is answered with the job it already offered [C7,H16].
  if (recovered?.operation === 'appendFact' && recovered.args[0] === id) {
    const offered = await (await import('../submit/pull.js')).recoverOfferedGate(ctx, id, recovered);
    if (offered !== null) return offered;
  }
  // With submit.recoverFromJobRow on and no note held, the gate job row this seat offered answers instead [C7,#9825].
  if (!recovered && recoverFromJobRow()) {
    const offered = await (await import('../submit/pull.js')).recoverOfferedGateFromJobRow(ctx, id);
    if (offered !== null) return offered;
  }
  // gate.runnersOnly means no gate runs on this computer: with no registered runner a pulled submit would queue for the loopback local runner or wait forever, so refuse before any job row, read here in the IO layer [C7,V4,#9398].
  if (gateRunnerAdmission().runnerOnly && !(loadMachineSettings().runners ?? []).length) {
    throw new Refused('RUNNER_WAIT_DEADLINE', `gate.runnersOnly is on and no runner is registered, so the gate for #${id} has nowhere to run`, 'register a runner with pullboard runner add, or turn the setting off with pullboard settings gate.runnersOnly off, then retry');
  }
  const preflightStart = performance.now();
  // The fail-before check reads a base run of each [test] clause's file; produce it first, only when that check is on [C7,#8090].
  if (inspectClauses && failBefore) await authorizationStep('clause-base-runs', () => recordBaseRunsForSubmit(ctx, id, { withBoard, ordered, resourceAgent, store, gateTestFiles: (_root, item) => gateFilesOf(item), recordMainComparison }));
  const held = await authorizationStep('claim-check', () => withBoard(ctx, async (board) => {
    const me = whoAmI(ctx, board);
    const item = store.getItem(board, id);
    const folder = itemFolderIdentity(board, ctx.info.root);
    if (folder && folder.item !== id) throw new Refused('NOT_YOURS', `this folder belongs to item #${folder.item}; submit that item from here`);
    if (!isSubmitHandoffWorker(ctx) && !folder) refuseHeldElsewhere(ctx.info, store.listAgents(board), item, 'submit', agentSessionDigest);
    if (item.item_status !== 'claimed' || item.item_owner !== me.id) throw new Refused('NOT_YOURS', 'claim this item before submitting it');
    if (!isSubmitHandoffWorker(ctx)) heartbeatCommand(ctx.io, { ctx, board });
    const reviewMode = dryRunReviewMode(board);
    const reviewArm = dryRunReviewArm(reviewMode, id);
    // Under ab every submitted item records the arm it received, and the on arm prints the checklist without the flag [C7].
    if (reviewMode === 'ab') await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note', text: `dry-run review arm: ${reviewArm}` }]);
    if (reviewMode === 'ab' ? reviewArm === 'on' : ctx.dryRunReview && reviewMode !== false) {
      // Advisory only: print the verifier checklist before any clause refusal and record that it ran; off prints and records nothing [C7].
      for (const line of dryRunReviewChecklist({ id, clauses: criterionClauses(item.item_criterion), criterion: item.item_criterion, barNote: barCheckState(board, item).note })) ctx.io.say(line);
      await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note', text: 'dry-run review ran: checklist printed to the builder before submit; advisory, not a verdict' }]);
    }
    const readiness = barReadyProblem(board, item);
    if (readiness) throw readiness;
    // With gate.junitReport set, the builder's JUnit report ticks the [test] clauses whose named cases passed and names failing ones; unset (the default) adds nothing [C7,#9727].
    const reportPath = inspectClauses ? gateJunitReport() : null;
    if (reportPath) {
      const junit = junitTickNotes(root, item, store.itemThread(board, id), headCommit(root), reportPath);
      for (const text of junit.notes) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note', text }]);
      for (const row of junit.failed) ctx.io.say(`JUnit report ${reportPath}: case "${row.name}" failed, so clause ${row.number} stays unticked`);
    }
    const clauseProblem = inspectClauses ? authorizationStep('clause-inspection', () => clauseInspectionProblem(item, store.itemThread(board, id), { gateFiles: gateFilesOf(item), head: headCommit(root), folderTicks, titleTicks, cases: titleTicks ? titleCases(root, gateFilesOf(item)) : [] })) : null;
    if (clauseProblem) throw clauseProblem;
    // A [test] clause also needs a recorded run that failed on an assertion at the item's base (fail-before, pass-after) [C7].
    const receiptProblem = inspectClauses && failBefore ? clauseReceiptProblem(item, { gateFiles: gateFilesOf(item), baseRows: store.recordedBaseRows(board, item.item_claim_head), baseCommit: item.item_claim_head }) : null;
    if (receiptProblem) throw new Refused('CLAUSE_UNTICKED', receiptProblem.message, receiptProblem.next);
    // A clause whose only evidence cites an earlier head is named before the gate queues, so the builder refreshes it (#3752).
    if (inspectClauses) for (const line of staleHeadLines(item, store.itemThread(board, id), headCommit(root))) ctx.io.say(line);
    const correction = store.pendingRefreezeProblem(board, id);
    if (correction) {
      await claimOrdered(ctx, board, [id, { agentId: me.id, lane: me.lane, leaseMs: ctx.config.leaseMs,
        freeze: claimFreezer(ctx, board), head: headCommit(root) }]);
      return store.getItem(board, id);
    }
    return item;
  }));
  ctx.submitAttempt = { agentId: held.item_owner, digest: held.item_frozen_digest };
  ctx.submitAttempt.stage = 'fast';
  const policy = itemPolicy(root, held);
  let acceptedMain = submitHandoffPolicy(ctx) ?? mainPolicy(root);
  // Fail fast, cheapest first: a dirty tree or a change that conflicts with main is refused before any other work, check or test.
  // One status clears an untouched tree; only a tree it flags is read again to say which refusal applies.
  const dirty = authorizationStep('tree-state', () => !treeUntouched(root) && !isClean(root));
  if (dirty) {
    // Preserve the typed grammar refusal without starting gates for a dirty candidate.
    try { parseSpec(fs.readFile(join(root, ctx.config.spec || 'SPEC.md'), 'utf8')); }
    catch (error) { if (error?.code === 'A5_GRAMMAR_VERSION') throw error; }
    throw new Refused('DIRTY', 'commit your changes first; the gate must check what you submit');
  }
  const stray = treeUntouched(root) ? [] : untracked(root);
  if (stray.length) throw new Refused('UNTRACKED', `commit or ignore ${stray.length} untracked file(s), e.g. ${stray[0]}`);
  let commit = headCommit(root);
  if (!commit) throw new Refused('NO_COMMIT', 'nothing committed yet');
  // A check naming a test file the commit lacks can only fail after a queued gate; with gate.refuseMissingCheckFile on, refuse now and say what the commit added (#3095).
  const absent = refuseMissingCheckFile() ? missingCheckFiles(frozenCheck(held), file => tryGit(root, ['cat-file', '-e', `${commit}:${file}`]).status === 0) : [];
  if (absent.length) {
    const added = (held.item_claim_head ? tryGit(root, ['diff', '--name-only', '--diff-filter=A', held.item_claim_head, commit]).stdout : '').split('\n').filter(Boolean);
    throw new Refused('CHECK_FILE_MISSING', `the frozen check names ${absent.join(', ')}, which commit ${commit.slice(0, 12)} does not contain; this commit added ${added.length ? added.join(', ') : 'no files'}; name the test as the check does, or ask the coordinator to correct the check`);
  }
  // With submit.composeOnRunner on, the queued gate job composes main and the head, so this command merges nothing and sends the head as it is [C7,#10756].
  const composeOnRunner = composesOnRunner(ctx);
  let mainMerge = null;
  if (!isSubmitHandoffWorker(ctx) && !composeOnRunner) {
    // A conflict in recorded tool output is not composed here: the regeneration below replays the tool on main [C7,V4,V6].
    // With submit.composeAsObject on, the composition is a throwaway object (parents main then head) under refs/pullboard/compose:
    // the builder branch never gets a sync merge, and a runner can recompute the same tree from main and head [C7,U159].
    const composeAsObject = submitComposeAsObject();
    try {
      mainMerge = authorizationStep('main-merge', () => (composeAsObject
        ? composeSubmissionMain(root, acceptedMain.commit, { item: id })
        : mergeSubmissionMain(root, acceptedMain.commit, { checkout: false })));
    }
    catch (error) { if (error?.code !== 'MERGE_CONFLICT' || !recordedToolCommits(root, acceptedMain.commit, headCommit(root))) throw error; }
    // The composed commit exists only as objects; the builder checkout and its HEAD are not moved [C7].
    if (mainMerge) commit = mainMerge.commit;
    if (mainMerge?.composed) {
      ctx.io.say(`Composed main ${acceptedMain.commit.slice(0, 12)} with head ${mainMerge.source.slice(0, 12)} as ${commit.slice(0, 12)} (${mainMerge.ref}); the builder branch is unchanged; checking the composed tree.`);
    } else if (mainMerge?.merged) {
      ctx.io.say(`Merged main ${acceptedMain.commit.slice(0, 12)} into the builder source as ${commit.slice(0, 12)}; checking the composed tree.`);
    }
  }
  // submit.proofOnly (#9105): an all-proof item with every clause ticked may submit an empty head.
  authorizationStep('non-empty', () => requireNonEmptySubmit(root, id, commit, acceptedMain.commit,
    {
      proofOnly: () => submitProofOnly() && withBoard(ctx, board => proofOnlyTicked(held, store.itemThread(board, id), commit)),
      proofShaped: () => withBoard(ctx, board => proofOnlyTicked(held, store.itemThread(board, id), commit)),
    }));
  // A test file the bar froze at claim keeps its content unless the person ruled; under the test-author split another seat wrote it [C7,V4].
  authorizationStep('test-hashes', () => withBoard(ctx, (board) => {
    const source = { atHead: committedReader(root, commit), atMain: committedReader(root, acceptedMain.commit), person: store.PERSON, seat: submitVerify?.testAuthorSplit === true ? whoAmI(ctx, board).id : null };
    const problem = frozenTestsProblem(submitVerify, held, store.itemThread(board, id), source)
      ?? authorSplitProblem(submitVerify, held, store.itemThread(board, id), source);
    if (problem) throw problem;
  }));
  let trunk;
  let regenerated = null;
  try { trunk = composeOnRunner ? { commit: acceptedMain.commit } : authorizationStep('trunk-merge', () => requireTrunkMerge(root, commit, isSubmitHandoffWorker(ctx) ? acceptedMain.commit : undefined)); }
  catch (error) {
    if (error?.code !== 'MERGE_CONFLICT') throw error;
    if (!isSubmitHandoffWorker(ctx)) {
      acceptedMain = mainPolicy(root);
      const queued = withBoard(ctx, board => pendingSubmitHandoff(board, held, { fromJobRow: pendingFromJobRow() }));
      if (queued && recordedToolCommits(root, acceptedMain.commit, commit)) throw new Refused('SUBMIT_HANDOFF_PENDING',
        'the original immutable source is already queued; read its result before submitting another source');
    }
    regenerated = regenerateToolChange(root, commit, acceptedMain.commit, { item: id });
    if (!regenerated) throw error;
    commit = regenerated.commit;
    trunk = requireTrunkMerge(root, commit, acceptedMain.commit);
    ctx.io.say(`Regenerated recorded board tools on main ${acceptedMain.commit.slice(0, 12)}; new head ${commit.slice(0, 12)} needs fresh full proof and review.`);
  }
  // With submit.regenerateDeclared on accepted main, a stale declared generated file is regenerated in the composed tree and committed (#8876) [C7].
  // With submit.composeOnRunner on there is no composed tree here: the runner composes, so this command sends the head as it is [C7,#10757].
  if (!isSubmitHandoffWorker(ctx) && !composeOnRunner && acceptedMain.config.submit?.regenerateDeclared === true && !regenerated) {
    let declared;
    try { declared = regenerateDeclaredFiles(root, acceptedMain.config, { base: held.item_claim_head, item: id }); }
    catch (error) { throw new Refused('GENERATED_STALE', `${error.message}; next: run the generator yourself, commit, and submit again`); }
    if (declared) {
      commit = declared.commit;
      trunk = requireTrunkMerge(root, commit, acceptedMain.commit);
      ctx.io.say(`Regenerated ${declared.files.join(', ')} from its declared generator; new head ${commit.slice(0, 12)}.`);
    }
  }
  const requireComposition = withBoard(ctx, board => barReadySetting(board).enabled);
  ctx = copySubmitHandoffOrigin(ctx, { ...ctx, config: policy.config });
  authorizationStep('proves-nothing', () => withBoard(ctx, (board) => refuseProvesNothing(() => acceptedMain.config, board, store.getItem(board, id))));
  authorizationStep('kernel-approval', () => withBoard(ctx, board => requireKernelApproval(board, { root, base: acceptedMain.commit, commit, item: id })));
  const dependencies = authorizationStep('dependencies', () => withBoard(ctx, board => dependencySnapshots(board.db, held)));
  let ownershipRefusal = null;
  /** The lane ownership check of authorization and source, on this machine: a lane refusal is routed after proof. */
  const localSubmissionPaths = () => {
    try {
      authorizationStep('submission-paths', () => submissionPaths(root, held, commit, { mainCommit: acceptedMain.commit, dependencies }));
    } catch (error) {
      if (error.code !== 'OUTSIDE_LANE' || !Array.isArray(error.paths)) throw error;
      ownershipRefusal = error;
    }
  };
  // With a runner, a queued submit's source check runs in its one runner analysis job; this machine records the result [C7,#5674].
  // Dependencies' snapshots, a head moved past the claimed commit and a companion's builder commit travel with the request;
  // a runner that lacks one of those commits reports the check skipped, and only then does this machine run it [C7,#5761].
  let remoteAuthorization = submitAuthorizationMode() === 'runner';
  /** The frozen bar is sent as its policy commit alone, the one thing the lane check reads of it, so the job request stays small. */
  const frozenPolicyOnly = () => {
    try { const commit = JSON.parse(held.item_frozen ?? 'null')?.policy?.commit; return commit ? JSON.stringify({ policy: { commit } }) : held.item_frozen; } catch { return held.item_frozen; }
  };
  const authorizationRequest = () => ({ item: { item_id: held.item_id, item_lane: held.item_lane, item_claim_head: held.item_claim_head, item_frozen: frozenPolicyOnly(), item_brief: held.item_brief, item_files: held.item_files },
    dependencies, commit });
  if (!remoteAuthorization) localSubmissionPaths();
  const { me, claimHead } = authorizationStep('freezer-digest', () => withBoard(ctx, (board) => {
    const who = whoAmI(ctx, board);
    const item = store.getItem(board, id);
    if (item.item_status !== 'claimed' || item.item_owner !== who.id) {
      throw new Refused('NOT_YOURS', `item #${id} is not claimed by you; claim it first`);
    }
    // A bar that moved since claim can get no verdict (V3), so say so now, not after a verifier's run (V11).
    // A cited row taken out of force (retired, wont) cannot be frozen at all, and says so too.
    if (item.item_frozen_digest) {
      let digest = null;
      let unusable = '';
      try {
        digest = freezer(ctx, { board })(item).digest;
      } catch (error) {
        if (!(error instanceof Refused) || ['A5_GRAMMAR_VERSION', 'MAIN_FACTS_BUSY'].includes(error.code)) throw error;
        unusable = error.message.replace(/^\[\w+\] /, '').split(';')[0];
      }
      if (digest !== item.item_frozen_digest) {
        const step = unusable
          ? `the coordinator either restores the row and runs pullboard refreeze ${id}, or withdraws #${id}`
          : `${who.id === COORDINATOR ? '' : 'the coordinator runs '}pullboard refreeze ${id}, then you claim it and submit again`;
        throw new Refused('CRITERIA_CHANGED', `the spec rows #${id} cites changed after it was claimed${unusable ? ` (${unusable})` : ''}, so no verifier could judge it; ${step}`);
      }
    }
    return { me: who, claimHead: item.item_claim_head };
  }));
  const preflightLines = authorizationStep('changed-lines', () => changedLines(root, acceptedMain.commit, commit));
  const preflightSize = preflightLines === null ? undefined : { base: acceptedMain.commit, head: commit, lines: preflightLines, method: SUBMISSION_SIZE_METHOD };
  authorizationStep('preflight-record', () => withBoard(ctx, (board) => submitPreflight(board, id, { agentId: me.id, commit, tree: commitTree(root, commit), submissionSize: preflightSize, inspectClauses,
    ...(inspectClauses ? { gateFiles: gateFilesOf(store.getItem(board, id)) } : {}) }, { atomic: store.atomic, submit: store.submit, prepareSubmit: store.prepareSubmit }, { refuse: (observed, item) => machineVerificationEligible(observed, item, filesSince(root, id, claimHead, commit)) ? null : refuseUnreviewable(observed, item, { policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family }, store) })));
  if (ctx.precheck) {
    // The cheap stage ends here: stacked-on-unverified is checked too, and nothing below (cells, static, gate, queue) starts [V4,C7].
    withBoard(ctx, board => refuseUnsubmittableStack(root, board, held, commit, trunk));
    // The lane read is cheap too; a full submit defers it until after the gate, so only the precheck raises it here.
    if (ownershipRefusal) throw ownershipRefusal;
    if (ctx.json) ctx.io.result({ precheck: true, item: id, commit });
    else ctx.io.say(`precheck passed for #${id} at ${commit.slice(0, 12)}: no cheap refusal; cells and the gate were not started`);
    return 0;
  }
  const companion = await authorizationStep('item-patches', () => withBoard(ctx, async board => {
    if (companionInput) {
      let patchStat;
      try { patchStat = fs.stat(companionInput.file); } catch { throw new Refused('ITEM_PATCH_FORMAT', `cannot read companion patch file "${companionInput.file}"`); }
      if (!patchStat.isFile() || patchStat.size > 8 * 1024 * 1024) throw new Refused('ITEM_PATCH_FORMAT', 'supply a regular companion patch of at most eight MiB');
      const patchBytes = fs.readFile(companionInput.file, null);
      const patchText = patchBytes.toString('utf8');
      if (!Buffer.from(patchText, 'utf8').equals(patchBytes)) throw new Refused('ITEM_PATCH_FORMAT', 'companion patch must contain valid UTF8');
      const patch = normalizeItemPatch(patchText);
      const author = store.listAgents(board).find(seat => seat.agent_id === companionInput.author);
      if (!author || author.agent_lane === held.item_lane) throw new Refused('ITEM_PATCH_AUTHOR', 'name a registered author in another owning lane');
      const patchPolicy = itemPolicy(root, held);
      validateItemPatchInput(board, patchPolicy.config, author.agent_id, patch, patchPolicy.commit);
      await ordered(ctx, board, 'attachItemPatch', [id, { agentId: me.id, key: companionInput.key, commit, patch,
        author: author.agent_id, presubmit: true, autoAttach: true }]);
    }
    if (store.itemPatches(board, id).some(patch => patch.commit !== commit || patch.source?.commit !== commit)) {
      await ordered(ctx, board, 'followItemPatches', [id, { agentId: me.id, commit }]);
    }
    return prepareItemPatchSubmit(root, board, held, commit);
  }));
  if (companion) withBoard(ctx, board => requireKernelApproval(board, { root, base: acceptedMain.commit, commit: companion.commit, item: id }));
  withBoard(ctx, board => requireSubmitHandoffExecution(ctx, board, companion?.commit ?? commit, companion?.tree ?? commitTree(root, commit)));
  const { itemPulledReds: pulledReds } = await import('../submit/pull.js');
  authorizationStep('red-progress', () => withBoard(ctx, board => requireRedSubmitProgress(root, board, id, held.item_frozen_digest, companion?.commit ?? commit, acceptedMain.commit, pulledReds)));
  if (mainMerge?.merged) await withBoard(ctx, board => ordered(ctx, board, 'appendFact', [id, { agentId: held.item_owner, kind: 'note',
    text: `Builder ${held.item_owner} ${mainMerge.composed ? `composed main ${acceptedMain.commit} with head ${mainMerge.source} as an object under ${mainMerge.ref}; ` : ''}automatic main merge: source ${mainMerge.source}, main ${acceptedMain.commit}, merge ${commit}.` }]));
  const barWarning = await authorizationStep('bar-warning', () => withBoard(ctx, async board => {
    const warning = barCheckWarning(board, held);
    if (!warning) return null;
    await ordered(ctx, board, 'appendFact', [id, { agentId: held.item_owner, kind: 'note', text: `bar.check warning: ${warning}` }]);
    return warning;
  }));
  if (barWarning) ctx.io.say(`bar.check warning: ${barWarning}`);
  // Which seat and model family wrote each named test file this submit adds or changes [C7,V4].
  await withBoard(ctx, async board => {
    const notes = testAuthorNotes(held, store.itemThread(board, id), { atHead: committedReader(root, commit), atMain: committedReader(root, acceptedMain.commit), seat: me.id, family: seatFamily(board, me.id) });
    for (const text of notes) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note', text }]);
  });
  // submit.clauseMarks (#9440): the submit records each bar clause with whether a tick covers it, for the reviewer.
  if (submitClauseMarks()) await withBoard(ctx, async board => {
    const text = clauseMarksNote(held, store.itemThread(board, id), commit);
    if (text) { await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note', text }]); ctx.io.say(text); }
  });
  reportSubmitStage(ctx, 'authorization and source', preflightStart);
  withBoard(ctx, (board) => refuseUnsubmittableStack(root, board, held, commit, trunk));
  withBoard(ctx, board => requireSlicePaths(board, held, changedSince(root, acceptedMain.commit, commit), acceptedMain.config.slices?.enforcePaths));
  machineNameProblems(root, `${acceptedMain.commit}..${commit}`, { refuse: acceptedMain.config.commits.noHostName === true, say: (line) => ctx.io.say(line) });
  // A home-folder path in any commit message is refused always, and a Co-Authored-By trailer when commits.noCoAuthor is on [C1,C7].
  await checkRangeMessages(root, `${acceptedMain.commit}..${commit}`, { noCoAuthor: acceptedMain.config.commits.noCoAuthor === true });
  const infraRecord = infraNotes.infraNote({ root, claimHead, commit, files: filesSince(root, id, claimHead, commit), gates: [ctx.config.gate, acceptedMain.config.gate], infra, requireInfraNote: acceptedMain.config.submit.requireInfraNote });
  const regeneratedFrom = toolRegenerationSource(root, commit);
  // Every gate is one runner job row this host writes, whatever gate.runnerDispatch says (the setting is a deprecated no-op here);
  // a companion submit's gate judges its composed source [P7].
  if (ownershipRefusal) throw ownershipRefusal;
  // The configured static check runs in the agent's checkout before any runner job is queued, so a red one takes no trip (#5730).
  const staticStart = Date.now();
  if (!companion) await requireStaticPreflight(root, acceptedMain.config.staticChecks, changedSince(root, acceptedMain.commit, commit), { timeoutMs: acceptedMain.config.check?.timeoutMs });
  submitMark('preflight/static', staticStart);
  // A reminder never stops a submit: a handled reference this change leaves unacknowledged in the changelog is named (point 20) [C7].
  for (const reminder of submitReferenceReminders(root, held, commit)) ctx.io.err(reminder);
  const queueStart = Date.now();
  const queued = await (await import('../submit/pull.js')).offerSubmitGate(ctx, { held, me, commit, trunk, main: acceptedMain, claimHead, files: filesSince(root, id, claimHead, commit), requireComposition, authorize: remoteAuthorization ? authorizationRequest() : null, full: Boolean(regenerated || regeneratedFrom), companion, infra: infraRecord, composed: mainMerge?.composed && mainMerge.commit === commit ? { main: acceptedMain.commit, head: mainMerge.source, tree: mainMerge.tree } : null }, { frozenCheck, policyAt, listItems: store.listItems, pairPrefix });
  submitMark('queueing', queueStart);
  return queued;
}

/** `submit --preflight`: run every registered static check in parallel on this branch's changed files and submit nothing [C7]. */
async function preflightHere(ctx) {
  const { root } = ctx.info;
  const changed = tryGit(root, ['diff', '--name-only', '-z', 'refs/heads/main...HEAD']);
  const files = changed.status === 0 ? changed.stdout.split('\0').filter(Boolean) : [];
  return reportPreflight(await runStaticPreflight(root, ctx.config.staticChecks, files, { timeoutMs: ctx.config.check?.timeoutMs }), line => ctx.io.say(line));
}

/** Run `pullboard submit` and return its exit code. */
/**
 * Tick the claimed item's test clauses after a green `pullboard test` run of files inside its check, as ordinary note facts.
 * Why: submit reads those notes, so a green runner proof no longer ends in CLAUSE_UNTICKED. For an item whose check names no test file
 * the run's own cases tick, read from the run's log with the queued run id, so no builder retypes a note [C7].
 * @param {any} io The command io.
 * @param {number} itemId The claimed item.
 * @param {string[]} files The files the run covered.
 * @param {{ run?: string, logPath?: string|null }} [ran] The queued run id (values test-run) and the green run's log path.
 */
export async function recordClauseTicks(io, itemId, files, { run, logPath = null } = {}) {
  const outcomes = logPath ? (await import('../test/status-outcomes.js')).statusOutcomes(logPath) ?? [] : [];
  await actOn(io, async (ctx, board, me) => {
    const found = store.getItem(board, itemId);
    if (found.item_owner !== me.id) return 0;
    for (const text of testRunTickNotes(found, files, headCommit(ctx.info.root), { outcomes, run: run ?? null })) await ordered(ctx, board, 'appendFact', [itemId, { agentId: me.id, kind: 'note', text }]);
    return 0;
  });
}

/**
 * Tick the claimed item's test clauses after a green `pullboard check` run of its frozen check, a test file or a shell command.
 * Why: a check such as `test ! -e src/x.js` names no file `pullboard test` could run, yet proves its clauses [C7].
 */
export async function recordCheckTicks(io, itemId) {
  await actOn(io, async (ctx, board, me) => {
    const found = store.getItem(board, itemId);
    if (found.item_owner !== me.id) return 0;
    for (const text of checkRunTickNotes(found, headCommit(ctx.info.root))) await ordered(ctx, board, 'appendFact', [itemId, { agentId: me.id, kind: 'note', text }]);
    return 0;
  });
}

/**
 * The registered runner this seat's item folders live on, named by PULLBOARD_ITEM_FOLDER_RUNNER, or null for local folders [C7].
 * @param {NodeJS.ProcessEnv} [env] The seat's environment.
 * @returns {{ host: string, builderRoot?: string, root?: string }|null} The runner record, or null.
 */
function hostedSubmitRunner(env = environmentAdapter().all()) {
  const host = env.PULLBOARD_ITEM_FOLDER_RUNNER?.trim();
  if (!host) return null;
  const runner = (loadMachineSettings().runners ?? []).find(row => row.host === host);
  if (!runner) throw new Refused('RUNNER_NOT_REGISTERED', `item folder runner ${host} is not registered; run pullboard runner list, or unset PULLBOARD_ITEM_FOLDER_RUNNER`);
  return runner;
}

/** Submit, then restore the pre-submit head if the board was busy after the automatic main merge [#6096]. */
async function submitRestoringHead(ctx, id, infra, companionInput = null) {
  const before = headCommit(ctx.info.root);
  try { return await submitHere(ctx, id, infra, companionInput); }
  catch (error) {
    if (error?.code === 'BOARD_BUSY') restoreMergedHead(ctx.info.root, before);
    throw error;
  }
}

/**
 * Hand a runner-hosted item to the coordinator: the runner pushes the item branch to the coordinator repository, then the
 * seat's coordinator-side item folder checks out the pushed commit, so the ordinary submit gates it and stays the one board writer [C7].
 * Every refusal here (a folder off the claimed branch, a failed push) comes before any board write.
 * Why: git refuses a push to a branch checked out in a worktree, so an existing local folder is detached for the push and reattached after.
 * @param {any} ctx The submit context at the seat's checkout.
 * @param {number} id The claimed item.
 * @param {{ host: string }} runner The seat's item folder runner.
 * @returns {Promise<string>} The coordinator-side item folder the ordinary submit runs in.
 */
async function handOffHostedSubmit(ctx, id, runner) {
  const { me, local } = await withBoardRead(ctx, board => {
    const who = whoAmI(ctx, board), item = store.getItem(board, id);
    if (item?.item_status !== 'claimed' || item.item_owner !== who.id) throw new Refused('NOT_YOURS', `item #${id} is not claimed by you; claim it first`);
    return { me: who, local: itemFolderPath(seatRoot(ctx, board, who), id) };
  });
  const branch = `${me.lane}/item-${id}`, root = ctx.info.root, existed = fs.exists(local);
  if (existed) {
    const current = checkoutBranch(local);
    if (current !== null && current !== branch) throw new Refused('HOSTED_BRANCH_MISMATCH', `item folder ${local} is on ${current}, not the claimed branch ${branch}; switch it back and submit again`);
    if (!isClean(local)) throw new Refused('DIRTY', `item folder ${local} has uncommitted changes; build on the runner, and leave the coordinator folder untouched`);
    git(local, ['checkout', '--quiet', '--detach']);
  }
  let pushed;
  try { pushed = await pushHostedItemBranch(runner, { itemId: id, branch }); }
  finally { if (existed) git(local, ['checkout', '--quiet', branch]); }
  if (pushed.problem) throw new Refused(pushed.problem.code, pushed.problem.message);
  const landed = tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).stdout;
  if (landed !== pushed.head) throw new Refused('HOSTED_PUSH_FAILED', `the coordinator branch ${branch} is at ${landed || 'nothing'}, not the runner's pushed ${pushed.head.slice(0, 12)}; submit again`);
  if (!existed) git(root, ['worktree', 'add', '--quiet', local, branch]);
  writeItemMarker(local, me.id, id);
  ctx.io.say(`runner ${runner.host} pushed ${branch} at ${pushed.head.slice(0, 12)}; submitting it from ${local}`);
  return local;
}

/**
 * The submit command: parse its arguments and flags, hand off to a hosted runner when one is set, and submit the item.
 *
 * @param {object} io
 * @param {object} args the first word and the parsed flags
 * @returns {Promise<number>}
 */
export async function run(io, { first, values }) {
  const submissionResult = {};
  let ctx = { ...context(io), submissionResult, precheck: values.precheck === true, dryRunReview: values['dry-run-review'] === true, json: values.json === true };
  const id = idArg(first);
  if (values.preflight) return preflightHere(ctx);
  const companionInput = values.companion === undefined ? null : { file: values.companion, key: values.key, author: values.author };
  if (companionInput && (!companionInput.file || !companionInput.key || !companionInput.author)) {
    throw new Refused('USAGE', 'use pullboard submit <id> --companion <patch-file> --key <key> --author <owning-seat>');
  }
  const hostRunner = hostedSubmitRunner();
  if (hostRunner) {
    io.cwd = await handOffHostedSubmit(ctx, id, hostRunner);
    ctx = { ...context(io), submissionResult, precheck: ctx.precheck, dryRunReview: ctx.dryRunReview, json: ctx.json };
  }
  /** Dispatch before optional verdict waiting, retaining this exact submission document; a pulled one marks the submit queued for --wait [P7]. */
  ctx.afterSubmission = submission => { if (submission?.queued) Object.assign(submissionResult, { queued: true, value: submission }); return completeMoveHandoff(ctx, id, values, submission, { nextOnce, withBoardRead, listItems: store.listItems, agentSessionDigest, topUp: target => topUpClaims(target, {}, { most: 1 }) }); };
  const previous = io.onOrderedMove;
  io.onOrderedMove = receipt => {
    previous?.(receipt);
    if (receipt.operation !== 'submit') return;
    const event = receipt.events.find(event => event.event_kind === 'submit' && event.item_id === id);
    if (event) submissionResult.event = { ...event };
  };
  let code;
  try { code = await submitRestoringHead(ctx, id, values.infra, companionInput); }
  catch (error) {
    if (error instanceof Refused && ctx.submitAttempt) {
      try {
        await withBoard(ctx, async board => {
          const item = store.getItem(board, id), attempt = ctx.submitAttempt;
          if (item.item_status !== 'claimed' || item.item_owner !== attempt.agentId || item.item_frozen_digest !== attempt.digest
            || !(item.item_lease_until > ctx.clock.now().toISOString())) return;
          if (error.code === 'RUNNER_TOOLING_CHANGED') {
            await ordered(ctx, board, 'appendFact', [id, { agentId: attempt.agentId, kind: 'note',
              text: `Submit infrastructure refusal [RUNNER_TOOLING_CHANGED]: ${error.message.slice(0, 4000)}. No failed submit is recorded.` }]);
            if (ctx.io.submitToolingAttempt) ctx.io.submitToolingAttempt.owned = true;
          } else {
            await ordered(ctx, board, 'claim', [id, { agentId: attempt.agentId, lane: item.item_lane, leaseMs: ctx.config.leaseMs,
              freeze: claimFreezer(ctx, board), head: headCommit(ctx.info.root),
              submitOutcome: { digest: attempt.digest, code: error.code, text: error.message.slice(0, 4000),
                ...(attempt.stage === 'fast' || error.submitFailureStage === 'fast' ? { stage: 'fast' } : {}) } }]);
          }
        });
      } catch (recordError) { ctx.io.err(`submit outcome not recorded: ${recordError.message}`); }
    }
    throw error;
  }
  finally { io.onOrderedMove = previous; }
  if (code !== 0 || !values.wait || !submissionResult.queued) return code;
  // A seat that held the claim it submitted never waits on its gate; the result comes back through next [P7].
  if (!ctx.info.isMain && ctx.submitAttempt) {
    io.say(`a seat holding a claim never blocks on its own gate; a red gate comes back through pullboard next, and pullboard show ${id} reads it any time`);
    return code;
  }
  return submissionResult.value?.gateJob ? code : waitForSubmitGate(ctx, id, submissionResult.value, submissionResult.job,
    { withBoardRead: waitBoardRead, submitHandoff, getItem: store.getItem, ownershipWait: store.ownershipWait, ownershipWaitForJob: store.ownershipWaitForJob });
}
import { SUBMISSION_SIZE_METHOD } from '../../../../../packages/state/light.js';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
const fs = fileSystemAdapter();
