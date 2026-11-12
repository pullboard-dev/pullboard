import { parseSpec } from '../../../../../packages/spec/light.js';
import { requireKernelApproval } from '../../../../../packages/verify/index.js';
import { toolingFor } from '../../../../../packages/pin/index.js';
import { machineryRefusal } from '../../../../../packages/gate/index.js';
import { tapTests } from '../../../../../packages/gate/index.js';
import { jobbedFlakeObserver } from '../../../../../packages/drive/index.js';
import { mainOwnedVerdictPorts } from '../../../../../packages/drive/index.js';
import { recordGateVerdict } from '../../../../../packages/gate/index.js';
import { finishAwaitingVerdicts } from '../../../../../packages/gate/index.js';
import { returnMainTest } from '../../../../../packages/gate/index.js';
import { mainReceipts } from '../../../../../packages/landing/index.js';
import { runMachineryGuard } from '../../../../../packages/gate/index.js';
import { countTrialGate } from '../../../../../packages/gate/index.js';
import { itemFolderIdentity } from '../item/folder.js';
import { itemFolderPath } from '../item/folder/identity.js';
import { seatRoot } from '../item/folder/identity.js';
import { writeItemMarker } from '../item/folder/identity.js';
import { pushHostedItemBranch } from '../../../../../packages/runners/index.js';
import { checkoutBranch } from '../../../../../packages/git/index.js';
import { itemCollisionPlan } from '../../../../../packages/items/index.js';
import { heartbeatCommand } from '../presence.js';
import { cachedSubmitSourceStep } from '../submit/cache.js';
import { remoteSubmitCells } from '../submit/remote.js';
import { mergeSubmissionMain } from '../../../../../packages/merge/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requireNonEmptySubmit } from '../empty.js';
import { fileURLToPath } from 'node:url';
import { clauseInspectionProblem } from '../../../../../packages/state/index.js';
import { staleHeadLines } from '../../../../../packages/state/index.js';
import { clauseInspectionSummary } from '../../../../../packages/state/index.js';
import { clauseTicks } from '../../../../../packages/state/index.js';
import { criterionClauses } from '../../../../../packages/state/index.js';
import { gateNamedFile } from '../../../../../packages/state/index.js';
import { checkRunTickNotes } from '../../../../../packages/state/index.js';
import { testRunTickNotes } from '../../../../../packages/state/index.js';
import { testTierReport } from '../../../../../packages/gate/index.js';
import { redGateReport } from '../../../../../packages/gate/index.js';
import { runGateStages } from '../../../../../packages/gate/index.js';
import { gateWaitReporter } from '../../../../../packages/gate/index.js';
import { recordedToolCommits } from '../../../../../packages/git/index.js';
import { toolRegenerationSource } from '../../../../../packages/git/index.js';
import { receiptLine as cellsReceiptLine } from '../../../../../packages/git/index.js';
import { regenerateToolChange } from '../../../../../packages/sandbox/index.js';
import { cachedDoctrineHold } from '../../../../../packages/doctrine/index.js';
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
import { blockingFailures } from '../../../../../packages/verify/index.js';
import { boundProofReceipt } from '../../../../../packages/store/index.js';
import { gateClauseTickNotes } from '../gate/ticks.js';
import { sealQuarantineVerdict } from '../../../../../packages/flakes/index.js';
import { gateRuns } from '../../../../../packages/flakes/index.js';
import { withImportParseCache } from '../../../../../packages/gate/index.js';
import { foreignNodeOptions } from '../../../../../packages/gate/index.js';
import { importsIn } from '../../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../../packages/gate/index.js';
import { requireSubmitCells } from '../cells-submit-checks.js';
import { machineVerificationEligible } from '../../../../../packages/verify/index.js';
import { checkNeedsBrowser } from '../../../../../packages/gate/index.js';
import { checkNeedsGui } from '../../../../../packages/gate/index.js';
import { landAfterAcceptance } from './land.js';
import { landedCutItemRows } from '../cells-submit-checks.js';
import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gateRunnerAdmission } from '../../../../../packages/config/index.js';
import { browserFreeChecksEnabled } from '../../../../../packages/config/index.js';
import { remoteGateWanted } from '../submit/gate.js';
import { remoteSubmitAnalysis } from '../submit/gate.js';
import { sharedRemoteAnalysis } from '../submit/gate.js';
import { acceptRunnerPlan } from '../submit/gate.js';
import { runSubmitGateWithRunnerPlan } from '../submit/gate.js';
import { gateWithRunnerPlan } from '../submit/gate.js';
import { doctrineRunnerChecks } from '../submit/gate.js';
export { doctrineExecutionPhases } from '../submit/gate.js';
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { mainComparisonMode } from '../../../../../packages/config/index.js';
import { submitAuthorizationMode } from '../../../../../packages/config/index.js';
import { effectiveRunners } from '../../../../../packages/runners/index.js';
import { frozenCheckTiming } from '../../../../../packages/items/index.js';
import {
  retainTestOutput,
  renderTestSummary,
  summaryProfile,
  withTestOutput,
} from '../../../../../packages/gate/index.js';
import { quarantineWaivers } from '../../../../../packages/flakes/index.js';
import { quarantineVerdictSnapshot } from '../../../../../packages/flakes/index.js';
import { withBoardRead as waitBoardRead } from '../context.js';
import { retrySync } from '../sync.js';
import { checkAtCommit } from '../../../../runner/index.js';
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../../packages/landing/index.js';
import { submitGateConfig } from '../../../../../packages/gate/index.js';
import { createHash } from 'node:crypto';
import { prepareItemPatchSubmit } from '../../../../../packages/items/index.js';
import { withItemPatchSubmit } from '../../../../../packages/items/index.js';
import { normalizeItemPatch } from '../../../../../packages/items/index.js';
import { validateItemPatchInput } from '../../../../../packages/items/index.js';
import { boundedProofReason } from '../../../../../packages/state/light.js';
import { completeMoveHandoff } from '../../../../../packages/verify/index.js';
import {
  barReadySetting,
  barReadyProblem,
} from '../../../../../packages/verify/index.js';
import { barCheckWarning } from '../../../../../packages/verify/index.js';
import { requireSubmitComposition } from '../../../../../packages/items/index.js';
import { composeAfterProof } from '../../../../../packages/items/index.js';
import { trunkMoveFact } from '../../../../../packages/items/index.js';
import { judgeTrunkMove } from '../../../../../packages/verify/index.js';
import { selectAffectedTests } from '../../../../../packages/gate/index.js';
import { explicitCheckFiles } from '../../../../../packages/gate/index.js';
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
  laneNames,
} from '../../../../../packages/seats/index.js';
import {
  hasSubmitRules,
  holdDoctrineAsync,
  submitRulesNarrowable,
  ruleLine,
} from '../../../../../packages/doctrine/index.js';
import { receiptLine as gateReceiptLine } from '../../../../../packages/gate/index.js';
import { recordNativeProof } from '../../../../../packages/verify/index.js';
import { proofRunReceipt } from '../../../../../packages/store/index.js';
import {
} from '../../../../../packages/gate/index.js';
import {
  deferredSelectionNote,
  runStaticChecks,
  runSubmitGate,
  startCriterionRun,
  withGateSlot,
} from '../../../../../packages/gate/index.js';
import {
  cleanGitEnvironment,
  contains,
  git,
  gitSpawnSync,
  headCommit,
  headTree,
  isClean,
  tryGit,
  untracked,
} from '../../../../../packages/git/index.js';
import {
  machineNameProblems,
} from '../../../../../packages/commits/index.js';
import * as infraNotes from '../../../../../packages/commits/index.js';
import {
  accountedFailures,
  waivedFailures,
  waiverLine,
} from '../../../../../packages/landing/index.js';
import {
  withMainCheckout,
  compareMainFailures,
  companionMainFailuresUntouched,
  mainRedMessage,
} from '../../../../../packages/landing/index.js';
import {
  observer as flakeObserver,
  verify as flakeVerify,
  recordMainComparison,
} from '../../../../../packages/flakes/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  relayRecovered,
} from '../../../../../packages/link/index.js';
import { refuseHeldElsewhere } from '../../../../../packages/seats/index.js';
import {
  submitPreflight,
  hasCellsPlan,
  requirePlannedSource,
} from '../../../../../packages/items/index.js';
import {
  refuseUnreviewable,
} from '../../../../../packages/verify/index.js';
import {
  changedLines,
  oversizeNote,
} from '../../../../../packages/items/index.js';
import {
  dependencySnapshots,
  frozenCheck,
  itemPolicy,
  mainPolicy,
  policyAt,
  requireTrunkMerge,
  submissionPaths,
} from '../../../../../packages/sandbox/index.js';
import {
  nextOnce,
  withBoardRead,
  CHECKOUT_LEASES,
  browserAdmissionReporter,
  context,
  filesSince,
  gateTestFiles,
  namedProofTests,
  freezer,
  idArg,
  ordered,
  queuedItemLease,
  refuseUnsubmittableStack,
  reportSubmission,
  refuseUnverifiedStack,
  resourceAgent,
  whoAmI,
  claimOrdered,
  claimFreezer,
  withBoard,
  actOn,
} from '../entry.js';
import { recordedRecovery } from '../../../../../packages/state/index.js';
import { failureSignatures } from '../../../../../packages/landing/index.js';
import { MAIN_FAILURE_SIGNATURE_VERSION } from '../../../../../packages/landing/index.js';
import { matchingMainFailures } from '../../../../../packages/landing/index.js';
import { criterionMainReceipts } from '../submit/receipt.js';
import { recordedMainComparison } from '../submit/recorded.js';
import { cachedMainComparison } from '../../../../../packages/landing/index.js';
import { proofMainFailures } from '../submit/reds.js';
import { regressesMain } from '../submit/reds.js';
import { redsAreMains } from '../submit/reds.js';
import { mainFailureNotices } from '../../../../../packages/landing/index.js';
import { linkKnownMainReworks } from '../../../../../packages/store/index.js';
import { unownedMainReds } from '../../../../../packages/store/index.js';
import { splitAmbiguousMainReds } from '../../../../../packages/store/index.js';
import { mainRedBaselinesToRetake } from '../../../../../packages/store/index.js';
import { mainRedItemCases } from '../../../../../packages/store/index.js';
import { itemCheckBaseline } from '../../../../../packages/store/index.js';
import { checkBaseline as retakeCheckBaseline } from '../../../../../packages/gate/index.js';
import { submitReferenceReminders } from '../../../../../packages/spec/index.js';
import { waitForSubmitGate } from '../submit/wait.js';
import { runPreflight } from '../submit/preflight.js';
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
  const finish = outcome => recordGateSpan({ phase: `authorization-${step}`, start, end: Date.now(), outcome });
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

/**
 * The named failing cases of one red run, the same rows the flake observer diagnoses: failed, top-level tests with a
 * file and a title. They key the run's flake-diagnose jobs.
 *
 * @param {{ output?: string, executionRoot?: string }} run
 * @param {string} root
 * @returns {{ file: string, case: string }[]}
 */
