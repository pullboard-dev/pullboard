import { privateCheckEnvelope } from '../runner-private-mode.js';
import { trunkRef } from '../trusted-policy-read.js';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gateRunnerAdmission } from '../settings.js';
import { frozenCheckTiming } from '../check-timing.js';
import { quarantineWaivers } from '../quarantine.js';
import { withBoardRead as waitBoardRead } from '../board-read.js';
import { retrySync } from '../cli-sync.js';
import { checkAtCommit } from '../runner-private-check.js';
import { runnerExecutionServices } from '../runners.js';
import { landingExecutionServices } from '../landing-shards.js';
import { submitGateConfig } from '../gate-submit.js';
import { createHash } from 'node:crypto';
import { prepareItemPatchSubmit } from '../item-patch-submit.js';
import { withItemPatchSubmit } from '../item-patch-submit.js';
import { boundedProofReason } from '../../packages/state/src/core/submission-proof.js';
import { completeMoveHandoff } from '../post-move-handoff.js';
import {
  barReadySetting,
  barReadyProblem,
} from '../bar-readiness.js';
import { barCheckWarning } from '../bar-check.js';
import { requireSubmitComposition } from '../submit-composition.js';
import { composeAfterProof } from '../submit-composition.js';
import { trunkMoveFact } from '../submit-composition.js';
import { selectAffectedTests } from '../affected-tests.js';
import { explicitCheckFiles } from '../browser-admission.js';
/** The pullboard submit command, in its own module so an item adding another command never edits these lines. */
import * as store from '../board.js';
import {
  refuseProvesNothing,
} from '../check-accept.js';
import {
  COORDINATOR,
} from '../config.js';
import {
  hasSubmitRules,
  holdDoctrine,
  ruleLine,
} from '../doctrine-checks.js';
import * as gateReceipt from '../gate-receipt.js';
import { recordNativeProof } from '../proof-cli.js';
import { proofRunReceipt } from '../proof-receipts.js';
import {
  gateWaitReporter,
} from '../gate-wait.js';
import {
  deferredSelectionNote,
  runSubmitGate,
  submitGateReport,
  withGateSlot,
} from '../gate.js';
import {
  contains,
  git,
  gitPath,
  headCommit,
  headTree,
  isClean,
  untracked,
} from '../git.js';
import {
  machineNameProblems,
} from '../hooks.js';
import * as infraNotes from '../infra-note.js';
import {
  accountedFailures,
  waivedFailures,
  waiverLine,
} from '../land.js';
import {
  compareMainFailures,
  mainRedMessage,
} from '../main-red.js';
import * as nativeFlakes from '../native-flake-cli.js';
import {
  Refused,
} from '../refused.js';
import {
  relayRecovered,
} from '../relay.js';
import * as seatCheckout from '../seat-checkout.js';
import {
  submitPreflight,
  requirePlannedSource,
} from '../submit-preflight.js';
import {
  refuseUnreviewable,
} from '../review-reachability.js';
import {
  changedLines,
  oversizeNote,
} from '../submit-size.js';
import {
  dependencySnapshots,
  frozenCheck,
  itemPolicy,
  mainPolicy,
  policyAt,
  requireTrunkMerge,
  submissionPaths,
} from '../trusted-policy.js';
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
import { recordedRecovery } from '../recorded-recovery.js';
import { failureSignatures } from '../main-failure-matches.js';
import { matchingMainFailures } from '../main-failure-matches.js';
import { linkKnownMainReworks } from '../known-main-reworks.js';
import { submitReferenceReminders } from '../reference-lines.js';
import { waitForSubmissionVerdict } from '../submit-wait.js';

