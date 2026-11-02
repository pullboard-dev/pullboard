import { testTierReport } from '../../packages/gate/index.js';
import { recordedToolCommits } from '../../packages/git/index.js';
import { toolRegenerationSource } from '../../packages/git/index.js';
import { receiptLine as cellsReceiptLine } from '../../packages/git/index.js';
import { regenerateToolChange } from '../../packages/sandbox/index.js';
import { cachedDoctrineHold } from '../../packages/doctrine/index.js';
import { runnerPhaseFields } from '../timing.js';
import {
  pendingSubmitHandoff,
  submitHandoff,
} from '../submit-handoff-read.js';
import {
  isSubmitHandoffWorker,
  copySubmitHandoffOrigin,
  submitHandoffPolicy,
  requireSubmitHandoffExecution,
} from '../submit-handoff-origin.js';
import { blockingFailures } from '../../packages/verify/index.js';
import { boundProofReceipt } from '../../packages/store/index.js';
import { sealQuarantineVerdict } from '../quarantine.js';
import { withImportParseCache } from '../module-import-cache.js';
import { foreignNodeOptions } from '../test-isolation.js';
import { importsIn } from '../module-imports.js';
import { commonJsIn } from '../module-imports.js';
import { requireSubmitCells } from '../../bin/cells-submit-checks.js';
import { landedCutItemRows } from '../../bin/cells-submit-checks.js';
import { privateCheckEnvelope } from '../runner-private-mode.js';
import { trunkRef } from '../../packages/sandbox/index.js';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gateRunnerAdmission } from '../../packages/config/index.js';
import { frozenCheckTiming } from '../check-timing.js';
import {
  retainTestOutput,
  renderTestSummary,
  summaryProfile,
  withTestOutput,
} from '../test-output-summary.js';
import { quarantineWaivers } from '../quarantine.js';
import { quarantineVerdictSnapshot } from '../quarantine.js';
import { withBoardRead as waitBoardRead } from '../cli-context.js';
import { retrySync } from '../cli-sync.js';
import { checkAtCommit } from '../runner-private-check.js';
import { runnerExecutionServices } from '../runners.js';
import { landingExecutionServices } from '../../packages/landing/index.js';
import { submitGateConfig } from '../gate-submit.js';
import { createHash } from 'node:crypto';
import { prepareItemPatchSubmit } from '../item-patch-submit.js';
import { withItemPatchSubmit } from '../item-patch-submit.js';
import { boundedProofReason } from '../../packages/state/src/core/submission-proof.js';
import { completeMoveHandoff } from '../../packages/verify/index.js';
import {
  barReadySetting,
  barReadyProblem,
} from '../../packages/verify/index.js';
import { barCheckWarning } from '../../packages/verify/index.js';
import { requireSubmitComposition } from '../../packages/items/index.js';
import { composeAfterProof } from '../../packages/items/index.js';
import { trunkMoveFact } from '../../packages/items/index.js';
import { judgeTrunkMove } from '../../packages/verify/index.js';
import { selectAffectedTests } from '../affected-tests.js';
import { explicitCheckFiles } from '../browser-admission.js';
/** The pullboard submit command, in its own module so an item adding another command never edits these lines. */
import * as store from '../board.js';
import { agentSessionDigest } from '../../packages/person/index.js';
import {
  refuseProvesNothing,
} from '../../packages/verify/index.js';
import {
  COORDINATOR,
} from '../../packages/config/index.js';
import {
  laneNames,
} from '../lanes.js';
import {
  hasSubmitRules,
  holdDoctrineAsync,
  ruleLine,
} from '../../packages/doctrine/index.js';
import * as gateReceipt from '../gate-receipt.js';
import { recordNativeProof } from '../../packages/verify/index.js';
import { proofRunReceipt } from '../../packages/store/index.js';
import {
  gateWaitReporter,
} from '../gate-wait.js';
import {
  deferredSelectionNote,
  runStaticChecks,
  runSubmitGate,
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
} from '../../packages/commits/index.js';
import * as infraNotes from '../../packages/commits/index.js';
import {
  accountedFailures,
  waivedFailures,
  waiverLine,
} from '../../packages/landing/index.js';
import {
  withMainCheckout,
  compareMainFailures,
  companionMainFailuresUntouched,
  mainRedMessage,
} from '../../packages/landing/index.js';
import * as nativeFlakes from '../native-flake-cli.js';
import {
  Refused,
} from '../../packages/kernel/index.js';
import {
  relayRecovered,
} from '../../packages/link/index.js';
import * as seatCheckout from '../seat-checkout.js';
import {
  submitPreflight,
  requirePlannedSource,
} from '../../packages/items/index.js';
import {
  refuseUnreviewable,
} from '../../packages/verify/index.js';
import {
  changedLines,
  oversizeNote,
} from '../../packages/items/index.js';
import {
  dependencySnapshots,
  frozenCheck,
  itemPolicy,
  mainPolicy,
  policyAt,
  requireTrunkMerge,
  submissionPaths,
} from '../../packages/sandbox/index.js';
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
import { recordedRecovery } from '../../packages/state/index.js';
import { failureSignatures } from '../../packages/landing/index.js';
import { MAIN_FAILURE_SIGNATURE_VERSION } from '../../packages/landing/index.js';
import { matchingMainFailures } from '../../packages/landing/index.js';
import { mainFailureNotices } from '../../packages/landing/index.js';
import { linkKnownMainReworks } from '../../packages/store/index.js';
import { unownedMainReds } from '../../packages/store/index.js';
import { ambiguousMainReds } from '../../packages/store/index.js';
import { submitReferenceReminders } from '../../packages/spec/index.js';
import { waitForSubmitGate } from '../submit-gate-wait.js';