function failingCases(run, root) {
  return tapTests(run.output ?? '', run.executionRoot ?? root)
    .filter(row => !row.passed && row.type !== 'suite' && row.indent === 0 && row.file && row.name && !['subtestsFailed', 'cancelledByParent', 'testAborted'].includes(row.failureType))
    .map(row => ({ file: row.file, case: row.name }));
}

/** Hash the candidate's net code diff against the same admitted main used for every red head. */
function itemChangeHash(root, head, main) {
  const base = tryGit(root, ['merge-base', head, main]);
  if (base.status !== 0 || !base.stdout) throw new Refused('NO_POLICY', 'the item or admitted main history cannot be read; restore Git history before submitting again');
  const diff = gitSpawnSync(['--no-replace-objects', '-c', 'core.quotepath=false', 'diff', '--binary', '--no-ext-diff', base.stdout, head], {
    cwd: root, env: cleanGitEnvironment(), maxBuffer: 32 * 1024 * 1024,
  });
  if (diff.status !== 0) throw new Refused('NO_POLICY', 'the item net diff cannot be read; restore Git history before submitting again');
  return createHash('sha256').update(diff.stdout).digest('hex');
}

/** Project red handoffs only when their same-run native receipt proves this item's test failed. */
function redSubmitTestRuns(board, id, digest, root) {
  const rows = board.db.prepare("SELECT event_id,event_by,event_kind,event_detail FROM event WHERE item_id=? AND event_kind IN ('submit-handoff','proof-run') ORDER BY event_id").all(id);
  const red = [];
  let running = null;
  for (const row of rows) {
    let detail;
    try { detail = JSON.parse(row.event_detail); } catch { running = null; continue; }
    if (row.event_kind === 'submit-handoff') {
      if (detail.state === 'running') running = { actor: row.event_by, source: detail.commit, receipts: [] };
      else if (detail.state === 'red') {
        if (running?.actor === row.event_by && running.source === detail.commit) {
          const receipts = running.receipts.filter(receipt => receipt.kind === 'submit' && receipt.item === id
            && receipt.seat === row.event_by && receipt.frozenDigest === digest && receipt.sourceClean === true
            && Number.isSafeInteger(receipt.exitCode) && receipt.exitCode !== 0 && receipt.counts?.failed > 0
            && contains(root, detail.commit, receipt.commit));
          const commits = [...new Set(receipts.map(receipt => receipt.commit))];
          if (commits.length === 1) red.push({ eventId: row.event_id, commit: commits[0], failures: receipts.flatMap(receipt => receipt.failures ?? []) });
        }
        running = null;
      } else running = null;
    } else if (running && detail.receipt) {
      const receipt = detail.receipt;
      if (receipt.item === id && receipt.seat === row.event_by && receipt.frozenDigest === digest) running.receipts.push(receipt);
    }
  }
  return red;
}

/** Whether the local cache records main failing every case of a red gate, by file and case name. */
function knownMainReds(root, failures, main) {
  if (!failures?.length) return false;
  try { return redsAreMains(failures, cachedMainComparison(root, main, failures.map(row => row.file)), main); } catch { return false; }
}

/** Stop unchanged third red submissions while naming the two test failures that need repair. */
function requireRedSubmitProgress(root, board, id, digest, candidate, main) {
  // A gate whose every red is a case main fails by the same name is main's red, not the item's code, so it is no loop [C7].
  const red = redSubmitTestRuns(board, id, digest, root).filter(row => !knownMainReds(root, row.failures, main));
  if (red.length < 2) return;
  const latest = red.slice(-2);
  const latestFact = board.db.prepare("SELECT COALESCE(MAX(event_id),0) AS id FROM event WHERE item_id=? AND event_kind='fact'").get(id).id;
  if (latestFact > latest.at(-1).eventId) return;
  const candidateHash = itemChangeHash(root, candidate, main);
  const hashes = latest.map(row => itemChangeHash(root, row.commit, main));
  if (hashes.every(hash => hash !== candidateHash)) return;
  const named = latest.map(row => {
    const failure = row.failures.find(value => value.file || value.name);
    const name = failure ? `${failure.file ?? ''}${failure.file ? ':' : ''}${failure.name ?? ''}`.trim() : 'test failure';
    return `${name.slice(0, 120)} at ${row.commit.slice(0, 12)}`;
  }).join(' and ');
  throw new Refused('SUBMIT_RED_LOOP', `two red test gates still match this item code (${named}); change the failing code before another submit`,
    `fix the two red test failures: ${named}; then commit the code change and submit again`);
}

/**
 * Put the item folder back on its pre-submit head after a BOARD_BUSY refusal that followed the automatic main merge.
 * Why: the refusal records nothing, so a moved head only strands the clause evidence ticked at the old head [#6096].
 * Only a clean tree whose head is exactly that merge (first parent the old head) is reset; any other state is left alone.
 */
function restoreMergedHead(root, before) {
  if (!before) return;
  const now = headCommit(root);
  if (!now || now === before || !isClean(root)) return;
  const parents = tryGit(root, ['show', '-s', '--format=%P', now]);
  if (parents.status !== 0 || parents.stdout.trim().split(' ')[0] !== before || parents.stdout.trim().split(' ').length !== 2) return;
  tryGit(root, ['reset', '--hard', '-q', before]);
}

