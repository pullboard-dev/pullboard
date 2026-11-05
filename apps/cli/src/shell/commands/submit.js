import { requireKernelApproval } from '../../../../../packages/verify/index.js';
import { machineryRefusal } from '../../../../../packages/gate/index.js';
import { runMachineryGuard } from '../../../../../packages/gate/index.js';
import { countTrialGate } from '../../../../../packages/gate/index.js';
import { itemFolderIdentity } from '../item-folder.js';
import { itemCollisionPlan } from '../../../../../packages/items/index.js';
import { heartbeatCommand } from '../cli-presence.js';
import { cachedSubmitSourceStep } from '../submit-controller-cache.js';
import { remoteSubmitCells } from '../submit-cells-remote.js';
import { mergeSubmissionMain } from '../../../../../packages/merge/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requireNonEmptySubmit } from '../../../../../src/empty-submit.js';
import { fileURLToPath } from 'node:url';
import { clauseInspectionProblem } from '../../../../../packages/state/index.js';
import { clauseInspectionSummary } from '../../../../../packages/state/index.js';
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
} from '../submit-handoff-origin.js';
import { blockingFailures } from '../../../../../packages/verify/index.js';
import { boundProofReceipt } from '../../../../../packages/store/index.js';
import { sealQuarantineVerdict } from '../../../../../packages/flakes/index.js';
import { gateRuns } from '../../../../../packages/flakes/index.js';
import { withImportParseCache } from '../../../../../packages/gate/index.js';
import { foreignNodeOptions } from '../../../../../packages/gate/index.js';
import { importsIn } from '../../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../../packages/gate/index.js';
import { requireSubmitCells } from '../../../../../bin/cells-submit-checks.js';
import { landedCutItemRows } from '../../../../../bin/cells-submit-checks.js';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gateRunnerAdmission } from '../../../../../packages/config/index.js';
import { browserFreeChecksEnabled } from '../../../../../packages/config/index.js';
import { remoteGateWanted } from '../submit-remote-gate.js';
import { remoteSubmitAnalysis } from '../submit-remote-gate.js';
import { gateWithRunnerPlan } from '../submit-remote-gate.js';
import { doctrineRunnerChecks } from '../submit-remote-gate.js';
export { doctrineExecutionPhases } from '../submit-remote-gate.js';
import { loadMachineSettings } from '../../../../../packages/config/index.js';
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
import { withBoardRead as waitBoardRead } from '../cli-context.js';
import { retrySync } from '../cli-sync.js';
import { checkAtCommit } from '../../../../runner/index.js';
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../../packages/landing/index.js';
import { submitGateConfig } from '../../../../../packages/gate/index.js';
import { createHash } from 'node:crypto';
import { prepareItemPatchSubmit } from '../../../../../packages/items/index.js';
import { withItemPatchSubmit } from '../../../../../packages/items/index.js';
import { boundedProofReason } from '../../../../../packages/state/src/core/submission-proof.js';
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
  freezer,
  idArg,
  ordered,
  queuedItemLease,
  refuseUnverifiedStack,
  reportSubmission,
  resourceAgent,
  whoAmI,
  claimOrdered,
  claimFreezer,
  withBoard,
} from '../cli.js';
import { recordedRecovery } from '../../../../../packages/state/index.js';
import { failureSignatures } from '../../../../../packages/landing/index.js';
import { MAIN_FAILURE_SIGNATURE_VERSION } from '../../../../../packages/landing/index.js';
import { matchingMainFailures } from '../../../../../packages/landing/index.js';
import { mainFailureNotices } from '../../../../../packages/landing/index.js';
import { linkKnownMainReworks } from '../../../../../packages/store/index.js';
import { unownedMainReds } from '../../../../../packages/store/index.js';
import { splitAmbiguousMainReds } from '../../../../../packages/store/index.js';
import { mainRedBaselinesToRetake } from '../../../../../packages/store/index.js';
import { mainRedItemCases } from '../../../../../packages/store/index.js';
import { itemCheckBaseline } from '../../../../../packages/store/index.js';
import { checkBaseline as retakeCheckBaseline } from '../../../../../packages/gate/index.js';
import { submitReferenceReminders } from '../../../../../packages/spec/index.js';
import { waitForSubmitGate } from '../submit-gate-wait.js';