/** Sum sequential worker intervals only when every attempted run has complete measurements. */
export function doctrineExecutionPhases(observations, attempts) {
  const phases = observations.map(row => runnerPhaseFields(row.executionPhases));
  const fields = ['prepareMs', 'capacityWaitMs', 'sourceMs', 'dependenciesMs', 'commandMs', 'cleanupMs', 'totalMs'];
  return attempts && attempts === observations.length && phases.every(Boolean)
    ? runnerPhaseFields({ version: 1, ...Object.fromEntries(fields.map(field => [field, phases.reduce((sum, phase) => sum + phase[field], 0)])) }) : null;
}

/** Bind both doctrine check sources to the actual leased worker, retaining authenticated per-rule observations. */
function doctrineRunnerChecks(root, mainCommit, lease, artifactDirectory) {
  if (!lease.runner || typeof lease.executionServices?.runners?.runOnRunnerAsync !== 'function') throw new Refused('RUNNER_SOURCE', 'runner-only doctrine needs its actual registered runner lease; restore runner admission and retry');
  const parent = artifactDirectory ? join(artifactDirectory, 'doctrine') : gitPath(root, 'pullboard-doctrine-output');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const observations = [];
  let attempts = 0;
  lease.tracker?.mark('runAt');
  return {
    /** Execute exactly one approved rule at its candidate or merge-base source; exit 1 is a counted result. */
    async runCheck(commit, command, timeoutMs) {
      attempts++;
      const started = performance.now();
      const directory = mkdtempSync(join(parent, 'rule-'));
      const shell = `(\n${command}\n) 2>&1`;
      const checkedSource = { commit, tree: git(root, ['rev-parse', `${commit}^{tree}`]).trim() };
      const policy = privateCheckEnvelope({ kind: 'private-check', version: 1, install: '', check: shell, timeoutMs,
        policyCommit: mainCommit, trunk: { ref: trunkRef(root), commit: mainCommit } });
      let result;
      try {
        result = await lease.executionServices.runners.runOnRunnerAsync(root, shell, { runner: lease.runner, source: lease.source,
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
    /** Sum the disjoint worker intervals for sequential rule runs when all were measured. */
    finish() {
      lease.tracker?.mark('ranAt');
      const single = attempts === 1 && observations.length === 1 ? observations[0] : null;
      lease.environment = observations.length && attempts === observations.length && observations.every(row => JSON.stringify(row.environment) === JSON.stringify(observations[0].environment)) ? observations[0].environment : null;
      lease.executionAdmission = single?.executionAdmission ?? null;
      lease.executionPhases = doctrineExecutionPhases(observations, attempts);
    },
  };
}

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
export async function submitHere(ctx, id, infra) {
  const { root } = ctx.info;
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
    if (!isSubmitHandoffWorker(ctx)) seatCheckout.refuseHeldElsewhere(ctx.info, store.listAgents(board), item, 'submit', agentSessionDigest);
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
  ctx.submitAttempt = { agentId: held.item_owner, digest: held.item_frozen_digest };
  ctx.submitAttempt.stage = 'fast';
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
  let acceptedMain = submitHandoffPolicy(ctx) ?? mainPolicy(root);
  // Fail fast, cheapest first: a dirty tree or a change that conflicts with main is refused before any other work, check or test.
  if (!isClean(root)) throw new Refused('DIRTY', 'commit your changes first; the gate must check what you submit');
  const stray = untracked(root);
  if (stray.length) throw new Refused('UNTRACKED', `commit or ignore ${stray.length} untracked file(s), e.g. ${stray[0]}`);
  let commit = headCommit(root);
  if (!commit) throw new Refused('NO_COMMIT', 'nothing committed yet');
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
  ctx = copySubmitHandoffOrigin(ctx, { ...ctx, config: policy.config });
  withBoard(ctx, (board) => refuseProvesNothing(() => acceptedMain.config, board, store.getItem(board, id)));
  const dependencies = withBoard(ctx, board => dependencySnapshots(board.db, held));
  let mechanicalPaths = [];
  submissionPaths(root, held, headCommit(root), { mainCommit: acceptedMain.commit, dependencies,
    onMechanicalPaths: paths => { mechanicalPaths = paths; } });
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
  const pendingHandoff = !isSubmitHandoffWorker(ctx) ? withBoard(ctx, board => pendingSubmitHandoff(board, held)) : null;
  if (pendingHandoff && pendingHandoff.commit !== commit) throw new Refused('SUBMIT_HANDOFF_PENDING', 'the original immutable candidate is still queued; continue your current build and read its result with pullboard show <id>');
  // A trunk checkout can have advanced since the claim; comparing it with itself would bless its own new red test.
  const mainFailureBase = acceptedMain.commit === commit ? claimHead : git(root, ['merge-base', commit, acceptedMain.commit]);
  const preflightLines = changedLines(root, acceptedMain.commit, commit);
  const preflightSize = preflightLines === null ? undefined : { base: acceptedMain.commit, head: commit, lines: preflightLines, method: SUBMISSION_SIZE_METHOD };
  withBoard(ctx, (board) => submitPreflight(board, id, { agentId: me.id, commit, tree: headTree(root) ?? '', submissionSize: preflightSize }, { atomic: store.atomic, submit: store.submit }, { refuse: (observed, item) => refuseUnreviewable(observed, item, { policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family }, store) }));
  const companion = await withBoard(ctx, async board => {
    if (store.itemPatches(board, id).some(patch => patch.commit !== commit || patch.source?.commit !== commit)) {
      await ordered(ctx, board, 'followItemPatches', [id, { agentId: me.id, commit }]);
    }
    return prepareItemPatchSubmit(root, board, held, commit);
  });
  withBoard(ctx, board => requireSubmitHandoffExecution(ctx, board, companion?.commit ?? commit, companion?.tree ?? headTree(root)));

  // The candidate must contain the main this proof pins; a main that moves on before or during the proof is judged after it.
  const compositionStart = performance.now();
  try { if (requireComposition) requireSubmitComposition(root, commit, { commit: acceptedMain.commit }, acceptedMain.commit); }
  finally { reportSubmitStage(ctx, 'composition', compositionStart); }
  withBoard(ctx, (board) => refuseUnverifiedStack(root, board, held, commit, trunk));
  machineNameProblems(root, `${acceptedMain.commit}..${commit}`, { refuse: acceptedMain.config.commits.noHostName === true, say: (line) => ctx.io.say(line) });
  const infraRecord = infraNotes.infraNote({ root, claimHead, commit, files: filesSince(root, id, claimHead, commit), gates: [ctx.config.gate, acceptedMain.config.gate], infra, requireInfraNote: acceptedMain.config.submit.requireInfraNote });
  const regeneratedFrom = toolRegenerationSource(root, commit);
  // Queue all captured sources before cell compilation; the bound worker runs the same checks and refusal path.
  if (pendingHandoff || handoffEnabled) {
    const { enqueueSubmitHandoff } = await import('../submit-handoff.js');
    return enqueueSubmitHandoff(ctx, held, me, { commit, tree: headTree(root), companion, infra, main: acceptedMain.commit });
  }
  requirePlannedSource(root, trunk.commit, companion?.commit ?? commit);
  let cells;
  const cellsStart = performance.now();
  try { cells = await requireSubmitCells(root, acceptedMain.commit, companion?.commit ?? commit, held, { withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache, cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS),
    readCutItems: () => withBoard(ctx, board => landedCutItemRows(board.db)),
    onInventory: mode => ctx.io.say(`submit cells inventory: ${mode}`) }); }
  finally { reportSubmitStage(ctx, 'cells', cellsStart); }
  // Reused cells checks have no runner slot; use their own check-receipt formatter.
  if (cells.reused) ctx.io.say(cellsReceiptLine(cells.receipt));
  for (const edge of cells.existingCuts ?? []) ctx.io.say(`cell cuts backlog: ${edge}`);
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
  // Static and lint checks run once, all at once, before doctrine and before any runner gate (fail fast).
  const staticStart = performance.now();
  try { await withItemPatchSubmit(root, companion, gateRoot => runStaticChecks(gateRoot, submitConfig, { agent: me.id, item: String(id),
    onWait: submissionWait, onBrowserFallback: browserAdmissionReporter(ctx.io, ctx.io.relayJson), runnerAdmission,
    executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, artifactDirectory: ctx.submitHandoffOutput })); }
  finally { reportSubmitStage(ctx, 'static', staticStart); }
  // Doctrine counts only fall: accepted main's rules, at this exact commit (D1). No rule, no change.
  let doctrine;
  const doctrineStart = performance.now();
  try { doctrine = await (hasSubmitRules(root, acceptedMain.commit, acceptedMain.config.practice)
    ? cachedDoctrineHold(root, { mainCommit: acceptedMain.commit, commit: companion?.commit ?? commit, practice: acceptedMain.config.practice, timeoutMs: acceptedMain.config.check?.timeoutMs }, () => withGateSlot(root, async lease => {
      const remote = runnerAdmission.runnerOnly ? doctrineRunnerChecks(root, acceptedMain.commit, lease, ctx.submitHandoffOutput) : null;
      try { return await holdDoctrineAsync(root, { mainCommit: acceptedMain.commit, commit: companion?.commit ?? commit,
        practice: acceptedMain.config.practice, timeoutMs: acceptedMain.config.check?.timeoutMs, ...(remote ? { runCheck: remote.runCheck } : {}) }); }
      finally { remote?.finish(); }
    },
      { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, itemCheck: true, agent: me.id, item: String(id), kind: 'doctrine', ...runnerAdmission, onWait: queuedItemLease(ctx, held, me.id, 'build'), onReceipt: (receipt) => ctx.io.say(`doctrine hold ${gateReceipt.receiptLine(receipt)}`) }))
    : []); }
  finally { reportSubmitStage(ctx, 'doctrine', doctrineStart); }
  for (const rule of doctrine) ctx.io.say(`doctrine: ${ruleLine(rule)}`);
  const runGate = (check) => withItemPatchSubmit(root, companion, gateRoot => runSubmitGate(gateRoot, submitConfig, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, staticChecked: true, outputRoot: root, outputLog: ctx.submitHandoffOutput ? join(ctx.submitHandoffOutput, 'gate.log') : undefined, runnerAdmission, signatureCapture: acceptedMain.config.submit?.autoFileMainReds === true ? { version: MAIN_FAILURE_SIGNATURE_VERSION, derive: (run, root) => failureSignatures(run, root, { raw: true }) } : undefined, base: claimHead, trunk: acceptedMain.commit, check, timing: frozenCheckTiming(held), agent: me.id, item: String(id), onWait: submissionWait, onStart: submissionStarted, onBrowserFallback: browserAdmissionReporter(ctx.io, ctx.io.relayJson),

    proofContext: { ...(companion ? { companion: true } : {}), item: id, frozenDigest: held.item_frozen_digest ?? null, seat: me.id, admission, quarantines },
    onFailure: nativeFlakes.observer(ctx, { kind: 'submit', main: acceptedMain.commit, commit: companion?.commit ?? commit, privateCheck: Boolean(companion), config: submitConfig }, { ordered, withBoard, resourceAgent, checkAtCommit }) }));
  ctx.submitAttempt.stage = 'runner';
  let gate = await runGate(frozenCheck(held));
  const submissionReceiptIds = [...(gate.proofReceiptIds ?? [])];
  for (const proofReceiptId of gate.proofReceiptIds ?? []) {
    await recordNativeProof(ctx, held, { proofReceiptId }, { ordered, withBoard, resourceAgent, proofRunReceipt });
  }
  if (companion) {
    companion.receiptIds = gate.proofReceiptIds.filter(id => typeof id === 'string');
    companion.phases = gate.phasePlan.map(({ role, command }) => ({ role, command: createHash('sha256').update(command).digest('hex') }));
  }
  const onMeasuredReceipt = receiptId => nativeFlakes.recordMainComparison(ctx, receiptId, { ordered, withBoard, resourceAgent });
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
  let criterionProblem = '';
  const companionAllowsMain = failures => !companion || companionMainFailuresUntouched(root,
    { base: mainFailureBase, source: commit, composed: companion.commit }, failures);
  const criterionCases = criterionRed && mainFailureBase && !companion ? failureSignatures(criterionRed, root) : null;
  if (criterionCases) {
    try {
      comparison = await compareMainFailures(root, criterionRed.profile, gateWaitReporter(ctx.io), criterionRed.output, { commit: mainFailureBase, detailed: true, fresh: acceptedMain.config.submit?.autoFileMainReds === true, onMeasuredReceipt, runnerAdmission,
        execution: { executor: criterionRed.executionRunner ? { kind: 'ssh', host: criterionRed.executionRunner } : { kind: 'local' }, environment: criterionRed.environment } });
      rememberComparison(comparison);
      criterionNotices = mainFailureNotices(root, criterionCases, comparison,
        { items: withBoard(ctx, board => store.listItems(board, { all: true })), exclude: id });
      const matched = matchingMainFailures(criterionCases, comparison, mainFailureBase);
      const rows = () => withBoard(ctx, board => store.listItems(board, { all: true }));
      // Cases with a unique open Main red repair link to it; the rest are recorded as unowned for the coordinator, never filed here.
      const missing = matched ? unownedMainReds(matched, rows(), id) : null;
      if (matched && !missing) ambiguous.push(...ambiguousMainReds(matched, rows(), id));
      if (missing) {
        criterionMatched = matched;
        criterionUnowned = missing;
        const owned = matched.failures.filter(row => !missing.some(red => red.file === row.file));
        criterionKnown = owned.length ? linkKnownMainReworks({ main: matched.main, failures: owned }, rows(), id) : null;
      }
    } catch (error) { criterionProblem = `\nknown-main acceptance of the frozen check failed: ${error?.message ?? error}`; /* Unavailable exact-main proof never authorizes a red frozen check. */ }
  }
  if (criterionMatched && gate.completedProof) {
    gate = { ...gate, ...gate.completedProof, log: gate.log, check: gate.check, criterionRed: gate.criterionRed };
  } else if (criterionMatched) {
    // The known red stands in for the criterion; the selected proof still runs on this commit, without re-running the check.
    const proof = await runGate(undefined);
    for (const proofReceiptId of proof.proofReceiptIds ?? []) {
      await recordNativeProof(ctx, held, { proofReceiptId }, { ordered, withBoard, resourceAgent, proofRunReceipt });
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
        execution: { executor: gate.executionRunner ? { kind: 'ssh', host: gate.executionRunner } : { kind: 'local' }, environment: gate.environment } });
      rememberComparison(comparison);
      proofNotices = mainFailureNotices(root, failures, comparison,
        { items: withBoard(ctx, board => store.listItems(board, { all: true })), exclude: id });
      const matched = matchingMainFailures(failures, comparison, mainFailureBase);
      const rows = () => withBoard(ctx, board => store.listItems(board, { all: true }));
      // Affected cases are judged like the frozen check (#1917, #1986): owned reds link to their repair, unowned ones are recorded for the coordinator.
      const missing = matched ? unownedMainReds(matched, rows(), id) : null;
      if (matched && !missing) ambiguous.push(...ambiguousMainReds(matched, rows(), id));
      if (missing) {
        proofMatched = matched;
        proofUnowned = missing;
        const owned = matched.failures.filter(row => !missing.some(red => red.file === row.file));
        proofKnown = owned.length ? linkKnownMainReworks({ main: matched.main, failures: owned }, rows(), id) : null;
      }
    } catch { /* Unavailable exact-main proof never authorizes a red submission. */ }
  }
  const mainFailures = [...new Map([...criterionNotices, ...proofNotices].map(row => [JSON.stringify([row.file, row.name, row.status]), row])).values()];
  const plainMainFailures = mainFailures.map(row => row.message).join('\n');
  const unowned = [...criterionUnowned, ...proofUnowned];
  const unownedMain = (criterionMatched ?? proofMatched)?.main;
  const redCriterion = criterionRed && !criterionMatched;
  const criterionNames = criterionKnown ? criterionKnown.failures : [];
  let knownMainFailures = criterionKnown && proofKnown ? { main: proofKnown.main, failures: [...criterionKnown.failures, ...proofKnown.failures] }
    : criterionKnown ?? proofKnown;
  if (redCriterion || !gate.isGreen && !waived && !proofMatched) {
    const accountingNote = (checkAccepted && !failures ? '\nknown-main acceptance unavailable: the proof has no complete named failure diagnostics' : '')
      + (ambiguous.length ? `\nknown main red with several candidate owners, none naming the case alone: ${ambiguous.map(row => `${row.file} (${row.name}): ${row.candidates.map(item => `#${item}`).join(', ')}`).join('; ')}; name the exact case in one repair's criterion` : '');
    const message = `${plainMainFailures ? plainMainFailures + "\n" : ""}the submission proof is red at ${commit.slice(0, 12)}; fix it, commit, submit again. ${displayedReport}${accountingNote}${criterionProblem}`;
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
    if (isSubmitHandoffWorker(ctx)) await withBoard(ctx, async board => {
      const job = submitHandoff(board, id);
      await ordered(ctx, board, 'startSubmitHandoff', [id, { agentId: me.id, job: job.id,
        hookProjection: { job: job.id, commit: job.executionCommit, tree: job.executionTree,
          digest: job.digest, receipts: [...new Set(submissionReceiptIds)] } }]);
    });
    const composed = await composeAfterProof(root, { id, proofCommit: commit, proved: acceptedMain.commit, item: held, check: frozenCheck(held),
      readTrunk: () => requireTrunkMerge(root, commit) }, { selectAffectedTests, explicitCheckFiles, judgeTrunkMove,
        ...(ctx.submitHandoffOutput ? { onMergeFailure: error => writeFileSync(join(ctx.submitHandoffOutput, 'merge-failure.log'), String(error.stderr || error.stack || error.message), { mode: 0o600 }) } : {}) });
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
  const autoMainReds = unowned.length && acceptedMain.config.submit?.autoFileMainReds === true
    ? { main: unownedMain, candidateReceiptIds: [...new Set(submissionReceiptIds)], mainReceiptIds: [...new Set(mainComparisonReceiptIds.values())] } : null;
  await withBoard(ctx, async (board) => {
    refuseUnverifiedStack(root, board, store.getItem(board, id), submitted, currentTrunk);
    // The waived run is written to the item's thread before the submission, so no waived proof reads as green.
    if (waived) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `submission proof at ${commit.slice(0, 12)} was red and is recorded as waived, not green; every failure is covered by a live person waiver:\n${waivedLines.join('\n')}` }]);
    if (criterionNames.length) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `frozen check red at ${commit.slice(0, 12)} only in cases that fail identically on main at ${criterionMatched.main}: ${criterionNames.map(row => `${row.file} (${row.name}), open repair #${row.item}`).join('; ')}. Reviewers: these known main reds are listed, not blocking; any case green on main would have refused.` }]);
    if (criterionUnowned.length && !autoMainReds) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `unowned known main red: the frozen check fails identically on main at ${criterionMatched.main} in ${criterionUnowned.map(red => `${red.file} (${red.names.join('; ')})`).join('; ')}, and no open Main red item names the file; a decision was shouted to the coordinator.` }]);
    if (proofUnowned.length && !autoMainReds) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `unowned known main red: the submission proof at ${commit.slice(0, 12)} fails identically on main at ${proofMatched.main} in ${proofUnowned.map(red => `${red.file} (${red.names.join('; ')})`).join('; ')}, and no open Main red item names the file; a decision was shouted to the coordinator. The item check passed; no new failure is accepted.` }]);
    if (knownMainFailures) await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'measurement', text: `submission proof at ${commit.slice(0, 12)} remains red; known main failures at ${knownMainFailures.main}: ${knownMainFailures.failures.map(row => `${row.file} (${row.name}), open repair #${row.item}`).join('; ')}. The item check passed; no new or unaccounted failure is accepted.` }]);
    const quarantineProofIds = [];
    for (const receiptId of submissionReceiptIds) {
      const receipt = boundProofReceipt(board, { receiptId });
      sealQuarantineVerdict(board, receipt);
      if (Object.hasOwn(receipt, 'blockingVerdict')) quarantineProofIds.push(receiptId);
    }
    const submittedMove = await ordered(ctx, board, 'submit', [id, { agentId: me.id, commit: submitted, tree: headTree(root) ?? '', files: filesSince(root, id, claimHead, commit), policyCommit: acceptedMain.commit, ...(infraRecord ? { infra: infraRecord } : {}),
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
    if (unowned.length && !autoMainReds) await ordered(ctx, board, 'shout', [{ from: me.id, to: COORDINATOR, lanes: laneNames(ctx.config), decision: true,
      text: `#${id}: known main red with no open Main red item: ${unowned.map(red => `${red.file} (${red.names.join('; ')})`).join('; ')} fails identically on main at ${unownedMain.slice(0, 12)}; file or assign its repair.` }]);
    return submittedMove;
  });
  // A large submit still goes through; the note only suggests a chain of smaller items (#1162).
  const sizeNote = oversizeNote(measuredLines, acceptedMain.config.itemSizeBudget);
  if (sizeNote) ctx.io.say(`note: ${sizeNote}`);
  for (const reminder of submitReferenceReminders(root, held, commit)) ctx.io.err(reminder);
  const unownedNames = (autoMainReds ? [] : unowned).flatMap(red => red.names.map(name => `${red.file} (${name})`));
  const report = knownMainFailures || unowned.length
    ? `submission proof red with ${(knownMainFailures?.failures.length ?? 0) + unownedNames.length} known main failure(s) at ${unownedMain ?? knownMainFailures.main}; ${criterionMatched ? 'item check red only in known main cases' : 'item check green'}; no new failures accepted.${unownedNames.length ? ` Unowned${autoMainReds ? ", repairs filed by submit" : ", shouted to the coordinator"}: ${unownedNames.join('; ')}.` : ''} ${displayedReport}`
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
              submitOutcome: { digest: attempt.digest, code: error.code, text: error.message.slice(0, 4000), ...(attempt.stage === 'fast' ? { stage: 'fast' } : {}) } }]);
          }
        });
      } catch (recordError) { ctx.io.err(`submit outcome not recorded: ${recordError.message}`); }
    }
    throw error;
  }
  finally { io.onOrderedMove = previous; }
  if (code !== 0 || !values.wait || !submissionResult.queued) return code;
  return waitForSubmitGate(ctx, id, submissionResult.value, submissionResult.job,
    { withBoardRead: waitBoardRead, submitHandoff, getItem: store.getItem });
}
import { SUBMISSION_SIZE_METHOD } from '../../packages/state/src/core/submission-size.js';