export async function submitHere(ctx, id, infra, companionInput = null) {
  const { root } = ctx.info;
  const inspectClauses = (submitHandoffPolicy(ctx) ?? mainPolicy(root)).config.verify.inspectClauses === true;
  const handoffEnabled = ctx.config.submit.handoff === true && !isSubmitHandoffWorker(ctx), pullGate = !isSubmitHandoffWorker(ctx) && (await import('../submit/pull.js')).pullGateWanted(id);
  const recovered = relayRecovered(root, {}, ctx.io);
  if (recovered?.operation === 'submit' && recovered.args[0] === id) {
    const preflight = withBoard(ctx, (board) => {
      const me = whoAmI(ctx, board);
      if (recovered.args[1]?.agentId !== me.id) return null;
      if (recordedRecovery(board, recovered)) return { me, recorded: true };
      const item = store.getItem(board, id);
      const trunk = requireTrunkMerge(root, recovered.args[1].commit);
      requirePlannedSource(root, trunk.commit, recovered.args[1].commit);
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
  const preflightStart = performance.now();
  const preflightWallStart = Date.now();
  const runnerAdmission = { ...gateRunnerAdmission(), ...(ctx.submitHandoffAdmissionCheck
    ? { beforeAdmission: ctx.submitHandoffAdmissionCheck } : {}) };
  const held = await authorizationStep('claim-check', () => withBoard(ctx, async (board) => {
    const me = whoAmI(ctx, board);
    const item = store.getItem(board, id);
    const folder = itemFolderIdentity(board, ctx.info.root);
    if (folder && folder.item !== id) throw new Refused('NOT_YOURS', `this folder belongs to item #${folder.item}; submit that item from here`);
    if (!isSubmitHandoffWorker(ctx) && !folder) refuseHeldElsewhere(ctx.info, store.listAgents(board), item, 'submit', agentSessionDigest);
    if (item.item_status !== 'claimed' || item.item_owner !== me.id) throw new Refused('NOT_YOURS', 'claim this item before submitting it');
    if (!isSubmitHandoffWorker(ctx)) heartbeatCommand(ctx.io, { ctx, board });
    const readiness = barReadyProblem(board, item);
    if (readiness) throw readiness;
    const clauseProblem = inspectClauses ? authorizationStep('clause-inspection', () => clauseInspectionProblem(item, store.itemThread(board, id), { gateFiles: gateTestFiles(root, item), head: headCommit(root) })) : null;
    if (clauseProblem) throw clauseProblem;
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
  const dirty = authorizationStep('tree-state', () => !isClean(root));
  if (dirty) {
    // Preserve the typed grammar refusal without starting gates for a dirty candidate.
    try { parseSpec(readFileSync(join(root, ctx.config.spec || 'SPEC.md'), 'utf8')); }
    catch (error) { if (error?.code === 'A5_GRAMMAR_VERSION') throw error; }
    throw new Refused('DIRTY', 'commit your changes first; the gate must check what you submit');
  }
  const stray = untracked(root);
  if (stray.length) throw new Refused('UNTRACKED', `commit or ignore ${stray.length} untracked file(s), e.g. ${stray[0]}`);
  let commit = headCommit(root);
  if (!commit) throw new Refused('NO_COMMIT', 'nothing committed yet');
  // A live handoff owns its captured source; never rewrite it underneath its queued worker.
  const pendingHandoff = !isSubmitHandoffWorker(ctx) ? await authorizationStep('handoff-recover', async () => (await (await import('../submit/handoff.js')).recoverItemSubmitHandoff(ctx, id, held.item_owner), withBoard(ctx, board => pendingSubmitHandoff(board, held)))) : null;
  const pending = pendingHandoff && pendingHandoff.commit !== commit ? await (await import('../submit/handoff.js')).replaceSubmitHandoff(ctx, id, held.item_owner, pendingHandoff) : pendingHandoff;
  let mainMerge = null;
  if (!isSubmitHandoffWorker(ctx) && !pending) {
    // A conflict in recorded tool output is not composed here: the regeneration below replays the tool on main [C7,V4,V6].
    try { mainMerge = authorizationStep('main-merge', () => mergeSubmissionMain(root, acceptedMain.commit)); }
    catch (error) { if (error?.code !== 'MERGE_CONFLICT' || !recordedToolCommits(root, acceptedMain.commit, headCommit(root))) throw error; }
    if (mainMerge) commit = mainMerge.commit;
    if (mainMerge?.merged) {
      ctx.io.say(`Merged main ${acceptedMain.commit.slice(0, 12)} into the builder source as ${commit.slice(0, 12)}; checking the composed tree.`);
    }
  }
  authorizationStep('non-empty', () => requireNonEmptySubmit(root, id, commit, acceptedMain.commit));
  let trunk;
  let regenerated = null;
  try { trunk = authorizationStep('trunk-merge', () => requireTrunkMerge(root, commit, isSubmitHandoffWorker(ctx) ? acceptedMain.commit : undefined)); }
  catch (error) {
    if (error?.code !== 'MERGE_CONFLICT') throw error;
    if (!isSubmitHandoffWorker(ctx)) {
      acceptedMain = mainPolicy(root);
      const queued = withBoard(ctx, board => pendingSubmitHandoff(board, held));
      if (queued && recordedToolCommits(root, acceptedMain.commit, commit)) throw new Refused('SUBMIT_HANDOFF_PENDING',
        'the original immutable source is already queued; read its result before submitting another source');
    }
    regenerated = regenerateToolChange(root, commit, acceptedMain.commit, { item: id });
    if (!regenerated) throw error;
    commit = regenerated.commit;
    trunk = requireTrunkMerge(root, commit, acceptedMain.commit);
    ctx.io.say(`Regenerated recorded board tools on main ${acceptedMain.commit.slice(0, 12)}; new head ${commit.slice(0, 12)} needs fresh full proof and review.`);
  }
  const requireComposition = withBoard(ctx, board => barReadySetting(board).enabled);
  const remoteMode = isSubmitHandoffWorker(ctx) && remoteGateWanted(runnerAdmission);
  ctx = copySubmitHandoffOrigin(ctx, { ...ctx, config: policy.config });
  authorizationStep('proves-nothing', () => withBoard(ctx, (board) => refuseProvesNothing(() => acceptedMain.config, board, store.getItem(board, id))));
  authorizationStep('kernel-approval', () => withBoard(ctx, board => requireKernelApproval(board, { root, base: acceptedMain.commit, commit, item: id })));
  const dependencies = authorizationStep('dependencies', () => withBoard(ctx, board => dependencySnapshots(board.db, held)));
  let mechanicalPaths = [];
  let ownershipRefusal = null;
  /** The lane ownership check of authorization and source, on this machine: a lane refusal is routed after proof. */
  const localSubmissionPaths = () => {
    try {
      authorizationStep('submission-paths', () => submissionPaths(root, held, headCommit(root), { mainCommit: acceptedMain.commit, dependencies,
        onMechanicalPaths: paths => { mechanicalPaths = paths; } }));
    } catch (error) {
      if (error.code !== 'OUTSIDE_LANE' || !Array.isArray(error.paths)) throw error;
      ownershipRefusal = error;
    }
  };
  // With a runner, a queued submit's source check runs in its one runner analysis job; this machine records the result [C7,#5674].
  // Dependencies' snapshots, a head moved past the claimed commit and a companion's builder commit travel with the request;
  // a runner that lacks one of those commits reports the check skipped, and only then does this machine run it [C7,#5761].
  let remoteAuthorization = (remoteMode || pullGate) && submitAuthorizationMode() === 'runner';
  /** The frozen bar is sent as its policy commit alone, the one thing the lane check reads of it, so the job request stays small. */
  const frozenPolicyOnly = () => {
    try { const commit = JSON.parse(held.item_frozen ?? 'null')?.policy?.commit; return commit ? JSON.stringify({ policy: { commit } }) : held.item_frozen; } catch { return held.item_frozen; }
  };
  const authorizationRequest = () => ({ item: { item_id: held.item_id, item_lane: held.item_lane, item_claim_head: held.item_claim_head, item_frozen: frozenPolicyOnly() },
    dependencies, commit: headCommit(root) });
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
  // A trunk checkout can have advanced since the claim; comparing it with itself would bless its own new red test.
  // gate.mainComparison off: no base, so no main comparison and no carried-red acceptance; a red gate is red [C7,#5565].
  const mainFailureBase = mainComparisonMode() === 'off' ? null
    : acceptedMain.commit === commit ? claimHead : git(root, ['merge-base', commit, acceptedMain.commit]);
  const preflightLines = authorizationStep('changed-lines', () => changedLines(root, acceptedMain.commit, commit));
  const preflightSize = preflightLines === null ? undefined : { base: acceptedMain.commit, head: commit, lines: preflightLines, method: SUBMISSION_SIZE_METHOD };
  authorizationStep('preflight-record', () => withBoard(ctx, (board) => submitPreflight(board, id, { agentId: me.id, commit, tree: headTree(root) ?? '', submissionSize: preflightSize, inspectClauses,
    ...(inspectClauses ? { gateFiles: gateTestFiles(root, store.getItem(board, id)) } : {}) }, { atomic: store.atomic, submit: store.submit, prepareSubmit: store.prepareSubmit }, { refuse: (observed, item) => machineVerificationEligible(observed, item, filesSince(root, id, claimHead, commit)) ? null : refuseUnreviewable(observed, item, { policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family }, store) })));
  if (ctx.precheck) {
    // The cheap stage ends here: stacked-on-unverified is checked too, and nothing below (cells, static, gate, queue) starts [V4,C7].
    withBoard(ctx, board => refuseUnsubmittableStack(root, board, held, commit, trunk));
    // Placement and lane are cheap reads too; a full submit defers both until after the gate, so only the precheck raises them here.
    requirePlannedSource(root, trunk.commit, commit, { deferUnplaced: true });
    if (ownershipRefusal) throw ownershipRefusal;
    if (ctx.json) ctx.io.result({ precheck: true, item: id, commit });
    else ctx.io.say(`precheck passed for #${id} at ${commit.slice(0, 12)}: no cheap refusal; cells and the gate were not started`);
    return 0;
  }
  const companion = await authorizationStep('item-patches', () => withBoard(ctx, async board => {
    if (companionInput) {
      let patchStat;
      try { patchStat = statSync(companionInput.file); } catch { throw new Refused('ITEM_PATCH_FORMAT', `cannot read companion patch file "${companionInput.file}"`); }
      if (!patchStat.isFile() || patchStat.size > 8 * 1024 * 1024) throw new Refused('ITEM_PATCH_FORMAT', 'supply a regular companion patch of at most eight MiB');
      const patchBytes = readFileSync(companionInput.file);
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
  withBoard(ctx, board => requireSubmitHandoffExecution(ctx, board, companion?.commit ?? commit, companion?.tree ?? headTree(root)));
  if (!pending) authorizationStep('red-progress', () => withBoard(ctx, board => requireRedSubmitProgress(root, board, id, held.item_frozen_digest, companion?.commit ?? commit, acceptedMain.commit)));
  if (mainMerge?.merged) await withBoard(ctx, board => ordered(ctx, board, 'appendFact', [id, { agentId: held.item_owner, kind: 'note',
    text: `Builder ${held.item_owner} automatic main merge: source ${mainMerge.source}, main ${acceptedMain.commit}, merge ${commit}.` }]));
  const barWarning = await authorizationStep('bar-warning', () => withBoard(ctx, async board => {
    const warning = barCheckWarning(board, held);
    if (!warning) return null;
    await ordered(ctx, board, 'appendFact', [id, { agentId: held.item_owner, kind: 'note', text: `bar.check warning: ${warning}` }]);
    return warning;
  }));
  if (barWarning) ctx.io.say(`bar.check warning: ${barWarning}`);
  reportSubmitStage(ctx, 'authorization and source', preflightStart);
  // The candidate must contain the main this proof pins; a main that moves on before or during the proof is judged after it.
  const compositionStart = performance.now();
  try { if (requireComposition && !remoteMode && !pullGate) await runMachineryGuard(root,
    () => requireSubmitComposition(root, commit, { commit: acceptedMain.commit }, acceptedMain.commit),
    { kind: 'composition', rule: requireSubmitComposition.toString(), say: line => ctx.io.say(line) }); }
  finally { reportSubmitStage(ctx, 'composition', compositionStart); }
  withBoard(ctx, (board) => refuseUnsubmittableStack(root, board, held, commit, trunk));
  machineNameProblems(root, `${acceptedMain.commit}..${commit}`, { refuse: acceptedMain.config.commits.noHostName === true, say: (line) => ctx.io.say(line) });
  const infraRecord = infraNotes.infraNote({ root, claimHead, commit, files: filesSince(root, id, claimHead, commit), gates: [ctx.config.gate, acceptedMain.config.gate], infra, requireInfraNote: acceptedMain.config.submit.requireInfraNote });
  const regeneratedFrom = toolRegenerationSource(root, commit);
  // Queue all captured sources before cell compilation; under gate.runnerDispatch pull the whole gate is one runner job row this host writes [P7].
  if (pullGate && !pending && !companion && ownershipRefusal) throw ownershipRefusal; else if (pullGate && !pending && !companion) return (await import('../submit/pull.js')).offerSubmitGate(ctx, { held, me, commit, trunk, main: acceptedMain, claimHead, files: filesSince(root, id, claimHead, commit), requireComposition, authorize: remoteAuthorization ? authorizationRequest() : null, full: Boolean(regenerated || regeneratedFrom) }, { frozenCheck, policyAt, listItems: store.listItems });
  if (pending || handoffEnabled) return (await import('../submit/handoff.js')).enqueueSubmitHandoff(ctx, held, me, { commit, tree: headTree(root), companion, infra, main: acceptedMain.commit });
  // Every submit proves its frozen check and reachable tests anew on this exact commit (V4,V16).
  // Empty frozen gates adopt accepted main setup; only a full fallback may stamp its tree.
  const configuredSubmit = submitGateConfig(companion || regenerated || regeneratedFrom ? policyAt(root, companion?.commit ?? commit).config : ctx.config, acceptedMain.config);
  const submitConfig = regenerated || regeneratedFrom ? { ...configuredSubmit, affectedTests: '', submitGate: 'full' } : configuredSubmit;
  const admission = { commit: companion?.commit ?? commit, tree: companion?.tree ?? headTree(root) };
  const quarantines = withBoard(ctx, quarantineVerdictSnapshot);
  const submissionWait = queuedItemLease(ctx, held, me.id, 'build', admission);
  const submissionStarted = async () => {
    // A queued admission already has its native witness; a free slot records it at the real gate start.
    if (!admission.id) await submissionWait({ admitted: true });
  };
  const gateAdmission = remoteMode ? { ...runnerAdmission, remote: true, runnerOnly: true } : runnerAdmission, executionServices = { runners: runnerExecutionServices(), landing: landingExecutionServices() };
  const readCutItems = () => withBoard(ctx, board => landedCutItemRows(board.db));
  // A queued submit's doctrine hold runs in the runner's analysis job; only its rule lookup and receipt stay here [C7].
  const runnerDoctrine = remoteMode && hasSubmitRules(root, acceptedMain.commit, acceptedMain.config.practice) ? { mainCommit: acceptedMain.commit, commit: companion?.commit ?? commit, practice: acceptedMain.config.practice,
    timeoutMs: acceptedMain.config.check?.timeoutMs, ...(submitRulesNarrowable(root, acceptedMain.commit, acceptedMain.config.practice) ? { fast: true } : {}) } : null;
  // The four trusted analysis parts run as one runner job on one lease and one main-pinned private check (#3379).
  const runRemotePart = sharedRemoteAnalysis(signal => runMachineryGuard(root, () => withItemPatchSubmit(root, companion, gateRoot => withGateSlot(gateRoot,
    lease => remoteSubmitAnalysis(gateRoot, { main: acceptedMain.commit, source: companion?.commit ?? commit,
      trunk: trunk.commit, base: claimHead, check: frozenCheck(held), criterion: JSON.parse(held.item_frozen ?? 'null')?.criterion ?? '',
      title: held.item_title ?? '', composition: requireComposition ? commit : null, staticChecks: submitConfig.staticChecks, crossRunTests: crossRun.tests,
      config: submitConfig, browserFreeChecks: browserFreeChecksEnabled(), readCutItems, perPart: true, doctrine: runnerDoctrine, collectMachinery: true, ...submitTooling(root, commit),
      ...(remoteAuthorization ? { authorization: authorizationRequest() } : {}) }, lease, ctx.submitHandoffOutput),
    { executionServices, itemCheck: true, agent: me.id, item: String(id), kind: 'analysis', ...gateAdmission,
      onWait: queuedItemLease(ctx, held, me.id, 'build'), signal })),
    { kind: 'composition', rule: requireSubmitComposition.toString(), say: line => ctx.io.say(line) }));
  const crossRun = await withBoardRead(ctx, board => {
    board.gitRoot = ctx.info.root;
    return itemCollisionPlan(board, held, store.listItems(board, { all: true }));
  });
  for (const warning of crossRun.warnings) ctx.io.say(warning);
  // Each cited row's gate test and each test file the bar names run with the proof, whatever seal and tier selection say [V4,C7].
  crossRun.tests = namedProofTests(root, held, commit, { crossRunTests: crossRun.tests });
  const runGate = (check, runnerPlan = {}, signal, earlyCriterion) => withItemPatchSubmit(root, companion, gateRoot => runSubmitGateWithRunnerPlan(runSubmitGate, gateRoot, submitConfig, runnerPlan, { executionServices, staticChecked: true, crossRunTests: crossRun.tests, outputRoot: root, outputLog: ctx.submitHandoffOutput ? join(ctx.submitHandoffOutput, 'gate.log') : undefined, runnerAdmission: gateAdmission, signatureCapture: acceptedMain.config.submit?.autoFileMainReds === true ? { version: MAIN_FAILURE_SIGNATURE_VERSION, derive: (run, root) => failureSignatures(run, root, { raw: true }) } : undefined, base: claimHead, trunk: acceptedMain.commit, check, timing: frozenCheckTiming(held), agent: me.id, item: String(id), onWait: submissionWait, onStart: submissionStarted, onBrowserFallback: browserAdmissionReporter(ctx.io, ctx.io.relayJson), signal, ...(earlyCriterion ? { earlyCriterion } : {}),
    countTrials: false, onMachineryNote: line => ctx.io.say(line),
    proofContext: { ...(companion ? { companion: true } : {}), item: id, frozenDigest: held.item_frozen_digest ?? null, seat: me.id, admission, quarantines },
    // Flake diagnostics are flake-diagnose jobs keyed by (tree, file, case); the gate runs them after its result [C7].
    onFailure: jobbedFlakeObserver(flakeObserver(ctx, { kind: 'submit', main: acceptedMain.commit, commit: companion?.commit ?? commit, privateCheck: Boolean(companion), config: submitConfig }, { ordered, withBoard, resourceAgent, checkAtCommit }),
      { withDb: work => withBoard(ctx, board => work(board.db)), gate: { id: `submit:${id}:${companion?.commit ?? commit}`, item: Number(id), candidate: companion?.commit ?? commit }, repo: root, owner: me.id, cases: failingCases }) }));
  /** Record the runner's authorization result as the local check would have left it; a skipped check runs here. */
  const recordRemoteAuthorization = analysis => {
    const found = analysis.authorization;
    recordGateSpan({ phase: 'authorization-runner', host: analysis.runner ?? null, start: Date.now() - (analysis.steps?.authorization ?? 0), end: Date.now(), outcome: found?.skipped ? 'skipped' : 'done' });
    if (!found || found.skipped) { ctx.io.say(`submit authorization: the runner could not check lane ownership (${found?.skipped ?? 'no result'}); checking it here`); localSubmissionPaths(); return; }
    mechanicalPaths = found.mechanical ?? [];
    if (found.ownership) ownershipRefusal = Object.assign(new Refused('OUTSIDE_LANE', found.ownership.message), { paths: found.ownership.paths, policy: found.ownership.policy });
  };
  /**
   * Stage one: settled when preflight is clean. Every stage that queues a runner waits on it, so a static failure queues none [C7].
   * Why: the stages start together, and a runner queued before a static red is wasted work the refusal cannot take back.
   */
  let settlePreflight;
  const preflightPassed = new Promise((resolve, reject) => { settlePreflight = { resolve, reject }; });
  preflightPassed.catch(() => {});
  /** The runner selection stage's analysis, settled once for the test stage that needs its plan. */
  let settleSelection;
  const selectionResult = remoteMode ? new Promise((resolve, reject) => { settleSelection = { resolve, reject }; }) : null;
  selectionResult?.catch(() => {});
  /** Judge the test result, including exact-main comparison, while other independent stages run. */
  const judgeTests = async (signal) => {
  await preflightPassed;
  // In a handoff worker the runner already planned the selection and browser admission; the Mac never plans it again (#3006).
  let gate = await gateWithRunnerPlan(remoteMode, selectionResult, { main: acceptedMain.commit, source: companion?.commit ?? commit, crossRunTests: crossRun.tests, check: frozenCheck(held) },
    (runnerPlan, early) => runGate(frozenCheck(held), runnerPlan, signal, early),
    // The frozen check needs no test selection: it starts at once on its own lease. A companion source runs in a temporary checkout, so it keeps the in-gate start.
    () => companion || !frozenCheck(held) ? null : startCriterionRun(root, { check: frozenCheck(held), executionServices, outputRoot: root,
      outputLog: ctx.submitHandoffOutput ? join(ctx.submitHandoffOutput, 'gate.log') : undefined, runnerAdmission: gateAdmission, trunk: acceptedMain.commit,
      proofContext: { item: id, frozenDigest: held.item_frozen_digest ?? null, seat: me.id, admission, quarantines },
      signatureCapture: acceptedMain.config.submit?.autoFileMainReds === true ? { version: MAIN_FAILURE_SIGNATURE_VERSION, derive: (run, root) => failureSignatures(run, root, { raw: true }) } : undefined,
      onFailure: flakeObserver(ctx, { kind: 'submit', main: acceptedMain.commit, commit, privateCheck: false, config: submitConfig }, { ordered, withBoard, resourceAgent, checkAtCommit }),
      timing: frozenCheckTiming(held), agent: me.id, item: String(id), signal }));
  if (signal.aborted) throw signal.reason;
  // From here the test result is judged: receipts recorded, known main reds matched. Its span closes the tests to result gap [C7].
  const judgeStart = Date.now();
  const submissionReceiptIds = [...(gate.proofReceiptIds ?? [])];
  for (const proofReceiptId of gate.proofReceiptIds ?? []) {
    await recordNativeProof(ctx, held, { proofReceiptId }, { ordered, withBoard, resourceAgent, proofRunReceipt, exitFailures: true });
  }
  recordGateSpan({ phase: 'proof-record', start: judgeStart, outcome: 'done' });
  if (companion) {
    companion.receiptIds = gate.proofReceiptIds.filter(id => typeof id === 'string');
    companion.phases = gate.phasePlan.map(({ role, command }) => ({ role, command: createHash('sha256').update(command).digest('hex') }));
  }
  const onMeasuredReceipt = receiptId => recordMainComparison(ctx, receiptId, { ordered, withBoard, resourceAgent });
  let comparison;
  const mainComparisonReceiptIds = new Map();
  /** Retain exact native comparison ids for the later origin-sealed submit. */
  const rememberComparison = result => { for (const row of result?.files ?? []) if (row.receiptId) mainComparisonReceiptIds.set(row.file, row.receiptId); };
  let criterionNotices = [];
  let proofNotices = [];
  // A red frozen check is judged like a red proof: a case failing identically on the base is a known main red, and any other case refuses (#1917).
  const criterionRed = gate.criterionRed && gate.check?.checked && !gate.check.green ? gate.criterionRed : null;
  let criterionKnown = null;
  let criterionMatched = null;
  let criterionUnowned = [];
  // Main's receipt per failing check file, as the gate result names them [C7,#3424].
  let criterionReceipts = [];
  // The gate's main-owned verdict over the red check's cases: green lists them as main-owned [C7,#3534].
  let criterionVerdict = null;
  // Known main reds with several candidate owners and none naming the case alone; the refusal lists them (#2016).
  const ambiguous = [];
  /** The check and the proof can both see one case; it is reported once. */
  const noteAmbiguous = rowsFound => { for (const row of rowsFound) if (!ambiguous.some(seen => seen.file === row.file && seen.name === row.name)) ambiguous.push(row); };
  let criterionProblem = '';
  const companionAllowsMain = failures => !companion || companionMainFailuresUntouched(root,
    { base: mainFailureBase, source: commit, composed: companion.commit }, failures);
  const criterionCases = criterionRed && mainFailureBase && !companion ? failureSignatures(criterionRed, root) : null;
  if (criterionCases) {
    try {
      // The gate records its verdict over the red cases from main's fresh receipts at the base: main's own reds record
      // green, and a missing receipt runs its main-test job and finishes the verdict when it returns, never a bounce [C7,#3534].
      const verdictStart = Date.now();
      try { criterionVerdict = await mainOwnedGate(ctx, { root, item: id, candidate: commit, base: mainFailureBase, claimBase: claimHead, cases: criterionCases, output: gate.output, runnerAdmission, onMeasuredReceipt }); }
      catch { criterionVerdict = null; /* A verdict that cannot be recorded leaves the judgement to main's keyed receipts below. */ }
      recordGateSpan({ phase: 'main-verdict', start: verdictStart, outcome: 'done' });
      if (criterionVerdict?.verdict === 'red') throw new Error(`the frozen check is red in the candidate's own case(s): ${criterionVerdict.own.map(row => `${row.file} (${row.name})`).join('; ')}`);
      // Main-red status is main's keyed receipt; a missing one queues a main-test job and refuses, never refreshes [C7,#3424].
      const lookup = withBoard(ctx, board => criterionMainReceipts({ root, db: board.db, main: mainFailureBase, cases: criterionCases }));
      if (!lookup.comparison) throw new Error(lookup.reason);
      comparison = lookup.comparison;
      criterionReceipts = lookup.classes.map(({ file, owner, receipt }) => ({ file, owner, receipt }));
      rememberComparison(comparison);
      criterionNotices = mainFailureNotices(root, criterionCases, comparison,
        { items: withBoard(ctx, board => store.listItems(board, { all: true })), exclude: id });
      const matched = matchingMainFailures(criterionCases, comparison, mainFailureBase);
      const rows = () => withBoard(ctx, board => store.listItems(board, { all: true }));
      // Cases with a unique open Main red repair link to it; the rest are recorded as unowned for the coordinator, never filed here.
      const split = matched ? splitAmbiguousMainReds(matched, rows(), id) : null;
      if (split) noteAmbiguous(split.ambiguous);
      const missing = split ? unownedMainReds(split.clear, rows(), id) : null;
      if (missing) {
        criterionMatched = matched;
        criterionUnowned = missing;
        const owned = split.clear.failures.filter(row => !missing.some(red => red.file === row.file));
        criterionKnown = owned.length ? linkKnownMainReworks({ main: matched.main, failures: owned }, rows(), id) : null;
      }
    } catch (error) { criterionProblem = `\nknown-main acceptance of the frozen check failed: ${error?.message ?? error}`; /* Unavailable exact-main proof never authorizes a red frozen check. */ }
  }
  // A case an open Main red repair's own check fails on this main never fails another item's check (#2594).
  let criterionMainRed = [];
  const retakenBaselines = new Map();
  const mainRedItems = () => withBoard(ctx, board => store.listItems(board, { all: true })
    .map(item => { const baseline = itemCheckBaseline(board, item); return baseline ? { ...item, item_check_baseline: baseline } : item; }));
  if (criterionCases && !criterionMatched) {
    try {
      const items = mainRedItems();
      const mainRed = mainRedCheckCases(root, criterionCases, items, id, mainFailureBase, retakenBaselines);
      if (mainRed.owned.length && !mainRed.rest.length) {
        const linked = linkKnownMainReworks({ main: mainFailureBase, failures: mainRed.owned }, items, id);
        if (linked) {
          criterionMatched = { main: mainFailureBase, failures: criterionCases };
          criterionMainRed = mainRed.owned;
          criterionKnown = linked;
          criterionProblem = '';
        }
      }
    } catch { /* An unavailable baseline never authorizes a red frozen check. */ }
  }
  if (criterionMatched && gate.completedProof) {
    gate = { ...gate, ...gate.completedProof, log: gate.log, check: gate.check, criterionRed: gate.criterionRed };
  } else if (criterionMatched) {
    // The known red stands in for the criterion; the selected proof still runs on this commit, without re-running the check.
    const proof = await runGate(undefined);
    for (const proofReceiptId of proof.proofReceiptIds ?? []) {
      await recordNativeProof(ctx, held, { proofReceiptId }, { ordered, withBoard, resourceAgent, proofRunReceipt, exitFailures: true });
    }
    submissionReceiptIds.push(...(proof.proofReceiptIds ?? []));
    gate = { ...proof, check: gate.check, criterionRed: gate.criterionRed };
  }
  const summary = retainTestOutput(root, readFileSync(gate.log, 'utf8'), { root, profile: gate.profile, ...(ctx.submitHandoffOutput ? { directory: ctx.submitHandoffOutput } : {}) });
  const selected = gate.files.slice(0, 8).join(', ') || 'none';
  const files = `${selected}${gate.files.length > 8 ? `, … ${gate.files.length - 8} more in the full log` : ''}`;
  const invariants = gate.submitInvariants?.length
    ? `submit invariants: ${gate.submitInvariants.slice(0, 8).join(', ')}; ` : '';
  const scope = gate.testTiers ? testTierReport(gate.testTiers) : gate.deferred
    ? gate.deferredFiles ? `${invariants}${deferredSelectionNote(gate.deferredFiles)}`
      : `${gate.deferFullFallback ? invariants : `affected tests: ${files}; `}full suite deferred to the landing gate`
    : gate.full ? `full gate: ${gate.reason}` : `affected tests: ${files}`;
  const check = gate.check.checked ? `item check ${gate.check.green ? 'green' : 'red'}` : 'no item check';
  const registry = gate.registryGuards?.length
    ? `; registry guards: ${gate.registryGuards.slice(0, 8).join(', ')}${gate.registryGuards.length > 8 ? `, … ${gate.registryGuards.length - 8} more in the full log` : ''}` : '';
  const mechanicalFlag = mechanicalPaths.length
    ? `cross-lane mechanical edits: ${mechanicalPaths.join(', ')}` : '';
  const quarantineReport = (gate.phaseVerdicts ?? []).map(phase => `${phase.role} computed quarantine verdict ${phase.blockingVerdict.green ? 'green' : 'red'}; raw exit ${phase.rawExitCode}; ${phase.blockingVerdict.quarantines.length} covered case(s); first events ${phase.blockingVerdict.quarantines.slice(0, 8).map(row => row.eventId).join(', ')}`).join('\n');
  const displayedReport = `${check}${registry}; ${scope}${quarantineReport ? `\n${quarantineReport}` : ''}${mechanicalFlag ? `\n${mechanicalFlag}` : ''}\n${renderTestSummary(summary)}`;
  const checkAccepted = Boolean(gate.check?.green || criterionMatched);
  // Only fully accounted exact-main failures or live person waivers pass a red proof; the item check stays mandatory [B3].
  const waived = !gate.isGreen && checkAccepted ? withBoard(ctx, (board) => waivedFailures(board, blockingFailures(gate, accountedFailures(gate, root)), { quarantineWaivers })) : null;
  let proofKnown;
  let proofMatched = null;
  let proofUnowned = [];
  const failures = !gate.isGreen && checkAccepted && !waived ? failureSignatures(gate, root) : null;
  if (failures && mainFailureBase && companionAllowsMain(failures)) {
    try {
      const compareStart = Date.now(); // A file with a recorded main result at this main is read from it, never rerun [C7,#5813].
      comparison = await recordedMainComparison(root, gate.profile, gateWaitReporter(ctx.io), gate.output, { commit: mainFailureBase, detailed: true, fresh: acceptedMain.config.submit?.autoFileMainReds === true, onMeasuredReceipt, runnerAdmission,
        recordedRuns: withBoard(ctx, board => gateRuns(board)), execution: { executor: gate.executionRunner ? { kind: 'ssh', host: gate.executionRunner } : { kind: 'local' }, environment: gate.environment } });
      recordGateSpan({ phase: 'main-compare', start: compareStart, outcome: 'done' });
      rememberComparison(comparison);
      proofNotices = mainFailureNotices(root, failures, comparison,
        { items: withBoard(ctx, board => store.listItems(board, { all: true })), exclude: id });
      const matched = proofMainFailures(failures, comparison, mainFailureBase, { criterion: JSON.parse(held.item_frozen ?? 'null')?.criterion ?? held.item_criterion ?? '', check: frozenCheck(held) });
      const rows = () => withBoard(ctx, board => store.listItems(board, { all: true }));
      // Affected cases are judged like the frozen check (#1917, #1986): owned reds link to their repair, unowned ones are recorded for the coordinator.
      const split = matched ? splitAmbiguousMainReds(matched, rows(), id) : null;
      if (split) noteAmbiguous(split.ambiguous);
      const missing = split ? unownedMainReds(split.clear, rows(), id) : null;
      if (missing) {
        proofMatched = matched;
        proofUnowned = missing;
        const owned = split.clear.failures.filter(row => !missing.some(red => red.file === row.file));
        proofKnown = owned.length ? linkKnownMainReworks({ main: matched.main, failures: owned }, rows(), id) : null;
      }
    } catch { /* Unavailable exact-main proof never authorizes a red submission. */ }
  }
  // The proof is judged like the check: a case an open Main red repair's own check fails on this main is known main (#2594).
  let proofMainRed = [];
  if (failures && mainFailureBase && !proofMatched && !companion && !regressesMain(failures, comparison)) {
    try {
      const items = mainRedItems();
      const mainRed = mainRedCheckCases(root, failures, items, id, mainFailureBase, retakenBaselines);
      if (mainRed.owned.length && !mainRed.rest.length) {
        const linked = linkKnownMainReworks({ main: mainFailureBase, failures: mainRed.owned }, items, id);
        if (linked) {
          proofMatched = { main: mainFailureBase, failures };
          proofMainRed = mainRed.owned;
          proofKnown = linked;
        }
      }
    } catch { /* An unavailable baseline never authorizes a red submission. */ }
  }
  const mainFailures = [...new Map([...criterionNotices, ...proofNotices].map(row => [JSON.stringify([row.file, row.name, row.status]), row])).values()];
  const plainMainFailures = mainFailures.map(row => row.message).join('\n');
  const unowned = [...criterionUnowned, ...proofUnowned];
  const unownedMain = (criterionMatched ?? proofMatched)?.main;
  const redCriterion = criterionRed && !criterionMatched;
  const criterionNames = criterionKnown ? criterionKnown.failures : [];
  let knownMainFailures = criterionKnown && proofKnown ? { main: proofKnown.main, failures: [...new Map([...criterionKnown.failures, ...proofKnown.failures].map(row => [`${row.file}\0${row.name}`, row])).values()] }
    : criterionKnown ?? proofKnown;
  if (redCriterion || !gate.isGreen && !waived && !proofMatched) {
    const accountingNote = (checkAccepted && !failures ? '\nknown-main acceptance unavailable: the proof has no complete named failure diagnostics' : '')
      + (ambiguous.length ? `\nknown main with several candidate owners (these never fail the gate; the failure is elsewhere): ${ambiguous.map(row => `${row.file} (${row.name}): ${row.candidates.map(item => `#${item}`).join(', ')}`).join('; ')}` : '');
    const message = `${plainMainFailures ? plainMainFailures + "\n" : ""}the submission proof is red at ${commit.slice(0, 12)}; fix it, commit, submit again. ${redGateReport(gate, summary, { registry, sections: [quarantineReport, mechanicalFlag] })}${accountingNote}${criterionProblem}`;
    // No submission can follow this verdict. Read-only main comparisons must not retain the seat's write lease.
    CHECKOUT_LEASES.get(ctx.io)?.release();
    CHECKOUT_LEASES.delete(ctx.io);
    comparison ??= { main: null, files: [], unavailable: 'main comparison could not be completed' };
    if (!failures && mainFailureBase && !companion) {
      try { comparison = await compareMainFailures(root, gate.profile, gateWaitReporter(ctx.io), gate.output, { commit: mainFailureBase, onMeasuredReceipt, runnerAdmission }); } catch { /* Keep the original gate refusal if main evidence is unavailable. */ }
    }
    const mainNote = withBoard(ctx, board => mainRedMessage(root, board, gate.profile, comparison));
    throw withTestOutput(new Refused('GATE_RED', `${message}${mainNote ? `\n${mainNote}` : ''}`, 'fix the reported test or gate, commit the change, and run pullboard submit <id> again'), { ...summary, mainFailures });
  }
  recordGateSpan({ phase: 'tests-judge', start: judgeStart, outcome: 'done' });
  return { gate, submissionReceiptIds, mainComparisonReceiptIds, criterionReceipts, criterionVerdict, criterionMatched, proofMatched, criterionUnowned, proofUnowned, knownMainFailures, unowned, unownedMain, waived, displayedReport, summary, mainFailures, criterionNames, criterionMainRed, proofMainRed, ambiguous, mechanicalFlag };
  };
  ctx.submitAttempt.stage = 'runner';
  // Independent stages start together; a red refuses immediately. A driven gate (ctx.runGateStages) records each stage [C7].
  // Test red is decided only after the exact-main comparison, preserving known-main acceptance.
  const stages = await (ctx.runGateStages ?? runGateStages)([
    { name: 'preflight', run: async signal => {
      try {
        if (remoteAuthorization) recordRemoteAuthorization(await runRemotePart('authorization', signal));
        // With no cells plan on accepted main, placement checks nothing; its receipt key would cost more than the tests' head start (#5752).
        const placed = remoteMode ? await runRemotePart('preflight', signal)
          : !hasCellsPlan(root, trunk.commit) ? { reused: false }
          : await cachedSubmitSourceStep(root, { kind: 'submit-placement', base: trunk.commit, source: companion?.commit ?? commit,
            code: [fileURLToPath(new URL('../../../../../packages/items/src/logic/submit/preflight.js', import.meta.url))] },
          () => requirePlannedSource(root, trunk.commit, companion?.commit ?? commit, { deferUnplaced: true }));
        if (!remoteMode && !companion && /\bapps\/cli\/src\/io\/static\/checks\.js\b/u.test(acceptedMain.config.staticChecks ?? '')) {
          const changed = git(root, ['diff', '--name-only', '-z', '--diff-filter=ACMR', acceptedMain.commit, commit]).split('\0').filter(Boolean);
          const report = await runPreflight(root, changed);
          if (!report.ok) {
            const lines = [];
            reportPreflight(report, line => lines.push(line));
            throw new Refused('GATE_RED', `preflight is red; no runner was queued. Fix the named source, commit, and submit again:\n${lines.join('\n')}`);
          }
        }
        settlePreflight.resolve();
        return placed;
      } catch (error) { settlePreflight.reject(error); throw error; }
    } },
    ...(remoteMode ? [{ name: 'selection', run: signal => preflightPassed.then(() => runRemotePart('selection', signal)).then(analysis => { settleSelection.resolve(analysis); return analysis; },
      error => { settleSelection.reject(error); throw error; }) }] : []),
    { name: 'cells', run: async signal => {
      await preflightPassed;
      const cellsStart = performance.now();
      try { const result = await (remoteMode ? (await runRemotePart('cells', signal)).cells : runnerAdmission.runnerOnly || effectiveRunners(loadMachineSettings()).length > 0
        ? await withGateSlot(root, async lease => {
          try { return await remoteSubmitCells(root, acceptedMain.commit, companion?.commit ?? commit, held, lease, readCutItems, ctx.submitHandoffOutput, { collectMachinery: true }); }
          finally {
            const admitted = Date.parse(lease.executionAdmission?.admittedAt ?? '');
            if (Number.isFinite(admitted)) ctx.io.say(`submit runner admitted: ${lease.executionAdmission.admittedAt} (approximately ${((admitted - preflightWallStart) / 1000).toFixed(2)}s from controller start; runner clock)`);
          }
        },
          { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, itemCheck: true,
            agent: me.id, item: String(id), kind: 'cells', ...runnerAdmission, remote: true, runnerOnly: true,
            onWait: queuedItemLease(ctx, held, me.id, 'build'), signal })
        : await requireSubmitCells(root, acceptedMain.commit, companion?.commit ?? commit, held, { collectMachinery: true, withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache, cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS),
        readCutItems,
        onInventory: mode => ctx.io.say(`submit cells inventory: ${mode}`),
        onAllCells: file => ctx.io.say(`submit cells: checking all cells because shared policy or root-tool file changed: ${file}`) }));
        for (const diagnostic of result.machinery ?? []) machineryRefusal(root, diagnostic, line => ctx.io.say(line));
        return result; }
      finally { reportSubmitStage(ctx, 'cells', cellsStart); }
    } },
    { name: 'doctrine', run: async signal => {
      await preflightPassed;
      // Doctrine counts only fall: accepted main's rules, at this exact commit (D1). No rule, no change.
      const doctrineStart = performance.now();
      try { return await runMachineryGuard(root, () => (runnerDoctrine ? cachedDoctrineHold(root, runnerDoctrine, async () => (await runRemotePart('doctrine', signal)).doctrine)
        : hasSubmitRules(root, acceptedMain.commit, acceptedMain.config.practice)
        ? submitRulesNarrowable(root, acceptedMain.commit, acceptedMain.config.practice)
          ? cachedDoctrineHold(root, { mainCommit: acceptedMain.commit, commit: companion?.commit ?? commit, practice: acceptedMain.config.practice, timeoutMs: acceptedMain.config.check?.timeoutMs, fast: true }, () => holdDoctrineAsync(root, { mainCommit: acceptedMain.commit, commit: companion?.commit ?? commit, practice: acceptedMain.config.practice, timeoutMs: acceptedMain.config.check?.timeoutMs, fast: true }))
          : cachedDoctrineHold(root, { mainCommit: acceptedMain.commit, commit: companion?.commit ?? commit, practice: acceptedMain.config.practice, timeoutMs: acceptedMain.config.check?.timeoutMs }, () => withGateSlot(root, async lease => {
          const remoteDoctrine = gateAdmission.runnerOnly ? doctrineRunnerChecks(root, acceptedMain.commit, lease, ctx.submitHandoffOutput) : null;
          try { return await holdDoctrineAsync(root, { mainCommit: acceptedMain.commit, commit: companion?.commit ?? commit,
            practice: acceptedMain.config.practice, timeoutMs: acceptedMain.config.check?.timeoutMs, ...(remoteDoctrine ? { runCheck: remoteDoctrine.runCheck } : {}) }); }
          finally { remoteDoctrine?.finish(); }
        },
          { executionServices, itemCheck: true, agent: me.id, item: String(id), kind: 'doctrine', ...gateAdmission, onWait: queuedItemLease(ctx, held, me.id, 'build'), onReceipt: (receipt) => ctx.io.say(`doctrine hold ${gateReceiptLine(receipt)}`), signal }))
        : []), { kind: 'doctrine', fallback: [], say: line => ctx.io.say(line),
          rule: null }); }
      finally { reportSubmitStage(ctx, 'doctrine', doctrineStart); }
    } },
    { name: 'static', run: async signal => {
      try {
        await preflightPassed;
        if (remoteMode) return await runRemotePart('static', signal);
        const changedStaticStart = performance.now();
        try {
          if (/\bapps\/cli\/src\/io\/static\/checks\.js\b/u.test(acceptedMain.config.staticChecks ?? '')) {
            await withItemPatchSubmit(root, companion, async gateRoot => {
              const checker = fileURLToPath(new URL('../static/checks.js', import.meta.url));
              const checked = await cachedSubmitSourceStep(gateRoot, { kind: 'submit-changed-static', base: acceptedMain.commit,
                source: companion?.commit ?? commit, code: [checker] }, () => {
                const changed = git(gateRoot, ['diff', '--name-only', '-z', '--diff-filter=ACMR', acceptedMain.commit, companion?.commit ?? commit]).split('\0').filter(Boolean);
                return promisify(execFile)(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', checker, '--changed-files', ...changed], { cwd: gateRoot, encoding: 'utf8' })
                  .catch(error => { throw new Refused('GATE_RED', `changed-file static checks are red; fix the named source before cells:\n${error.stderr || error.message || 'static checker failed'}`); });
              });
              if (checked.reused) ctx.io.say(cellsReceiptLine(checked.receipt));
            });
          }
        } finally { reportSubmitStage(ctx, 'changed static', changedStaticStart); }
        // Static and lint checks run once, all at once, alongside the other stages; a red one cancels them.
        const staticStart = performance.now();
        try { await withItemPatchSubmit(root, companion, gateRoot => runStaticChecks(gateRoot, submitConfig, { agent: me.id, item: String(id),
          onWait: queuedItemLease(ctx, held, me.id, 'build'), onBrowserFallback: browserAdmissionReporter(ctx.io, ctx.io.relayJson), runnerAdmission,
          executionServices, artifactDirectory: ctx.submitHandoffOutput, signal })); }
        finally { reportSubmitStage(ctx, 'static', staticStart); }
      } catch (error) {
        if (error && typeof error === 'object') error.submitFailureStage = 'fast';
        throw error;
      }
    } },
    { name: 'tests', run: judgeTests },
  ]);
  const stagesEnd = Date.now();
  const cells = stages.cells;
  // Reused cells checks have no runner slot; use their own check-receipt formatter.
  if (cells.reused) ctx.io.say(cellsReceiptLine(cells.receipt));
  if (cells.reused && cells.allCellsReason) ctx.io.say(`submit cells: checking all cells because shared policy or root-tool file changed: ${cells.allCellsReason}`);
  for (const line of cells.warnings ?? []) ctx.io.say(line);
  const doctrine = stages.doctrine;
  for (const rule of doctrine) ctx.io.say(`doctrine: ${ruleLine(rule)}`);
  let { gate, submissionReceiptIds, mainComparisonReceiptIds, criterionReceipts, criterionVerdict, criterionMatched, proofMatched, criterionUnowned, proofUnowned, knownMainFailures, unowned, unownedMain, waived, displayedReport, summary, mainFailures, criterionNames, criterionMainRed, proofMainRed, ambiguous, mechanicalFlag } = stages.tests;
  // A check red only in main's own cases, per fresh receipts at the base, records green with them listed as main-owned;
  // the gate verdict job is the record, so no builder fact is written for them [C7,#3534].
  const mainOwnedGreen = Boolean(criterionMatched && criterionVerdict?.verdict === 'green');
  if (headCommit(root) !== commit || !isClean(root)) {
    throw new Refused(
      'MOVED_DURING_GATE',
      `when the gate ended, HEAD or a tracked file differed from ${commit.slice(0, 12)}, the commit it started on, so the gate did not end on what you would submit; leave the worktree alone until the gate finishes, then submit again`,
    );
  }
  let currentTrunk = requireTrunkMerge(root, commit); // The trunk may have moved while the gate ran.
  // A main that moved through commits touching nothing this proof depends on is merged without a rerun (#1816).
  let submitted = commit;
  let trunkMove = null;
  // Queued proof is pinned to its captured main. Landing handles later composition.
  if (isSubmitHandoffWorker(ctx) && currentTrunk.commit !== acceptedMain.commit) {
    if (!contains(root, acceptedMain.commit, currentTrunk.commit)) throw new Refused('SUBMIT_HANDOFF_CHANGED', 'current main no longer contains the queued accepted policy');
    currentTrunk = acceptedMain;
  }
  if (requireComposition && !companion && currentTrunk.commit !== acceptedMain.commit) {
    const composed = await runMachineryGuard(root, () => composeAfterProof(root, { id, proofCommit: commit, proved: acceptedMain.commit, item: held, check: frozenCheck(held),
      readTrunk: () => requireTrunkMerge(root, commit) }, { selectAffectedTests, explicitCheckFiles, judgeTrunkMove,
        ...(ctx.submitHandoffOutput ? { onMergeFailure: error => writeFileSync(join(ctx.submitHandoffOutput, 'merge-failure.log'), String(error.stderr || error.stack || error.message), { mode: 0o600 }) } : {}) }),
      { kind: 'composition', rule: composeAfterProof.toString(), say: line => ctx.io.say(line), fallback: { commit, evidence: null } });
    submitted = composed.commit;
    trunkMove = composed.evidence;
    currentTrunk = requireTrunkMerge(root, submitted);
  }
  const measuredLines = changedLines(root, currentTrunk.commit, submitted);
  const size = measuredLines === null ? undefined : {
    base: currentTrunk.commit, head: submitted, lines: measuredLines, method: SUBMISSION_SIZE_METHOD,
  };
  if (requireComposition) await runMachineryGuard(root,
    () => requireSubmitComposition(root, submitted, currentTrunk, trunkMove ? trunkMove.to : acceptedMain.commit),
    { kind: 'composition', rule: requireSubmitComposition.toString(), say: line => ctx.io.say(line) });
  if (ownershipRefusal) {
    // Routing cannot turn a known red, waiver, companion or advanced source into green evidence.
    if (!gate.isGreen || waived || criterionMatched || proofMatched || knownMainFailures || unowned.length
      || companion || submitted !== commit) throw ownershipRefusal;
    const waiting = await withBoard(ctx, async board => {
      refuseUnverifiedStack(root, board, store.getItem(board, id), submitted, currentTrunk);
      requireKernelApproval(board, { root, base: currentTrunk.commit, commit: submitted, item: id });
      submitPreflight(board, id, { agentId: me.id, commit: submitted, tree: headTree(root),
        ...(size ? { submissionSize: size } : {}), inspectClauses, ...(inspectClauses ? { gateFiles: gateTestFiles(root, store.getItem(board, id)) } : {}) },
      { atomic: store.atomic, submit: store.submit, prepareSubmit: store.prepareSubmit },
      { refuse: (observed, item) => refuseUnreviewable(observed, item,
        { policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family }, store) });
      return ordered(ctx, board, 'deferOwnership', [id, { agentId: me.id, root, commit: submitted,
        tree: headTree(root), main: acceptedMain.commit, receiptIds: [...new Set(submissionReceiptIds)] }]);
    });
    const result = { id, item: id, commit: waiting.commit, tree: waiting.tree,
      waitingOwner: { key: waiting.key, owners: waiting.owners, paths: waiting.paths,
        diff: waiting.diff, sourceRef: waiting.sourceRef } };
    if (ctx.submissionResult) ctx.submissionResult.value = result;
    ctx.io.result?.(result);
    ctx.io.say(`#${id} waits on ${waiting.owners.join(', ')} for ${waiting.paths.join(', ')}; your claim is released`);
    return 0;
  }
  const machineAuthorization = await withBoardRead(ctx, board => machineVerificationEligible(board, held, filesSince(root, id, claimHead, submitted)));
  let machineReceiptIds;
  if (machineAuthorization) {
    if (companion || !gate.isGreen || waived || criterionMatched || knownMainFailures) throw new Refused('MACHINE_PROOF', 'machine verification requires entirely green composed proof; this item needs its failures resolved first');
    if (currentTrunk.commit !== acceptedMain.commit) throw new Refused('NO_POLICY', 'main moved before machine verification; merge current main and resubmit');
    machineReceiptIds = [];
    const commands = [{ clause: 0, command: frozenCheck(held) }, ...machineAuthorization.commands];
    for (const entry of commands) {
      const checkedItem = { ...held, item_commit: submitted, item_frozen: JSON.stringify({ ...JSON.parse(held.item_frozen), check: entry.command }) };
      const browser = await checkNeedsBrowser(root, entry.command, { commit: submitted });
      const gui = await checkNeedsGui(root, entry.command, { commit: submitted });
      const result = await withGateSlot(root, flakeVerify(ctx, checkedItem, entry.command, { main: currentTrunk.commit, commit: submitted },
        { ordered, withBoard, resourceAgent, checkAtCommit }), { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() },
        ...runnerAdmission, browser, gui, agent: me.id, item: String(id), kind: 'review', itemCheck: true,
        onWait: queuedItemLease(ctx, held, me.id, 'build') });
      if (result.state !== 'pass' || !result.proofReceiptId) throw new Refused('MACHINE_CLAUSE_RED', `machine ${entry.clause ? `clause ${entry.clause}` : 'frozen check'} failed: ${entry.command}; ${result.report}`);
      machineReceiptIds.push(result.proofReceiptId);
    }
    if (requireTrunkMerge(root, submitted).commit !== currentTrunk.commit) throw new Refused('NO_POLICY', 'main moved during machine verification; merge main and rerun the composed proof');
  }
  const waivedLines = waived ? waived.map(waiverLine) : [];
  const autoMainReds = unowned.length && acceptedMain.config.submit?.autoFileMainReds === true
    ? { main: unownedMain, candidateReceiptIds: [...new Set(submissionReceiptIds)], mainReceiptIds: [...new Set(mainComparisonReceiptIds.values())] } : null;
  const submitRecordStart = Date.now();
  recordGateSpan({ phase: 'submit-prepare', start: stagesEnd, end: submitRecordStart, outcome: 'done' });
  await withBoard(ctx, async (board) => {
    refuseUnsubmittableStack(root, board, store.getItem(board, id), submitted, currentTrunk);
    // The waived run is written to the item's thread before the submission, so no waived proof reads as green.
    if (waived) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `submission proof at ${commit.slice(0, 12)} was red and is recorded as waived, not green; every failure is covered by a live person waiver:\n${waivedLines.join('\n')}` }]);
    if (criterionNames.length && !mainOwnedGreen) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `frozen check red at ${commit.slice(0, 12)} only in cases that fail identically on main at ${criterionMatched.main}: ${criterionNames.map(row => `${row.file} (${row.name}), open repair #${row.item}`).join('; ')}. Reviewers: these known main reds are listed, not blocking; any case green on main would have refused.` }]);
    if (criterionMainRed.length && !mainOwnedGreen) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `frozen check red at ${commit.slice(0, 12)} only in cases that open Main red repairs' own checks fail on main at ${criterionMatched.main}: ${criterionMainRed.map(row => `${row.file} (${row.name}), repair #${row.item}`).join('; ')}. Reviewers: these known main reds are listed, not blocking.` }]);
    if (proofMainRed.length) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `submission proof red at ${commit.slice(0, 12)} only in cases that open Main red repairs' own checks fail on main at ${proofMatched.main}: ${[...new Map(proofMainRed.map(row => [`${row.file}\0${row.name}`, row])).values()].map(row => `${row.file} (${row.name}), repair #${row.item}`).join('; ')}. No new failure is accepted.` }]);
    if (criterionUnowned.length && !autoMainReds && !mainOwnedGreen) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `unowned known main red: the frozen check fails identically on main at ${criterionMatched.main} in ${criterionUnowned.map(red => `${red.file} (${red.names.join('; ')})`).join('; ')}, and no open Main red item names the file; a decision was shouted to the coordinator.` }]);
    if (proofUnowned.length && !autoMainReds) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `unowned known main red: the submission proof at ${commit.slice(0, 12)} fails identically on main at ${proofMatched.main} in ${proofUnowned.map(red => `${red.file} (${red.names.join('; ')})`).join('; ')}, and no open Main red item names the file; a decision was shouted to the coordinator. The item check passed; no new failure is accepted.` }]);
    if (knownMainFailures) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `submission proof at ${commit.slice(0, 12)} remains red; known main failures at ${knownMainFailures.main}: ${knownMainFailures.failures.map(row => `${row.file} (${row.name}), open repair #${row.item}`).join('; ')}. The item check passed; no new or unaccounted failure is accepted.` }]);
    const quarantineProofIds = [];
    for (const receiptId of submissionReceiptIds) {
      const receipt = boundProofReceipt(board, { receiptId });
      sealQuarantineVerdict(board, receipt);
      if (Object.hasOwn(receipt, 'blockingVerdict')) quarantineProofIds.push(receiptId);
    }
    requireKernelApproval(board, { root, base: currentTrunk.commit, commit: companion?.commit ?? submitted, item: id });
    const submittedMove = await ordered(ctx, board, 'submit', [id, { agentId: me.id, commit: submitted, tree: headTree(root) ?? '', files: filesSince(root, id, claimHead, commit), policyCommit: acceptedMain.commit, ...submitTooling(root, submitted), ...(infraRecord ? { infra: infraRecord } : {}),
      ...(inspectClauses ? { inspectClauses: true } : {}),
      ...(machineReceiptIds ? { machineReceiptIds } : {}),
      gateGreen: gate.isGreen && !waived && (!criterionMatched || mainOwnedGreen),
      ...(autoMainReds ? { autoMainReds } : {}),
      ...(quarantineProofIds.length ? { quarantineProofIds } : {}),
      ...(size ? { submissionSize: size } : {}),
      ...(companion ? { companion } : {}),
      submissionProof: { version: 1, files: gate.files, full: gate.full, deferred: gate.deferred, reason: boundedProofReason(gate.reason), ...(gate.deferredFiles ? { deferredFiles: gate.deferredFiles } : {}), ...(knownMainFailures ? { knownMainFailures } : {}) },
      ...((gate.deferred || mechanicalFlag) ? { note: [
        ...(gate.deferred ? [gate.deferredFiles ? deferredSelectionNote(gate.deferredFiles) : 'full suite deferred to the landing gate'] : []),
        ...(mechanicalFlag ? [mechanicalFlag] : []),
      ].map(part => part.replace(/[\r\n\u2028\u2029]/gu, ' ')).join('; ') } : {}) }]);
    if (inspectClauses) {
      // The gate ticks the clauses that name a test file it ran green, from its own receipt; a red gate ticks none (#3697).
      if (gate.isGreen && !waived && (!criterionMatched || mainOwnedGreen)) {
        const outcomes = submissionReceiptIds.flatMap(receiptId => boundProofReceipt(board, { receiptId }).testOutcomes ?? []);
        for (const text of gateClauseTickNotes(store.getItem(board, id), store.itemThread(board, id), { gateFiles: gateTestFiles(root, held), outcomes, head: submitted }, { clauseTicks, criterionClauses, gateNamedFile })) {
          await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note', text }]);
        }
      }
      const summary = clauseInspectionSummary(store.getItem(board, id), store.itemThread(board, id), { gateFiles: gateTestFiles(root, held), head: submitted });
      if (summary) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note', text: summary }]);
    }
    // One fact records the merge and the evidence that the main move touched nothing this proof depends on.
    if (trunkMove) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: trunkMoveFact(trunkMove) }]);
    // One decision shout (a lane question, routed to the lead or coordinator because a builder cannot send kind decision) asks the coordinator to own the repair; it is sent only once the submission is recorded.
    if (autoMainReds) {
      const event = store.events(board, { itemId: id }).filter(row => row.event_kind === 'submit').at(-1);
      knownMainFailures = event && JSON.parse(event.event_detail).submissionProof?.knownMainFailures;
    }
    if (unowned.length && !autoMainReds) try {
      await ordered(ctx, board, 'shout', [{ from: me.id, to: COORDINATOR, lanes: laneNames(ctx.config), decision: true,
        text: boundedMainRedShout(id, unowned, unownedMain) }]);
    } catch (error) {
      ctx.io.err(`submitted #${id}, but its main-red notice failed: ${error.message}; read pullboard show ${id}`);
    }
    return submittedMove;
  });
  recordGateSpan({ phase: 'submit-record', start: submitRecordStart, outcome: 'done' });
  const postSubmitStart = Date.now();
  if (machineReceiptIds) {
    ctx.io.say(`machine-verified #${id}: frozen check and ${machineAuthorization.commands.length} clauses passed`);
    try { await landAfterAcceptance(ctx); }
    catch (error) { ctx.io.err(`automatic landing retained machine-verified work: ${error.code ?? error.name}: ${error.message}`); }
  } else if (gate.isGreen && !waived && (!criterionMatched || mainOwnedGreen)) {
    try { if (submissionReceiptIds.length) for (const line of countTrialGate(root, { id: JSON.stringify([...submissionReceiptIds].sort()) })) ctx.io.say(line); }
    catch { ctx.io.err('could not record this gate in the refusal-trial ledger'); }
    try { if (mainComparisonMode() !== 'off') await (await import('./verify.js')).startAutomaticComparison(ctx, id); }
    catch (error) { ctx.io.err(`comparison could not start for #${id}: ${error.message}`); }
  }
  recordGateSpan({ phase: 'post-submit', start: postSubmitStart, outcome: 'done' });
  // A large submit still goes through; the note only suggests a chain of smaller items (#1162).
  const sizeNote = oversizeNote(measuredLines, acceptedMain.config.itemSizeBudget);
  if (sizeNote) ctx.io.say(`note: ${sizeNote}`);
  for (const reminder of submitReferenceReminders(root, held, commit)) ctx.io.err(reminder);
  const unownedNames = (autoMainReds ? [] : unowned).flatMap(red => red.names.map(name => `${red.file} (${name})`));
  const report = knownMainFailures || unowned.length || ambiguous.length
    ? `submission proof red with ${(knownMainFailures?.failures.length ?? 0) + unownedNames.length + ambiguous.length} known main failure(s) at ${unownedMain ?? knownMainFailures.main}; ${criterionMatched ? 'item check red only in known main cases' : 'item check green'}; no new failures accepted.${unownedNames.length ? ` Unowned${autoMainReds ? ", repairs filed by submit" : ", shouted to the coordinator"}: ${unownedNames.join('; ')}.` : ''}${ambiguous.length ? ` Known main with several candidate owners (still not failing the gate): ${ambiguous.map(row => `${row.file} (${row.name}): ${row.candidates.map(item => `#${item}`).join(', ')}`).join('; ')}.` : ''} ${displayedReport}`
    : waived
    ? `submission proof waived, not green: ${waived.length} failure(s), each covered by a live person waiver.\n${waivedLines.join('\n')}\n${displayedReport}`
    : displayedReport;
  if (trunkMove) ctx.io.say(trunkMoveFact(trunkMove));
  for (const notice of mainFailures) ctx.io.say(notice.message);
  return reportSubmission(ctx, id, submitted, { mainFailures, green: gate.isGreen && (!criterionMatched || mainOwnedGreen), report, files: gate.files, full: gate.full, deferred: gate.deferred, deferFullFallback: gate.deferFullFallback, ...(gate.deferredFiles ? { deferredFiles: gate.deferredFiles } : {}), reason: gate.reason, check: { ...gate.check, profile: summaryProfile(gate.check.profile) },
    ...summary, log: gate.log, profile: summaryProfile(gate.profile), profilePath: gate.profilePath, proofLog: gate.proofLog, proofProfilePath: gate.proofProfilePath,
    ...(gate.testTiers ? { testTiers: gate.testTiers, phasePlan: gate.phasePlan, proofReceiptIds: gate.proofReceiptIds } : {}),
    ...(companion ? { companion } : {}),
    ...(knownMainFailures ? { knownMainFailures } : {}),
    ...(knownMainFailures ? { knownMainReworks: knownMainFailures.failures.map(({ file, name, item }) => ({ file, name, item })), mainReceiptIds: [...new Set(mainComparisonReceiptIds.values())] } : {}),
    ...(ambiguous.length ? { knownMainAmbiguous: ambiguous } : {}),
    ...(criterionMatched && criterionReceipts.length ? { mainRedReceipts: criterionReceipts } : {}),
    ...(mainOwnedGreen ? { mainOwned: criterionVerdict.mainOwned, gateVerdict: criterionVerdict.id } : {}),
    ...(unowned.length && !autoMainReds ? { knownMainUnowned: unowned.flatMap(red => red.names.map(name => ({ file: red.file, name }))) } : {}),
    ...(waived ? { waived: waived.map(({ file, name, waiver }) => ({ file, name, waiver: waiver.id, reason: waiver.reason, until: waiver.until })) } : {}) }, doctrine);
}

/**
 * The gate base as the main-owned verdict reads it: its commit, tree and commit time in milliseconds.
 *
 * @param {string} root
 * @param {string} commit - the gate base
 * @param {string} tree - the base's tree id
 * @returns {{ commit: string, tree: string, at: number }}
 */
function verdictBase(root, commit, tree) {
  return { commit, tree, at: Number(git(root, ['show', '-s', '--format=%ct', commit]).trim()) * 1000 };
}

/**
 * Main's cached receipts at the base in the verdict's shape. A receipt cached under the base commit was measured on
 * the base itself, so it is never older than the base.
 *
 * @param {ReturnType<typeof mainReceipts>} known
 * @param {{ at: number }} base
 * @returns {object[]}
 */
function verdictReceipts(known, base) {
  return [...known.receipts.values()].map(receipt => ({ ...receipt, at: base.at }));
}

/**
 * The failing case names main's receipts record per file at one main commit, measuring the files with no receipt
 * there (on a runner when the machine requires one); null when main's tree or test command cannot be read.
 *
 * @param {object} ctx
 * @param {{ root: string, commit: string, files: string[], output?: string, runnerAdmission?: object, onMeasuredReceipt?: (id: string) => Promise<void> }} at
 * @returns {Promise<Map<string, Set<string>> | null>}
 */
async function mainCasesAt(ctx, { root, commit, files, output = '', runnerAdmission, onMeasuredReceipt }) {
  let known = mainReceipts(root, commit, files);
  if (!known) return null;
  const missing = files.filter(file => !known.rows.has(file));
  if (missing.length) {
    await compareMainFailures(root, { tests: missing.map(file => ({ file, passed: false })) }, gateWaitReporter(ctx.io), output,
      { commit, detailed: true, contentCache: false, onMeasuredReceipt, runnerAdmission });
    known = mainReceipts(root, commit, files);
  }
  return new Map(files.map(file => [file, new Set(known?.rows.get(file)?.result === 'red'
    ? (known.rows.get(file).failures ?? []).filter(failure => !failure.file || failure.file === file || failure.ran === file).map(failure => failure.name) : [])]));
}

/**
 * Record the submit gate's main-owned verdict over a red check's cases [C7,#3534]. With fresh receipts at the base
 * for every red file, it records green when main names every case red, or red with the candidate's own cases. A file
 * with no fresh receipt queues its main-test job; the gate runs the job now (on a runner when the machine requires
 * one), reports each result through returnMainTest, and finishes the verdict; the item never goes back to its builder
 * for a red main owns. Nothing here authorizes a red: the caller still judges from main's keyed receipts.
 *
 * @param {object} ctx
 * @param {{ root: string, item: number, candidate: string, base: string, cases: { file: string, name: string }[],
 *   output?: string, runnerAdmission?: object, onMeasuredReceipt?: (id: string) => Promise<void> }} gate
 * @returns {Promise<{ id: string, verdict: 'green' | 'red' | 'pending', mainOwned: object[], own: object[] } | null>}
 *   null when main's tree or test command cannot be read, so no verdict can be keyed.
 */
async function mainOwnedGate(ctx, { root, item, candidate, base, claimBase = null, cases, output = '', runnerAdmission, onMeasuredReceipt }) {
  const files = [...new Set(cases.map(row => row.file))];
  const reds = cases.map(({ file, name }) => ({ file, name }));
  // A later main red never excuses a case green at the item's own claim base: there every case must be red too [V4,B3].
  if (claimBase && claimBase !== base) {
    const atClaim = await mainCasesAt(ctx, { root, commit: claimBase, files, output, runnerAdmission, onMeasuredReceipt });
    const own = reds.filter(row => !atClaim?.get(row.file)?.has(row.name));
    if (own.length) return { id: null, verdict: 'red', mainOwned: [], own, missing: [] };
  }
  const known = mainReceipts(root, base, files);
  if (!known) return null;
  const at = verdictBase(root, base, known.tree);
  const ports = mainOwnedVerdictPorts();
  const first = withBoard(ctx, board => recordGateVerdict(ports, board.db, { item: Number(item), candidate, base: at, command: known.command, reds, receipts: verdictReceipts(known, at) }));
  if (first.verdict !== 'pending') return first;
  // The main-test jobs run main's files at the base now, through the same runner admission as the gate [C7,#3534].
  const measured = await compareMainFailures(root, { tests: first.missing.map(file => ({ file, passed: false })) }, gateWaitReporter(ctx.io), output,
    { commit: base, detailed: true, contentCache: false, onMeasuredReceipt, runnerAdmission });
  return withBoard(ctx, board => {
    first.missing.forEach((file, index) => {
      const row = (measured?.files ?? []).find(entry => entry.file === file);
      if (!['red', 'green'].includes(row?.result)) return;
      returnMainTest(ports.jobs, board.db, first.queued[index], { id: row.receiptId ?? first.queued[index], tree: at.tree, file, command: known.command,
        verdict: row.result, failing: (row.failures ?? []).filter(failure => !failure.file || failure.file === file).map(failure => failure.name), at: Date.now() });
    });
    const finished = finishAwaitingVerdicts(ports, board.db).find(row => row.id === first.id);
    return finished ? { ...finished } : first;
  });
}

/** `submit --preflight`: run every registered static check in parallel on this branch's changed files and submit nothing [C7]. */
async function preflightHere(ctx) {
  const { root } = ctx.info;
  const changed = tryGit(root, ['diff', '--name-only', '-z', 'refs/heads/main...HEAD']);
  const files = changed.status === 0 ? changed.stdout.split('\0').filter(Boolean) : [];
  return reportPreflight(await runPreflight(root, files), line => ctx.io.say(line));
}

/** Run `pullboard submit` and return its exit code. */
/**
 * Tick the claimed item's test clauses after a green `pullboard test` run of files inside its check, as ordinary note facts.
 * Why: submit reads those notes, so a green runner proof no longer ends in CLAUSE_UNTICKED [C7].
 */
export async function recordClauseTicks(io, itemId, files) {
  await actOn(io, async (ctx, board, me) => {
    const found = store.getItem(board, itemId);
    if (found.item_owner !== me.id) return 0;
    for (const text of testRunTickNotes(found, files, headCommit(ctx.info.root))) await ordered(ctx, board, 'appendFact', [itemId, { agentId: me.id, kind: 'note', text }]);
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
function hostedSubmitRunner(env = process.env) {
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
  const branch = `${me.lane}/item-${id}`, root = ctx.info.root, existed = existsSync(local);
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

export async function run(io, { first, values }) {
  const submissionResult = {};
  let ctx = { ...context(io), submissionResult, precheck: values.precheck === true, json: values.json === true };
  const id = idArg(first);
  if (values.preflight) return preflightHere(ctx);
  const companionInput = values.companion === undefined ? null : { file: values.companion, key: values.key, author: values.author };
  if (companionInput && (!companionInput.file || !companionInput.key || !companionInput.author)) {
    throw new Refused('USAGE', 'use pullboard submit <id> --companion <patch-file> --key <key> --author <owning-seat>');
  }
  const hostRunner = hostedSubmitRunner();
  if (hostRunner) {
    io.cwd = await handOffHostedSubmit(ctx, id, hostRunner);
    ctx = { ...context(io), submissionResult, precheck: ctx.precheck, json: ctx.json };
  }
  /** Dispatch before optional verdict waiting, retaining this exact submission document. */
  ctx.afterSubmission = submission => completeMoveHandoff(ctx, id, values, submission, { nextOnce, withBoardRead, listItems: store.listItems, agentSessionDigest });
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
  return waitForSubmitGate(ctx, id, submissionResult.value, submissionResult.job,
    { withBoardRead: waitBoardRead, submitHandoff, getItem: store.getItem, ownershipWait: store.ownershipWait, ownershipWaitForJob: store.ownershipWaitForJob });
}
import { SUBMISSION_SIZE_METHOD } from '../../../../../packages/state/light.js';

/**
 * The tooling tree that judged this submit (RFC 0007 SC7, SC8), recorded so review and landing reuse its receipt only
 * under the same tooling; an unreadable pin records nothing and the receipt is never reused.
 *
 * @param {string} root - The item folder.
 * @param {string} commit - The submitted commit.
 * @returns {{ tooling?: string }} The field to spread into the submit record.
 */
function submitTooling(root, commit) {
  try { return { tooling: toolingFor(root, commit).tooling }; } catch { return {}; }
}