/** Report wall time without sharing the execution closures of unrelated submit stages. */
function reportSubmitStage(ctx, name, start) {
  ctx.io.say(`submit ${name}: ${((performance.now() - start) / 1000).toFixed(2)}s`);
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

/** Stop unchanged third red submissions while naming the two test failures that need repair. */
function requireRedSubmitProgress(root, board, id, digest, candidate, main) {
  const red = redSubmitTestRuns(board, id, digest, root);
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

export async function submitHere(ctx, id, infra) {
  const { root } = ctx.info;
  const inspectClauses = (submitHandoffPolicy(ctx) ?? mainPolicy(root)).config.verify.inspectClauses === true;
  const handoffEnabled = ctx.config.submit.handoff === true && !isSubmitHandoffWorker(ctx);
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
      refuseUnverifiedStack(root, board, item, recovered.args[1].commit, trunk);
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
  const runnerAdmission = gateRunnerAdmission();
  const held = await withBoard(ctx, async (board) => {
    const me = whoAmI(ctx, board);
    const item = store.getItem(board, id);
    const folder = itemFolderIdentity(board, ctx.info.root);
    if (folder && folder.item !== id) throw new Refused('NOT_YOURS', `this folder belongs to item #${folder.item}; submit that item from here`);
    if (!isSubmitHandoffWorker(ctx) && !folder) refuseHeldElsewhere(ctx.info, store.listAgents(board), item, 'submit', agentSessionDigest);
    if (item.item_status !== 'claimed' || item.item_owner !== me.id) throw new Refused('NOT_YOURS', 'claim this item before submitting it');
    if (!isSubmitHandoffWorker(ctx)) heartbeatCommand(ctx.io, { ctx, board });
    const readiness = barReadyProblem(board, item);
    if (readiness) throw readiness;
    const clauseProblem = inspectClauses ? clauseInspectionProblem(item, store.itemThread(board, id)) : null;
    if (clauseProblem) throw clauseProblem;
    const correction = store.pendingRefreezeProblem(board, id);
    if (correction) {
      await claimOrdered(ctx, board, [id, { agentId: me.id, lane: me.lane, leaseMs: ctx.config.leaseMs,
        freeze: claimFreezer(ctx, board), head: headCommit(root) }]);
      return store.getItem(board, id);
    }
    return item;
  });
  ctx.submitAttempt = { agentId: held.item_owner, digest: held.item_frozen_digest };
  ctx.submitAttempt.stage = 'fast';
  const policy = itemPolicy(root, held);
  let acceptedMain = submitHandoffPolicy(ctx) ?? mainPolicy(root);
  // Fail fast, cheapest first: a dirty tree or a change that conflicts with main is refused before any other work, check or test.
  if (!isClean(root)) throw new Refused('DIRTY', 'commit your changes first; the gate must check what you submit');
  const stray = untracked(root);
  if (stray.length) throw new Refused('UNTRACKED', `commit or ignore ${stray.length} untracked file(s), e.g. ${stray[0]}`);
  let commit = headCommit(root);
  if (!commit) throw new Refused('NO_COMMIT', 'nothing committed yet');
  // A live handoff owns its captured source; never rewrite it underneath its queued worker.
  const pendingHandoff = !isSubmitHandoffWorker(ctx) ? (await (await import('../submit-handoff.js')).recoverItemSubmitHandoff(ctx, id, held.item_owner), withBoard(ctx, board => pendingSubmitHandoff(board, held))) : null;
  const pending = pendingHandoff && pendingHandoff.commit !== commit ? await (await import('../submit-handoff.js')).replaceSubmitHandoff(ctx, id, held.item_owner, pendingHandoff) : pendingHandoff;
  let mainMerge = null;
  if (!isSubmitHandoffWorker(ctx) && !pending) {
    mainMerge = mergeSubmissionMain(root, acceptedMain.commit);
    commit = mainMerge.commit;
    if (mainMerge.merged) {
      ctx.io.say(`Merged main ${acceptedMain.commit.slice(0, 12)} into the builder source as ${commit.slice(0, 12)}; checking the composed tree.`);
    }
  }
  requireNonEmptySubmit(root, id, commit, acceptedMain.commit);
  let trunk;
  let regenerated = null;
  try { trunk = requireTrunkMerge(root, commit, isSubmitHandoffWorker(ctx) ? acceptedMain.commit : undefined); }
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
  withBoard(ctx, (board) => refuseProvesNothing(() => acceptedMain.config, board, store.getItem(board, id)));
  withBoard(ctx, board => requireKernelApproval(board, { root, base: acceptedMain.commit, commit, item: id }));
  const dependencies = withBoard(ctx, board => dependencySnapshots(board.db, held));
  let mechanicalPaths = [];
  let ownershipRefusal = null;
  try {
    submissionPaths(root, held, headCommit(root), { mainCommit: acceptedMain.commit, dependencies,
      onMechanicalPaths: paths => { mechanicalPaths = paths; } });
  } catch (error) {
    if (error.code !== 'OUTSIDE_LANE' || !Array.isArray(error.paths)) throw error;
    ownershipRefusal = error;
  }
  const { me, claimHead } = withBoard(ctx, (board) => {
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
  });
  // A trunk checkout can have advanced since the claim; comparing it with itself would bless its own new red test.
  const mainFailureBase = acceptedMain.commit === commit ? claimHead : git(root, ['merge-base', commit, acceptedMain.commit]);
  const preflightLines = changedLines(root, acceptedMain.commit, commit);
  const preflightSize = preflightLines === null ? undefined : { base: acceptedMain.commit, head: commit, lines: preflightLines, method: SUBMISSION_SIZE_METHOD };
  withBoard(ctx, (board) => submitPreflight(board, id, { agentId: me.id, commit, tree: headTree(root) ?? '', submissionSize: preflightSize, inspectClauses }, { atomic: store.atomic, submit: store.submit, prepareSubmit: store.prepareSubmit }, { refuse: (observed, item) => refuseUnreviewable(observed, item, { policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family }, store) }));
  const companion = await withBoard(ctx, async board => {
    if (store.itemPatches(board, id).some(patch => patch.commit !== commit || patch.source?.commit !== commit)) {
      await ordered(ctx, board, 'followItemPatches', [id, { agentId: me.id, commit }]);
    }
    return prepareItemPatchSubmit(root, board, held, commit);
  });
  if (companion) withBoard(ctx, board => requireKernelApproval(board, { root, base: acceptedMain.commit, commit: companion.commit, item: id }));
  withBoard(ctx, board => requireSubmitHandoffExecution(ctx, board, companion?.commit ?? commit, companion?.tree ?? headTree(root)));
  if (!pending) withBoard(ctx, board => requireRedSubmitProgress(root, board, id, held.item_frozen_digest, companion?.commit ?? commit, acceptedMain.commit));
  if (mainMerge?.merged) await withBoard(ctx, board => ordered(ctx, board, 'appendFact', [id, { agentId: held.item_owner, kind: 'note',
    text: `Builder ${held.item_owner} automatic main merge: source ${mainMerge.source}, main ${acceptedMain.commit}, merge ${commit}.` }]));
  const barWarning = await withBoard(ctx, async board => {
    const warning = barCheckWarning(board, held);
    if (!warning) return null;
    await ordered(ctx, board, 'appendFact', [id, { agentId: held.item_owner, kind: 'note', text: `bar.check warning: ${warning}` }]);
    return warning;
  });
  if (barWarning) ctx.io.say(`bar.check warning: ${barWarning}`);
  if (inspectClauses) await withBoard(ctx, async board => {
    const summary = clauseInspectionSummary(held, store.itemThread(board, id));
    if (summary) await ordered(ctx, board, 'appendFact', [id, { agentId: held.item_owner, kind: 'note', text: summary }]);
  });
  reportSubmitStage(ctx, 'authorization and source', preflightStart);
  // The candidate must contain the main this proof pins; a main that moves on before or during the proof is judged after it.
  const compositionStart = performance.now();
  try { if (requireComposition && !remoteMode) await runMachineryGuard(root,
    () => requireSubmitComposition(root, commit, { commit: acceptedMain.commit }, acceptedMain.commit),
    { kind: 'composition', rule: requireSubmitComposition.toString(), say: line => ctx.io.say(line) }); }
  finally { reportSubmitStage(ctx, 'composition', compositionStart); }
  withBoard(ctx, (board) => refuseUnverifiedStack(root, board, held, commit, trunk));
  machineNameProblems(root, `${acceptedMain.commit}..${commit}`, { refuse: acceptedMain.config.commits.noHostName === true, say: (line) => ctx.io.say(line) });
  const infraRecord = infraNotes.infraNote({ root, claimHead, commit, files: filesSince(root, id, claimHead, commit), gates: [ctx.config.gate, acceptedMain.config.gate], infra, requireInfraNote: acceptedMain.config.submit.requireInfraNote });
  const regeneratedFrom = toolRegenerationSource(root, commit);
  // Queue all captured sources before cell compilation; the bound worker runs the same checks and refusal path.
  if (pending || handoffEnabled) {
    const { enqueueSubmitHandoff } = await import('../submit-handoff.js');
    return enqueueSubmitHandoff(ctx, held, me, { commit, tree: headTree(root), companion, infra, main: acceptedMain.commit });
  }
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
  // Each trusted analysis part gets its own runner lease and a main-pinned private check.
  const runRemotePart = (part) => runMachineryGuard(root, () => withItemPatchSubmit(root, companion, gateRoot => withGateSlot(gateRoot,
    lease => remoteSubmitAnalysis(gateRoot, { main: acceptedMain.commit, source: companion?.commit ?? commit,
      trunk: trunk.commit, base: claimHead, check: frozenCheck(held), criterion: JSON.parse(held.item_frozen ?? 'null')?.criterion ?? '',
      title: held.item_title ?? '', composition: requireComposition ? commit : null, staticChecks: submitConfig.staticChecks, crossRunTests: part === 'selection' ? crossRun.tests : [],
      config: submitConfig, browserFreeChecks: browserFreeChecksEnabled(), readCutItems, parts: [part], collectMachinery: true }, lease, ctx.submitHandoffOutput),
    { executionServices, itemCheck: true, agent: me.id, item: String(id), kind: `analysis-${part}`, ...gateAdmission,
      onWait: queuedItemLease(ctx, held, me.id, 'build') })),
    { kind: 'composition', rule: requireSubmitComposition.toString(), say: line => ctx.io.say(line) });
  const crossRun = await withBoardRead(ctx, board => {
    board.gitRoot = ctx.info.root;
    return itemCollisionPlan(board, held, store.listItems(board, { all: true }));
  });
  for (const warning of crossRun.warnings) ctx.io.say(warning);
  const runGate = (check, runnerPlan = {}) => withItemPatchSubmit(root, companion, gateRoot => runSubmitGate(gateRoot, submitConfig, { ...runnerPlan, executionServices, staticChecked: true, crossRunTests: crossRun.tests, outputRoot: root, outputLog: ctx.submitHandoffOutput ? join(ctx.submitHandoffOutput, 'gate.log') : undefined, runnerAdmission: gateAdmission, signatureCapture: acceptedMain.config.submit?.autoFileMainReds === true ? { version: MAIN_FAILURE_SIGNATURE_VERSION, derive: (run, root) => failureSignatures(run, root, { raw: true }) } : undefined, base: claimHead, trunk: acceptedMain.commit, check, timing: frozenCheckTiming(held), agent: me.id, item: String(id), onWait: submissionWait, onStart: submissionStarted, onBrowserFallback: browserAdmissionReporter(ctx.io, ctx.io.relayJson),
    countTrials: false, onMachineryNote: line => ctx.io.say(line),
    proofContext: { ...(companion ? { companion: true } : {}), item: id, frozenDigest: held.item_frozen_digest ?? null, seat: me.id, admission, quarantines },
    onFailure: flakeObserver(ctx, { kind: 'submit', main: acceptedMain.commit, commit: companion?.commit ?? commit, privateCheck: Boolean(companion), config: submitConfig }, { ordered, withBoard, resourceAgent, checkAtCommit }) }));
  /** The runner selection stage's analysis, settled once for the test stage that needs its plan. */
  let settleSelection;
  const selectionResult = remoteMode ? new Promise((resolve, reject) => { settleSelection = { resolve, reject }; }) : null;
  selectionResult?.catch(() => {});
  /** Judge the test result, including exact-main comparison, while other independent stages run. */
  const judgeTests = async (signal) => {
  // In a handoff worker the runner already planned the selection and browser admission; the Mac never plans it again (#3006).
  let gate = await gateWithRunnerPlan(remoteMode, selectionResult, { main: acceptedMain.commit, source: companion?.commit ?? commit, crossRunTests: crossRun.tests },
    runnerPlan => runGate(frozenCheck(held), runnerPlan));
  if (signal.aborted) throw signal.reason;
  const submissionReceiptIds = [...(gate.proofReceiptIds ?? [])];
  for (const proofReceiptId of gate.proofReceiptIds ?? []) {
    await recordNativeProof(ctx, held, { proofReceiptId }, { ordered, withBoard, resourceAgent, proofRunReceipt, exitFailures: true });
  }
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
      comparison = await compareMainFailures(root, criterionRed.profile, gateWaitReporter(ctx.io), criterionRed.output, { commit: mainFailureBase, detailed: true, fresh: acceptedMain.config.submit?.autoFileMainReds === true, onMeasuredReceipt, runnerAdmission,
        recordedRuns: withBoard(ctx, board => gateRuns(board)),
        execution: { executor: criterionRed.executionRunner ? { kind: 'ssh', host: criterionRed.executionRunner } : { kind: 'local' }, environment: criterionRed.environment } });
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
      const mainRed = mainRedCheckCases(root, criterionCases, mainRedItems(), id, mainFailureBase, retakenBaselines);
      if (mainRed.owned.length && !mainRed.rest.length) {
        criterionMatched = { main: mainFailureBase, failures: criterionCases };
        criterionMainRed = mainRed.owned;
        criterionProblem = '';
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
    ? `${gate.deferFullFallback ? invariants : `affected tests: ${files}; `}full suite deferred to the landing gate`
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
      comparison = await compareMainFailures(root, gate.profile, gateWaitReporter(ctx.io), gate.output, { commit: mainFailureBase, detailed: true, fresh: acceptedMain.config.submit?.autoFileMainReds === true, onMeasuredReceipt, runnerAdmission,
        recordedRuns: withBoard(ctx, board => gateRuns(board)),
        execution: { executor: gate.executionRunner ? { kind: 'ssh', host: gate.executionRunner } : { kind: 'local' }, environment: gate.environment } });
      rememberComparison(comparison);
      proofNotices = mainFailureNotices(root, failures, comparison,
        { items: withBoard(ctx, board => store.listItems(board, { all: true })), exclude: id });
      const matched = matchingMainFailures(failures, comparison, mainFailureBase);
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
  if (failures && mainFailureBase && !proofMatched && !companion) {
    try {
      const mainRed = mainRedCheckCases(root, failures, mainRedItems(), id, mainFailureBase, retakenBaselines);
      if (mainRed.owned.length && !mainRed.rest.length) {
        proofMatched = { main: mainFailureBase, failures };
        proofMainRed = mainRed.owned;
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
  return { gate, submissionReceiptIds, mainComparisonReceiptIds, criterionMatched, proofMatched, criterionUnowned, proofUnowned, knownMainFailures, unowned, unownedMain, waived, displayedReport, summary, mainFailures, criterionNames, criterionMainRed, proofMainRed, ambiguous, mechanicalFlag };
  };
  ctx.submitAttempt.stage = 'runner';
  // Independent stages start together; a red refuses immediately while already-started runner jobs finish.
  // Test red is decided only after the exact-main comparison, preserving known-main acceptance.
  const stages = await runGateStages([
    { name: 'preflight', run: async () => {
      if (remoteMode) return runRemotePart('preflight');
      return cachedSubmitSourceStep(root, { kind: 'submit-placement', base: trunk.commit, source: companion?.commit ?? commit,
        code: [fileURLToPath(new URL('../../../../../packages/items/src/core/submit-preflight.js', import.meta.url))] },
      () => requirePlannedSource(root, trunk.commit, companion?.commit ?? commit, { deferUnplaced: true }));
    } },
    ...(remoteMode ? [{ name: 'selection', run: () => runRemotePart('selection').then(analysis => { settleSelection.resolve(analysis); return analysis; },
      error => { settleSelection.reject(error); throw error; }) }] : []),
    { name: 'cells', run: async () => {
      const cellsStart = performance.now();
      try { const result = await (remoteMode ? (await runRemotePart('cells')).cells : runnerAdmission.runnerOnly || effectiveRunners(loadMachineSettings()).length > 0
        ? await withGateSlot(root, async lease => {
          try { return await remoteSubmitCells(root, acceptedMain.commit, companion?.commit ?? commit, held, lease, readCutItems, ctx.submitHandoffOutput, { collectMachinery: true }); }
          finally {
            const admitted = Date.parse(lease.executionAdmission?.admittedAt ?? '');
            if (Number.isFinite(admitted)) ctx.io.say(`submit runner admitted: ${lease.executionAdmission.admittedAt} (approximately ${((admitted - preflightWallStart) / 1000).toFixed(2)}s from controller start; runner clock)`);
          }
        },
          { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, itemCheck: true,
            agent: me.id, item: String(id), kind: 'cells', ...runnerAdmission, remote: true, runnerOnly: true,
            onWait: queuedItemLease(ctx, held, me.id, 'build') })
        : await requireSubmitCells(root, acceptedMain.commit, companion?.commit ?? commit, held, { collectMachinery: true, withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache, cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS),
        readCutItems,
        onInventory: mode => ctx.io.say(`submit cells inventory: ${mode}`),
        onAllCells: file => ctx.io.say(`submit cells: checking all cells because shared policy or root-tool file changed: ${file}`) }));
        for (const diagnostic of result.machinery ?? []) machineryRefusal(root, diagnostic, line => ctx.io.say(line));
        return result; }
      finally { reportSubmitStage(ctx, 'cells', cellsStart); }
    } },
    { name: 'doctrine', run: async () => {
      // Doctrine counts only fall: accepted main's rules, at this exact commit (D1). No rule, no change.
      const doctrineStart = performance.now();
      try { return await runMachineryGuard(root, () => (hasSubmitRules(root, acceptedMain.commit, acceptedMain.config.practice)
        ? submitRulesNarrowable(root, acceptedMain.commit, acceptedMain.config.practice)
          ? cachedDoctrineHold(root, { mainCommit: acceptedMain.commit, commit: companion?.commit ?? commit, practice: acceptedMain.config.practice, timeoutMs: acceptedMain.config.check?.timeoutMs, fast: true }, () => holdDoctrineAsync(root, { mainCommit: acceptedMain.commit, commit: companion?.commit ?? commit, practice: acceptedMain.config.practice, timeoutMs: acceptedMain.config.check?.timeoutMs, fast: true }))
          : cachedDoctrineHold(root, { mainCommit: acceptedMain.commit, commit: companion?.commit ?? commit, practice: acceptedMain.config.practice, timeoutMs: acceptedMain.config.check?.timeoutMs }, () => withGateSlot(root, async lease => {
          const remoteDoctrine = gateAdmission.runnerOnly ? doctrineRunnerChecks(root, acceptedMain.commit, lease, ctx.submitHandoffOutput) : null;
          try { return await holdDoctrineAsync(root, { mainCommit: acceptedMain.commit, commit: companion?.commit ?? commit,
            practice: acceptedMain.config.practice, timeoutMs: acceptedMain.config.check?.timeoutMs, ...(remoteDoctrine ? { runCheck: remoteDoctrine.runCheck } : {}) }); }
          finally { remoteDoctrine?.finish(); }
        },
          { executionServices, itemCheck: true, agent: me.id, item: String(id), kind: 'doctrine', ...gateAdmission, onWait: queuedItemLease(ctx, held, me.id, 'build'), onReceipt: (receipt) => ctx.io.say(`doctrine hold ${gateReceiptLine(receipt)}`) }))
        : []), { kind: 'doctrine', fallback: [], say: line => ctx.io.say(line),
          rule: null }); }
      finally { reportSubmitStage(ctx, 'doctrine', doctrineStart); }
    } },
    { name: 'static', run: async () => {
      try {
        if (remoteMode) return await runRemotePart('static');
        const changedStaticStart = performance.now();
        try {
          if (/\bbin\/static-style-checks\.js\b/u.test(acceptedMain.config.staticChecks ?? '')) {
            await withItemPatchSubmit(root, companion, async gateRoot => {
              const checker = fileURLToPath(new URL('../../../../../bin/static-style-checks.js', import.meta.url));
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
          executionServices, artifactDirectory: ctx.submitHandoffOutput })); }
        finally { reportSubmitStage(ctx, 'static', staticStart); }
      } catch (error) {
        if (error && typeof error === 'object') error.submitFailureStage = 'fast';
        throw error;
      }
    } },
    { name: 'tests', run: judgeTests },
  ]);
  const cells = stages.cells;
  // Reused cells checks have no runner slot; use their own check-receipt formatter.
  if (cells.reused) ctx.io.say(cellsReceiptLine(cells.receipt));
  if (cells.reused && cells.allCellsReason) ctx.io.say(`submit cells: checking all cells because shared policy or root-tool file changed: ${cells.allCellsReason}`);
  for (const line of [...(cells.existingCuts ?? []).map(edge => `cell cuts backlog: ${edge}`), ...cells.warnings ?? []]) ctx.io.say(line);
  const doctrine = stages.doctrine;
  for (const rule of doctrine) ctx.io.say(`doctrine: ${ruleLine(rule)}`);
  let { gate, submissionReceiptIds, mainComparisonReceiptIds, criterionMatched, proofMatched, criterionUnowned, proofUnowned, knownMainFailures, unowned, unownedMain, waived, displayedReport, summary, mainFailures, criterionNames, criterionMainRed, proofMainRed, ambiguous, mechanicalFlag } = stages.tests;
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
        ...(size ? { submissionSize: size } : {}), inspectClauses },
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
  const waivedLines = waived ? waived.map(waiverLine) : [];
  const autoMainReds = unowned.length && acceptedMain.config.submit?.autoFileMainReds === true
    ? { main: unownedMain, candidateReceiptIds: [...new Set(submissionReceiptIds)], mainReceiptIds: [...new Set(mainComparisonReceiptIds.values())] } : null;
  await withBoard(ctx, async (board) => {
    refuseUnverifiedStack(root, board, store.getItem(board, id), submitted, currentTrunk);
    // The waived run is written to the item's thread before the submission, so no waived proof reads as green.
    if (waived) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `submission proof at ${commit.slice(0, 12)} was red and is recorded as waived, not green; every failure is covered by a live person waiver:\n${waivedLines.join('\n')}` }]);
    if (criterionNames.length) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `frozen check red at ${commit.slice(0, 12)} only in cases that fail identically on main at ${criterionMatched.main}: ${criterionNames.map(row => `${row.file} (${row.name}), open repair #${row.item}`).join('; ')}. Reviewers: these known main reds are listed, not blocking; any case green on main would have refused.` }]);
    if (criterionMainRed.length) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `frozen check red at ${commit.slice(0, 12)} only in cases that open Main red repairs' own checks fail on main at ${criterionMatched.main}: ${criterionMainRed.map(row => `${row.file} (${row.name}), repair #${row.item}`).join('; ')}. Reviewers: these known main reds are listed, not blocking.` }]);
    if (proofMainRed.length) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `submission proof red at ${commit.slice(0, 12)} only in cases that open Main red repairs' own checks fail on main at ${proofMatched.main}: ${[...new Map(proofMainRed.map(row => [`${row.file}\0${row.name}`, row])).values()].map(row => `${row.file} (${row.name}), repair #${row.item}`).join('; ')}. No new failure is accepted.` }]);
    if (criterionUnowned.length && !autoMainReds) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `unowned known main red: the frozen check fails identically on main at ${criterionMatched.main} in ${criterionUnowned.map(red => `${red.file} (${red.names.join('; ')})`).join('; ')}, and no open Main red item names the file; a decision was shouted to the coordinator.` }]);
    if (proofUnowned.length && !autoMainReds) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `unowned known main red: the submission proof at ${commit.slice(0, 12)} fails identically on main at ${proofMatched.main} in ${proofUnowned.map(red => `${red.file} (${red.names.join('; ')})`).join('; ')}, and no open Main red item names the file; a decision was shouted to the coordinator. The item check passed; no new failure is accepted.` }]);
    if (knownMainFailures) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `submission proof at ${commit.slice(0, 12)} remains red; known main failures at ${knownMainFailures.main}: ${knownMainFailures.failures.map(row => `${row.file} (${row.name}), open repair #${row.item}`).join('; ')}. The item check passed; no new or unaccounted failure is accepted.` }]);
    const quarantineProofIds = [];
    for (const receiptId of submissionReceiptIds) {
      const receipt = boundProofReceipt(board, { receiptId });
      sealQuarantineVerdict(board, receipt);
      if (Object.hasOwn(receipt, 'blockingVerdict')) quarantineProofIds.push(receiptId);
    }
    requireKernelApproval(board, { root, base: currentTrunk.commit, commit: companion?.commit ?? submitted, item: id });
    const submittedMove = await ordered(ctx, board, 'submit', [id, { agentId: me.id, commit: submitted, tree: headTree(root) ?? '', files: filesSince(root, id, claimHead, commit), policyCommit: acceptedMain.commit, ...(infraRecord ? { infra: infraRecord } : {}),
      ...(inspectClauses ? { inspectClauses: true } : {}),
      gateGreen: gate.isGreen && !waived && !criterionMatched,
      ...(autoMainReds ? { autoMainReds } : {}),
      ...(quarantineProofIds.length ? { quarantineProofIds } : {}),
      ...(size ? { submissionSize: size } : {}),
      ...(companion ? { companion } : {}),
      submissionProof: { version: 1, files: gate.files, full: gate.full, deferred: gate.deferred, reason: boundedProofReason(gate.reason), ...(gate.deferredFiles ? { deferredFiles: gate.deferredFiles } : {}), ...(knownMainFailures ? { knownMainFailures } : {}) },
      ...((gate.deferred || mechanicalFlag) ? { note: [
        ...(gate.deferred ? [gate.deferredFiles ? deferredSelectionNote(gate.deferredFiles) : 'full suite deferred to the landing gate'] : []),
        ...(mechanicalFlag ? [mechanicalFlag] : []),
      ].map(part => part.replace(/[\r\n\u2028\u2029]/gu, ' ')).join('; ') } : {}) }]);
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
  if (gate.isGreen && !waived && !criterionMatched) {
    try { if (submissionReceiptIds.length) for (const line of countTrialGate(root, { id: JSON.stringify([...submissionReceiptIds].sort()) })) ctx.io.say(line); }
    catch { ctx.io.err('could not record this gate in the refusal-trial ledger'); }
    try { await (await import('./verify.js')).startAutomaticComparison(ctx, id); }
    catch (error) { ctx.io.err(`comparison could not start for #${id}: ${error.message}`); }
  }
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
  return reportSubmission(ctx, id, submitted, { mainFailures, green: gate.isGreen && !criterionMatched, report, files: gate.files, full: gate.full, deferred: gate.deferred, deferFullFallback: gate.deferFullFallback, ...(gate.deferredFiles ? { deferredFiles: gate.deferredFiles } : {}), reason: gate.reason, check: { ...gate.check, profile: summaryProfile(gate.check.profile) },
    ...summary, log: gate.log, profile: summaryProfile(gate.profile), profilePath: gate.profilePath, proofLog: gate.proofLog, proofProfilePath: gate.proofProfilePath,
    ...(gate.testTiers ? { testTiers: gate.testTiers, phasePlan: gate.phasePlan, proofReceiptIds: gate.proofReceiptIds } : {}),
    ...(companion ? { companion } : {}),
    ...(knownMainFailures ? { knownMainFailures } : {}),
    ...(knownMainFailures ? { knownMainReworks: knownMainFailures.failures.map(({ file, name, item }) => ({ file, name, item })) } : {}),
    ...(ambiguous.length ? { knownMainAmbiguous: ambiguous } : {}),
    ...(unowned.length && !autoMainReds ? { knownMainUnowned: unowned.flatMap(red => red.names.map(name => ({ file: red.file, name }))) } : {}),
    ...(waived ? { waived: waived.map(({ file, name, waiver }) => ({ file, name, waiver: waiver.id, reason: waiver.reason, until: waiver.until })) } : {}) }, doctrine);
}

/** Run `pullboard submit` and return its exit code. */
export async function run(io, { first, values }) {
  const submissionResult = {};
  const ctx = { ...context(io), submissionResult };
  const id = idArg(first);
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
  try { code = await submitHere(ctx, id, values.infra); }
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
  return waitForSubmitGate(ctx, id, submissionResult.value, submissionResult.job,
    { withBoardRead: waitBoardRead, submitHandoff, getItem: store.getItem, ownershipWait: store.ownershipWait, ownershipWaitForJob: store.ownershipWaitForJob });
}
import { SUBMISSION_SIZE_METHOD } from '../../../../../packages/state/src/core/submission-size.js';