/** Bind both doctrine check sources to the actual leased worker, retaining authenticated per-rule observations. */
function doctrineRunnerChecks(root, mainCommit, lease) {
  if (!lease.runner || typeof lease.executionServices?.runners?.runOnRunner !== 'function') throw new Refused('RUNNER_SOURCE', 'runner-only doctrine needs its actual registered runner lease; restore runner admission and retry');
  const parent = gitPath(root, 'pullboard-doctrine-output');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const observations = [];
  let attempts = 0;
  lease.tracker?.mark('runAt');
  return {
    /** Execute exactly one approved rule at its candidate or merge-base source; exit 1 is a counted result. */
    runCheck(commit, command, timeoutMs) {
      attempts++;
      const started = performance.now();
      const directory = mkdtempSync(join(parent, 'rule-'));
      const shell = `(\n${command}\n) 2>&1`;
      const checkedSource = { commit, tree: git(root, ['rev-parse', `${commit}^{tree}`]).trim() };
      const policy = privateCheckEnvelope({ kind: 'private-check', version: 1, install: '', check: shell, timeoutMs,
        policyCommit: mainCommit, trunk: { ref: trunkRef(root), commit: mainCommit } });
      let result;
      try {
        result = lease.executionServices.runners.runOnRunner(root, shell, { runner: lease.runner, source: lease.source,
          runnerWaitDeadline: lease.runnerWaitDeadline, browser: lease.browser, checkedSource, privateCheck: policy,
          metadata: { ...lease.runMetadata, testStage: 'doctrine' }, rawOutputPath: join(directory, 'raw.log') });
      } catch (error) {
        writeFileSync(join(directory, 'failure.json'), JSON.stringify({ version: 1, policySha256: policy.sha256, checkedSource,
          code: error?.code ?? error?.name ?? 'unknown', rawOutputPath: join(directory, 'raw.log') }) + '\n', { mode: 0o600 });
        throw error;
      }
      const receipt = result.privateCheck?.receipt;
      const phase = receipt?.phases?.check;
      const observed = { version: 1, policyCommit: mainCommit, commandSha256: createHash('sha256').update(command).digest('hex'),
        privateCheckSha256: policy.sha256, checkedSource, executionSource: result.executionSource ?? null,
        runner: result.executionRunner ?? null, environment: result.environment ?? null,
        executionAdmission: result.executionAdmission ?? null, executionPhases: result.executionPhases ?? null,
        privateCheck: receipt ?? null, rawOutputPath: result.rawOutputPath ?? null, rawOutputSha256: result.rawOutputSha256 ?? null };
      writeFileSync(join(directory, 'observation.json'), JSON.stringify(observed) + '\n', { mode: 0o600 });
      observations.push(observed);
      if (result.executionRunner !== lease.runner.host || result.executionSource?.commit !== checkedSource.commit
        || result.executionSource?.tree !== checkedSource.tree || receipt?.requestSha256 !== policy.sha256) {
        throw new Refused('RUNNER_RESULT_INVALID', 'doctrine runner result does not bind its admitted source and approved policy; inspect the retained observation before retrying');
      }
      const seconds = Math.round((performance.now() - started) / 1000);
      const broken = !receipt.sourceUnchanged ? 'changed its private source' : receipt.problem ? receipt.problem.message
        : !phase ? 'has no complete check phase' : phase.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s`
          : phase.signal ? `was killed by ${phase.signal}` : ![0, 1].includes(phase.code) ? `exited ${phase.code}` : '';
      if (broken) return { problems: [], broken, seconds };
      if (phase.offset !== 0 || !Number.isSafeInteger(phase.length) || phase.length < 0 || phase.length > 64 * 1024 * 1024
        || statSync(result.rawOutputPath).size !== phase.length) return { problems: [], broken: 'exceeded the complete bounded check output', seconds };
      const bytes = readFileSync(result.rawOutputPath);
      if (bytes.length !== phase.length || createHash('sha256').update(bytes).digest('hex') !== phase.sha256) {
        throw new Refused('RUNNER_RESULT_INVALID', 'doctrine check bytes do not match the authenticated phase; inspect the retained observation before retrying');
      }
      return { problems: bytes.toString('utf8').split(/\r?\n/u).map(line => line.trimEnd()).filter(line => line.trim()), broken: '', seconds };
    },
    /** A multi-check hold has no measured aggregate runner interval; individual actual phases stay in its observations. */
    finish() {
      lease.tracker?.mark('ranAt');
      const single = attempts === 1 && observations.length === 1 ? observations[0] : null;
      lease.environment = observations.length && attempts === observations.length && observations.every(row => JSON.stringify(row.environment) === JSON.stringify(observations[0].environment)) ? observations[0].environment : null;
      lease.executionAdmission = single?.executionAdmission ?? null;
      lease.executionPhases = single?.executionPhases ?? null;
    },
  };
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
export async function submitHere(ctx, id, infra) {
  const { root } = ctx.info;
  const recovered = relayRecovered(root);
  if (recovered?.operation === 'submit' && recovered.args[0] === id) {
    const preflight = withBoard(ctx, (board) => {
      const me = whoAmI(ctx, board);
      if (recovered.args[1]?.agentId !== me.id) return null;
      if (recordedRecovery(board, recovered)) return { me, recorded: true };
      const item = store.getItem(board, id);
      const trunk = requireTrunkMerge(root, recovered.args[1].commit);
      requirePlannedSource(root, trunk.commit, recovered.args[1].commit);
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
  const runnerAdmission = gateRunnerAdmission();
  const held = await withBoard(ctx, async (board) => {
    const me = whoAmI(ctx, board);
    const item = store.getItem(board, id);
    seatCheckout.refuseHeldElsewhere(ctx.info, store.listAgents(board), item, 'submit');
    if (item.item_status !== 'claimed' || item.item_owner !== me.id) throw new Refused('NOT_YOURS', 'claim this item before submitting it');
    const readiness = barReadyProblem(board, item);
    if (readiness) throw readiness;
    const correction = store.pendingRefreezeProblem(board, id);
    if (correction) {
      await claimOrdered(ctx, board, [id, { agentId: me.id, lane: me.lane, leaseMs: ctx.config.leaseMs,
        freeze: claimFreezer(ctx, board), head: headCommit(root) }]);
      return store.getItem(board, id);
    }
    return item;
  });
  const barWarning = await withBoard(ctx, async board => {
    const warning = barCheckWarning(board, held);
    if (!warning) return null;
    await ordered(ctx, board, 'appendFact', [id, { agentId: held.item_owner, kind: 'note', text: `bar.check warning: ${warning}` }]);
    return warning;
  });
  if (barWarning) {
    ctx.io.say(`bar.check warning: ${barWarning}`);
  }
  const policy = itemPolicy(root, held);
  const acceptedMain = mainPolicy(root);
  const requireComposition = withBoard(ctx, board => barReadySetting(board).enabled);
  ctx = { ...ctx, config: policy.config };
  withBoard(ctx, (board) => refuseProvesNothing(() => acceptedMain.config, board, store.getItem(board, id)));
  const dependencies = withBoard(ctx, board => dependencySnapshots(board.db, held));
  submissionPaths(root, held, headCommit(root), { mainCommit: acceptedMain.commit, dependencies });
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
        if (!(error instanceof Refused) || error.code === 'A5_GRAMMAR_VERSION') throw error;
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
  if (!isClean(root)) throw new Refused('DIRTY', 'commit your changes first; the gate must check what you submit');
  const stray = untracked(root);
  if (stray.length) throw new Refused('UNTRACKED', `commit or ignore ${stray.length} untracked file(s), e.g. ${stray[0]}`);
  const commit = headCommit(root);
  if (!commit) throw new Refused('NO_COMMIT', 'nothing committed yet');
  // A trunk checkout can have advanced since the claim; comparing it with itself would bless its own new red test.
  const mainFailureBase = acceptedMain.commit === commit ? claimHead : acceptedMain.commit;
  withBoard(ctx, (board) => submitPreflight(board, id, { agentId: me.id, commit, tree: headTree(root) ?? '' }, { atomic: store.atomic, submit: store.submit }, { refuse: (observed, item) => refuseUnreviewable(observed, item, { policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family }) }));
  const trunk = requireTrunkMerge(root, commit);
  requirePlannedSource(root, trunk.commit, commit);
  const companion = await withBoard(ctx, async board => {
    if (store.itemPatches(board, id).some(patch => patch.commit !== commit || patch.source?.commit !== commit)) {
      await ordered(ctx, board, 'followItemPatches', [id, { agentId: me.id, commit }]);
    }
    return prepareItemPatchSubmit(root, board, held, commit);
  });
  // The candidate must contain the main this proof pins; a main that moves on before or during the proof is judged after it.
  if (requireComposition) requireSubmitComposition(root, commit, { commit: acceptedMain.commit }, acceptedMain.commit);
  withBoard(ctx, (board) => refuseUnverifiedStack(root, board, held, commit, trunk));
  machineNameProblems(root, `${acceptedMain.commit}..${commit}`, { refuse: acceptedMain.config.commits.noHostName === true, say: (line) => ctx.io.say(line) });
  const infraRecord = infraNotes.infraNote({ root, claimHead, files: filesSince(root, id, claimHead, commit), gates: [ctx.config.gate, acceptedMain.config.gate], infra, requireInfraNote: acceptedMain.config.submit.requireInfraNote });
  // Doctrine counts only fall: accepted main's rules, at this exact commit (D1). No rule, no change.
  const doctrine = hasSubmitRules(root, acceptedMain.commit, acceptedMain.config.practice)
    ? await withGateSlot(root, lease => {
      const remote = runnerAdmission.runnerOnly ? doctrineRunnerChecks(root, acceptedMain.commit, lease) : null;
      try { return holdDoctrine(root, { mainCommit: acceptedMain.commit, commit: companion?.commit ?? commit,
        practice: acceptedMain.config.practice, timeoutMs: acceptedMain.config.check?.timeoutMs, ...(remote ? { runCheck: remote.runCheck } : {}) }); }
      finally { remote?.finish(); }
    },
      { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, itemCheck: true, agent: me.id, item: String(id), kind: 'doctrine', ...runnerAdmission, onWait: queuedItemLease(ctx, held, me.id, 'build'), onReceipt: (receipt) => ctx.io.say(`doctrine hold ${gateReceipt.receiptLine(receipt)}`) })
    : [];
  for (const rule of doctrine) ctx.io.say(`doctrine: ${ruleLine(rule)}`);
  // Every submit proves its frozen check and reachable tests anew on this exact commit (V4,V16).
  // Empty frozen gates adopt accepted main setup; only a full fallback may stamp its tree.
  const submitConfig = submitGateConfig(companion ? policyAt(root, companion.commit).config : ctx.config, acceptedMain.config);
  const admission = { commit: companion?.commit ?? commit, tree: companion?.tree ?? headTree(root) };
  const gate = await withItemPatchSubmit(root, companion, gateRoot => runSubmitGate(gateRoot, submitConfig, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, outputRoot: root, runnerAdmission, base: claimHead, trunk: acceptedMain.commit, check: frozenCheck(held), timing: frozenCheckTiming(held), agent: me.id, item: String(id), onWait: queuedItemLease(ctx, held, me.id, 'build', admission), onBrowserFallback: browserAdmissionReporter(ctx.io, ctx.io.relayJson),
    proofContext: { ...(companion ? { companion: true } : {}), item: id, frozenDigest: held.item_frozen_digest ?? null, seat: me.id, admission },
    onFailure: nativeFlakes.observer(ctx, { kind: 'submit', main: acceptedMain.commit, config: submitConfig }, { ordered, withBoard, resourceAgent, checkAtCommit }) }));
  for (const proofReceiptId of gate.proofReceiptIds ?? []) {
    await recordNativeProof(ctx, held, { proofReceiptId }, { ordered, withBoard, resourceAgent, proofRunReceipt });
  }
  if (companion) {
    companion.receiptIds = gate.proofReceiptIds.filter(id => typeof id === 'string');
    companion.phases = gate.phasePlan.map(({ role, command }) => ({ role, command: createHash('sha256').update(command).digest('hex') }));
  }
  // Only fully accounted exact-main failures or live person waivers pass a red proof; the item check stays mandatory [B3].
  const waived = !gate.isGreen && gate.check?.green ? withBoard(ctx, (board) => waivedFailures(board, accountedFailures(gate, root), { quarantineWaivers })) : null;
  const onMeasuredReceipt = receiptId => nativeFlakes.recordMainComparison(ctx, receiptId, { ordered, withBoard, resourceAgent });
  let comparison;
  let knownMainFailures;
  const failures = !gate.isGreen && gate.check?.green && !waived ? failureSignatures(gate, root) : null;
  if (failures && mainFailureBase && !companion) {
    try {
      comparison = await compareMainFailures(root, gate.profile, gateWaitReporter(ctx.io), gate.output, { commit: mainFailureBase, detailed: true, onMeasuredReceipt, runnerAdmission });
      const matched = matchingMainFailures(failures, comparison, mainFailureBase);
      knownMainFailures = matched && withBoard(ctx, board => linkKnownMainReworks(matched, store.listItems(board, { all: true }), id));
    } catch { /* Unavailable exact-main proof never authorizes a red submission. */ }
  }
  if (!gate.isGreen && !waived && !knownMainFailures) {
    const accountingNote = gate.check?.green && !failures ? '\nknown-main acceptance unavailable: the proof has no complete named failure diagnostics' : '';
    const message = `the submission proof is red at ${commit.slice(0, 12)}; fix it, commit, submit again. ${submitGateReport(gate)}${accountingNote}`;
    // No submission can follow this verdict. Read-only main comparisons must not retain the seat's write lease.
    CHECKOUT_LEASES.get(ctx.io)?.release();
    CHECKOUT_LEASES.delete(ctx.io);
    comparison ??= { main: null, files: [], unavailable: 'main comparison could not be completed' };
    if (!failures && mainFailureBase && !companion) {
      try { comparison = await compareMainFailures(root, gate.profile, gateWaitReporter(ctx.io), gate.output, { commit: mainFailureBase, onMeasuredReceipt, runnerAdmission }); } catch { /* Keep the original gate refusal if main evidence is unavailable. */ }
    }
    const mainNote = withBoard(ctx, board => mainRedMessage(root, board, gate.profile, comparison));
    throw new Refused('GATE_RED', `${message}${mainNote ? `\n${mainNote}` : ''}`, 'fix the reported test or gate, commit the change, and run pullboard submit <id> again');
  }
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
  if (requireComposition && !companion && currentTrunk.commit !== acceptedMain.commit) {
    const composed = await composeAfterProof(root, { id, proofCommit: commit, proved: acceptedMain.commit, item: held, check: frozenCheck(held),
      readTrunk: () => requireTrunkMerge(root, commit) }, { selectAffectedTests, explicitCheckFiles });
    submitted = composed.commit;
    trunkMove = composed.evidence;
    currentTrunk = requireTrunkMerge(root, submitted);
  }
  const measuredLines = changedLines(root, currentTrunk.commit, submitted);
  const size = measuredLines === null ? undefined : {
    base: currentTrunk.commit, head: submitted, lines: measuredLines, method: SUBMISSION_SIZE_METHOD,
  };
  if (requireComposition) requireSubmitComposition(root, submitted, currentTrunk, trunkMove ? trunkMove.to : acceptedMain.commit);
  const waivedLines = waived ? waived.map(waiverLine) : [];
  await withBoard(ctx, async (board) => {
    refuseUnverifiedStack(root, board, store.getItem(board, id), submitted, currentTrunk);
    // The waived run is written to the item's thread before the submission, so no waived proof reads as green.
    if (waived) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `submission proof at ${commit.slice(0, 12)} was red and is recorded as waived, not green; every failure is covered by a live person waiver:\n${waivedLines.join('\n')}` }]);
    if (knownMainFailures) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `submission proof at ${commit.slice(0, 12)} remains red; known main failures at ${knownMainFailures.main}: ${knownMainFailures.failures.map(row => `${row.file} (${row.name}), open repair #${row.item}`).join('; ')}. The item check passed; no new or unaccounted failure is accepted.` }]);
    const submittedMove = await ordered(ctx, board, 'submit', [id, { agentId: me.id, commit: submitted, tree: headTree(root) ?? '', files: filesSince(root, id, claimHead, commit), policyCommit: acceptedMain.commit, ...(infraRecord ? { infra: infraRecord } : {}),
      gateGreen: gate.isGreen && !waived,
      ...(size ? { submissionSize: size } : {}),
      ...(companion ? { companion } : {}),
      submissionProof: { version: 1, files: gate.files, full: gate.full, deferred: gate.deferred, reason: boundedProofReason(gate.reason), ...(gate.deferredFiles ? { deferredFiles: gate.deferredFiles } : {}), ...(knownMainFailures ? { knownMainFailures } : {}) },
      ...(gate.deferred ? { note: gate.deferredFiles ? deferredSelectionNote(gate.deferredFiles) : 'full suite deferred to the landing gate' } : {}) }]);
    // One fact records the merge and the evidence that the main move touched nothing this proof depends on.
    if (trunkMove) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: trunkMoveFact(trunkMove) }]);
    return submittedMove;
  });
  // A large submit still goes through; the note only suggests a chain of smaller items (#1162).
  const sizeNote = oversizeNote(measuredLines, acceptedMain.config.itemSizeBudget);
  if (sizeNote) ctx.io.say(`note: ${sizeNote}`);
  for (const reminder of submitReferenceReminders(root, held, commit)) ctx.io.err(reminder);
  const report = knownMainFailures
    ? `submission proof red with ${knownMainFailures.failures.length} known main failure(s) at ${knownMainFailures.main}; item check green; no new failures accepted. ${submitGateReport(gate)}`
    : waived
    ? `submission proof waived, not green: ${waived.length} failure(s), each covered by a live person waiver; the whole output is in ${gate.log}\n${waivedLines.join('\n')}`
    : submitGateReport(gate);
  if (trunkMove) ctx.io.say(trunkMoveFact(trunkMove));
  return reportSubmission(ctx, id, submitted, { green: gate.isGreen, report, files: gate.files, full: gate.full, deferred: gate.deferred, deferFullFallback: gate.deferFullFallback, ...(gate.deferredFiles ? { deferredFiles: gate.deferredFiles } : {}), reason: gate.reason, check: gate.check,
    log: gate.log, profile: gate.profile, profilePath: gate.profilePath, proofLog: gate.proofLog, proofProfilePath: gate.proofProfilePath,
    ...(companion ? { companion } : {}),
    ...(knownMainFailures ? { knownMainFailures } : {}),
    ...(knownMainFailures ? { knownMainReworks: knownMainFailures.failures.map(({ file, name, item }) => ({ file, name, item })) } : {}),
    ...(waived ? { waived: waived.map(({ file, name, waiver }) => ({ file, name, waiver: waiver.id, reason: waiver.reason, until: waiver.until })) } : {}) }, doctrine);
}

/** Run `pullboard submit` and return its exit code. */
export async function run(io, { first, values }) {
  const submissionResult = {};
  const ctx = { ...context(io), submissionResult };
  const id = idArg(first);
  /** Dispatch before optional verdict waiting, retaining this exact submission document. */
  ctx.afterSubmission = submission => completeMoveHandoff(ctx, id, values, submission, { nextOnce, withBoardRead, listItems: store.listItems });
  const previous = io.onOrderedMove;
  io.onOrderedMove = receipt => {
    previous?.(receipt);
    if (receipt.operation !== 'submit') return;
    const event = receipt.events.find(event => event.event_kind === 'submit' && event.item_id === id);
    if (event) submissionResult.event = { ...event };
  };
  let code;
  try { code = await submitHere(ctx, id, values.infra); }
  finally { io.onOrderedMove = previous; }
  if (code !== 0 || !values.wait) return code;
  return waitForSubmissionVerdict(ctx, id, submissionResult.value, submissionResult.event, { withBoardRead: waitBoardRead, retrySync, events: store.events, verdictsFor: store.verdictsFor, getItem: store.getItem });
}
import { SUBMISSION_SIZE_METHOD } from '../../packages/state/src/core/submission-size.js';
