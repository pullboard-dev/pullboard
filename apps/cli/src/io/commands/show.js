import { clauseReceipts } from '../../../../../packages/state/index.js';
import { recordedVerificationComparison } from '../../../../../packages/verify/index.js';
import { renderVerificationComparison } from '../../../../../packages/verify/index.js';
import { machineVerification } from '../../../../../packages/verify/index.js';
import { testHashRulings } from '../../../../../packages/verify/index.js';
import { testAuthors } from '../../../../../packages/verify/index.js';
import { barTestFiles } from '../../../../../packages/verify/index.js';
import { landedOnMain } from '../../../../../packages/roadmap/index.js';
import { itemProgress } from '../../../../../packages/roadmap/index.js';
import { progressLine } from '../../../../../packages/roadmap/index.js';
import { submitHandoff } from '../../../../../packages/store/light.js';
import { mutationScoreLines } from '../../logic/mutate/score.js';
import { queuedGateLines } from '../../logic/show/gate.js';
import { supersededStop } from '../../logic/show/gate.js';
import { pulledRedLines } from '../../logic/show/gate.js';
import { pulledWaitingLines } from '../../logic/show/gate.js';
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { localUsage } from '../../../../../packages/config/index.js';
import { dollarText } from '../../../../../packages/config/index.js';
import { trunkRef } from '../../../../../packages/git/light.js';
import { verifiedPasskeyRowDecision } from '../../../../../packages/person/read.js';
import { reviewEligibility } from '../../../../../packages/verify/index.js';
import { showReviewPacket } from '../../../../../packages/verify/index.js';
import { gatePanel } from '../../../../../packages/jobs/index.js';
import { jobsOf } from '../../../../../packages/jobs/index.js';
import { settledGate } from '../../../../../packages/jobs/index.js';
import { withBoardRead } from '../board/read.js';
import {
  testRuntimeEnvironment,
  testRuntimeRows,
} from '../../../../../packages/verify/light.js';
/** The pullboard show command, in its own module so an item adding another command never edits these lines. */
import {
  displayAgentName,
} from '../../../../../packages/seats/browser.js';
import {
  barCorrectionLine,
  barCorrections,
} from '../../../../../packages/verify/index.js';
import * as store from '../../../../../packages/store/light.js';
import {
  agentApprovalLine,
  itemAgentApprovals,
  itemSpecIds,
  specApprovalState,
} from '../../../../../packages/spec/index.js';
import {
  mainMergeFor,
  mainMergeLines,
} from '../../../../../packages/merge/light.js';
import {
  staleVerdictRefusal,
  verdictProjector,
} from '../../../../../packages/verify/read.js';
import {
  agentDisplayName,
  context,
  firstLineOf,
  identifyCaller,
  idArg,
  itemLine,
  sayBrief,
} from '../read.js';
import { relayStateExists } from '../../../../../packages/store/light.js';
import { readableRigorText } from '../../../../../packages/store/browser.js';
import { itemCost } from '../../../../../packages/stats/light.js';
import { publicUsage } from '../../../../../packages/stats/light.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { itemFolderPath } from '../item/folder/identity.js';

/** Query-only dispatch defers the explicit native provider until a genuine write fallback. */
export const nativeBoardRequired = false;

/**
 * The item's newest gate job as its step and, once done, the gate its receipt recorded; null when it has none.
 * Why: a pulled submit returns queued at once, and this is how a script reads the gate's settled verdict [C7,#6821].
 */
export function newestGateJob(db, id, receipts = []) {
  let job;
  try { job = jobsOf(db, { kind: 'gate', item: id }).at(-1); } catch (error) { if (/no such table/u.test(error.message)) return null; throw error; }
  if (!job) return null;
  // The receipt's plan, counts and log read back in the inline gate's shape; a receipt without them reads as it was [P7].
  const posted = job.steps.find(step => step.name === 'receipt')?.payload ?? null;
  return { id: job.id, step: job.step, gate: settledGate(job.id, posted, new Set(receipts.map(receipt => receipt.id))) };
}

/** Run `pullboard show` and return its exit code. */
export async function run(io, { first, values }) {
  const ctx = context(io);
  const id = idArg(first);
  // The packet is read from the board's store: no checkout, no test run, no full item projection (#2451).
  if (values.review) { const full = await import('../../../../../packages/store/index.js'); return showReviewPacket(ctx, id, (work) => withBoardRead(ctx, (board) => work(board, full)), { json: values.json }); }
  const prices = loadMachineSettings().costPrices;
  const { item, queuedSubmit, queuedJobId, gateJob, gateText, verdicts, moves, thread, related, reviewer, agents, mainMerge, submits, approval, cost, proofReceipts, independence, progress, machine } = await withBoardRead(ctx, async (board) => {
    const item = verdictProjector(ctx.info.root, board, {}, { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem, trunkRef }).project(store.getItem(board, id));
    const failureLines = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`main_red_failure_lines:${id}`);
    if (failureLines) item.main_red_failure_lines = JSON.parse(failureLines.meta_value);
    // A landed item keeps the timed phases of the landing that merged it, as its landing receipt said them [C7,#8960].
    const landingPhases = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`landing_phases:${id}`);
    if (landingPhases) item.landing_phases = JSON.parse(landingPhases.meta_value);
    const job = submitHandoff(board, id);
    const queuedSubmit = job ? { state: job.state, ...(Object.hasOwn(job, 'gateGreen') ? { gateGreen: job.gateGreen } : {}), commit: job.commit, tree: job.tree, executionCommit: job.executionCommit, executionTree: job.executionTree, companionDigest: job.companionDigest, ...(job.error ? { error: job.error } : {}), ...(job.requeuedFor ? { requeuedFor: job.requeuedFor } : {}), ...(supersededStop(job, item) ? { superseded: { agentId: job.agentId } } : {}) } : null;
    // The gate panel reads the jobs cell: a job whose lease lapsed shows as stalled, never as running [C7].
    const handoffWorkerAlive = job ? (await import('../alive.js')).handoffWorkerAlive : null;
    const panel = job ? gatePanel(board.db, job.id, { workerAlive: () => handoffWorkerAlive(board, job) }) : null;
    const result = { item, queuedSubmit, queuedJobId: job?.id ?? null, gateText: panel?.text ?? null, machine: machineVerification(board, item), progress: itemProgress(board, id, { onMain: landedOnMain(ctx.info.root, ctx.config) }), independence: reviewEligibility(board, item, { policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family }), verdicts: store.verdictsFor(board, id), thread: store.itemThread(board, id),
      proofReceipts: store.proofReceipts(board, id),
      approval: specApprovalState(ctx.info.root, { board, config: ctx.config, ids: itemSpecIds(item) }, { store, verifiedPasskeyRowDecision }), cost: itemCost(board, id, prices) };
    // JSON retains every public detail field; text-only labels and related-item searches add nothing to it. It also names
    // the newest gate job and, once done, its receipt's gate: a pulled gate keeps no hand-off record to read instead [C7].
    const gateJob = newestGateJob(board.db, id, result.proofReceipts);
    if (values.json) return { ...result, gateJob };
    const history = store.events(board, { itemId: id });
    return { ...result, gateJob, moves: history.filter((event) => ['attempt', 'escalate'].includes(event.event_kind)),
      related: store.relatedItems(board, item), reviewer: store.reviewHolder(board, item),
      agents: store.listAgents(board), mainMerge: mainMergeFor(board, id), submits: history.filter((event) => event.event_kind === 'submit') };
  });

  // The commits front door also carries the hook machinery, so an item that was never submitted never loads it.
  const infra = submits?.length ? (await import('../../../../../packages/commits/index.js')).infraNoteOf(submits) : null;
  const comparison = recordedVerificationComparison(thread, item);
  const agentApproved = itemAgentApprovals(item, approval);
  const approvalQualification = agentApprovalLine(agentApproved);
  // #922: moves on this item made while the relay was down wait in this machine's relay outbox until it answers.
  // Without a relay link or deleted-copy notice there is no outbox to read, so the relay client never loads.
  if (relayStateExists(ctx.info.commonDir)) await io.prepareProcessPorts?.();
  const outbox = relayStateExists(ctx.info.commonDir) ? (await import('../../../../../packages/link/index.js')).relayStatus(ctx.info.root, io).outbox : undefined;
  const relayPending = (outbox ?? []).filter((move) => move.item === id);
  const frozen = item.item_frozen ? JSON.parse(item.item_frozen) : null;
  const checkText = frozen ? frozen.check ?? '' : item.item_check ?? '';
  if (values.json) {
    io.result({ ...item, progress, machineVerification: machine, ...(comparison ? { comparison } : {}), ...(queuedSubmit ? { queuedSubmit } : {}), ...(gateJob ? { gateJob } : {}), reviewEligibility: independence, checkText, verdicts, thread, ...(proofReceipts.length ? { proofReceipts } : {}), agentApproved, approvalQualification, ...(cost.models.length || cost.shared ? { usage: localUsage(cost, publicUsage) } : {}), ...(relayPending.length ? { relayPending } : {}) });
    return 0;
  }
  // Keep the read usable from an unjoined checkout, and avoid registering a coordinator just to print status.
  const environment = process.env.PULLBOARD_RELAY_TOKEN !== undefined
    ? (({ environmentAgent }) => ({ environmentAgent }))(await import('../../../../../packages/link/index.js')) : null;
  const callerId = ctx.info.isMain ? 'coordinator' : await withBoardRead(ctx, (board, readers) => {
    try { return identifyCaller(ctx, board, { environmentAgent: environment?.environmentAgent ?? (() => null),
      relayLinked: () => false }, readers).id; }
    catch (error) {
      if (error instanceof Refused && error.code === 'NOT_JOINED') return null;
      throw error;
    }
  });
  const agentName = (id) => displayAgentName(agents.find((agent) => agent.agent_id === id) ?? { agent_id: id }, ctx.config.agents.names);
  io.say(itemLine(item, agentName, Boolean(mainMerge)));
  if (item.item_gate_runner === 'none') io.say(`next: pullboard runner local, or pullboard submit ${item.item_id} again`);
  if (item.item_status === 'claimed' && item.item_owner === callerId) {
    // A seat builds in its item folder, never its seat checkout: naming "this checkout" sent builders to commit item work there (#3691).
    const seatPath = agents.find((agent) => agent.agent_id === callerId)?.agent_path;
    io.say(seatPath
      ? `you hold #${item.item_id}; build and commit in its item folder ${itemFolderPath(seatPath, item.item_id)}, then run pullboard submit ${item.item_id} there`
      : `you hold #${item.item_id}; continue building in this checkout, then run pullboard submit ${item.item_id}`);
  }
  io.say(progressLine(progress));
  if (item.item_expected_build_minutes != null) io.say(`expected build: ${item.item_expected_build_minutes} min`);
  if (comparison) io.say(renderVerificationComparison(comparison));
  io.say(`machine-verified: ${machine ? 'on (frozen commands; strict and sensitive changes require review)' : 'off'}`);
  for (const line of queuedGateLines(queuedSubmit, gateText)) io.say(line);
  for (const line of pulledRedLines(gateJob, item)) io.say(line);
  for (const line of pulledWaitingLines(gateJob, item)) io.say(line);
  // A finished red gate keeps its full log while the item is open; its failing assertions print here [C7,#3381].
  if (queuedJobId && queuedSubmit && !['queued', 'running', 'green'].includes(queuedSubmit.state) && queuedSubmit.gateGreen !== true) {
    // The gate cell loads only for a finished red gate or a recorded check baseline: a plain read never pays for it [C7].
    const { retainedGateAssertions } = await import('../../../../../packages/gate/index.js');
    for (const line of retainedGateAssertions(ctx.info.commonDir, queuedJobId)) io.say(`gate red: ${line}`);
  }
  if (item.item_rehome_import) {
    const imported = item.item_rehome_import;
    io.say(`${imported.sourceStatus === 'verified' ? 'verified' : 'imported'} on ${imported.sourceHandle}, moved by ${agentName(imported.attestedBy)}; source verdicts are imported references, not reviews on this board`);
    if (values.history) for (const verdict of imported.sourceVerdicts ?? []) {
      io.say(`  source ${verdict.verdict_decision} ${verdict.verdict_reason} by ${verdict.verdict_by} at ${verdict.verdict_commit}: ${verdict.verdict_note}`);
    }
  }
  if (item.item_status === 'verified' && approvalQualification) io.say(approvalQualification);
  if (item.item_verdict_state) io.say(staleVerdictRefusal(item, item.item_verdict_state).message);
  io.say(`review tier: ${independence.tier}${independence.requiredFamily ? `; required family ${independence.requiredFamily}` : ''}`);
  io.say(`eligible reviewers: ${independence.ready ? independence.eligible.join(', ') || 'none' : 'not submitted'}`);
  if (values.detail) io.say(`usage: input ${cost.inputTokens ?? 'unknown'} (fresh ${cost.freshInputTokens ?? 'unknown'}, cached read ${cost.cacheReadInputTokens ?? 'unknown'}, cached write ${cost.cacheWriteInputTokens ?? 'unknown'}), output ${cost.outputTokens ?? 'unknown'}, ${cost.wallMs} ms${cost.shared ? '; shared-session item split unknown' : cost.splitByTime ? '; split by time with a shared session' : ''}; models ${cost.models.join(', ') || 'unknown'}${cost.unknownReasons.length ? '; unknown: ' + cost.unknownReasons.join(', ') : ''}${dollarText(cost)}`);
  else if (cost.inputTokens != null || cost.outputTokens != null) io.say(`usage: input ${cost.inputTokens ?? 'unknown'}, output ${cost.outputTokens ?? 'unknown'}${cost.shared ? '; shared-session item split unknown' : cost.splitByTime ? '; split by time with a shared session' : ''}${dollarText(cost)}; --detail`);
  if (item.item_criterion) io.say(`criterion: ${item.item_criterion}`);
  if (checkText) {
    io.say(`check: ${checkText}`);
    if (item.item_frozen_digest) io.say(`check digest: ${item.item_frozen_digest}`);
  }
  for (const receipt of proofReceipts) {
    const hasTestRuntimes = Object.hasOwn(receipt, 'testRuntimes');
    const testRuntimes = hasTestRuntimes ? testRuntimeRows(receipt.testRuntimes) : null;
    const environment = hasTestRuntimes ? testRuntimeEnvironment(testRuntimes) : receipt.environment;
    const runtime = environment ? `Node ${environment.node} ${environment.platform}/${environment.arch}` : 'runtime unknown';
    const counts = !receipt.counts || Object.values(receipt.counts).some(value => value === null) ? 'test counts unknown'
      : `${receipt.counts.passed} pass, ${receipt.counts.failed} fail, ${receipt.counts.skipped} skip`;
    io.say(`receipt ${receipt.id}: ${receipt.kind}, item #${receipt.item}`);
    io.say(`  commit ${receipt.commit ?? 'unknown'}; tree ${receipt.tree ?? 'unknown'}; frozen ${receipt.frozenDigest ?? 'unknown'}`);
    io.say(`  ${runtime}; runner ${receipt.runner ?? 'unknown'}; seat ${receipt.seat}; parent ${receipt.parentSession ?? 'unknown'}`);
    io.say(`  exit ${receipt.exitCode ?? 'unknown'}; ${counts}; ${receipt.durationMs}ms${receipt.sourceClean ? '' : '; source unproven'}`);
    if (hasTestRuntimes && !testRuntimes) io.say('  test child runtimes unknown');
    for (const child of testRuntimes ?? []) {
      io.say(`  child ${child.pid}: Node ${child.environment.node} ${child.environment.platform}/${child.environment.arch}; ${child.file ?? 'test file unknown'}`);
    }
  }
  if (item.item_check_baseline) (await import('../../../../../packages/gate/index.js')).sayCheckBaseline(io, item, { runnerLive: (await import('../runner/local.js')).anyRunnerLive() });
  for (const failure of item.main_red_failure_lines ?? []) io.say(`main red: ${failure.name}: ${failure.firstError}`);
  sayBrief(io, item.item_brief);
  for (const move of relayPending) io.say(`pending in the relay outbox: ${move.operation}${move.actor ? ` by ${move.actor}` : ''} (made ${move.queuedAt}); it goes up in order when the relay answers`);
  for (const { item: other, shared } of related) {
    io.say(`related: #${other.item_id} ${other.item_title}: ${shared.slice(0, 4).join(', ')}${shared.length > 4 ? ', ...' : ''} (git log -p -1 ${other.item_commit.slice(0, 12)} -- ${shared[0]})`);
  }
  const attempts = moves.filter((event) => event.event_kind === 'attempt').map((event) => JSON.parse(event.event_detail).result);
  if (attempts.length) io.say(`unattended attempts: ${attempts.join(', ')}`);
  for (const event of moves.filter((entry) => entry.event_kind === 'escalate')) {
    const detail = JSON.parse(event.event_detail);
    io.say(`escalated ${detail.from} -> ${detail.to} by ${agentName(event.event_by)}${detail.attempt ? `, pinned at ${detail.attempt}` : ''}: ${firstLineOf(detail.note)}`);
  }
  if (frozen) {
    io.say(`frozen at claim (${item.item_frozen_digest.slice(0, 12)}):`);
    frozen.rows.forEach((row) => io.say(`  ${row.id}: ${readableRigorText(row.text)}${row.gate ? `  | gate: ${row.gate}` : ''}`));
    const rulings = testHashRulings(thread, store.PERSON);
    for (const [path, hash] of Object.entries(frozen.testHashes ?? {})) {
      const ruled = rulings.filter(ruling => ruling.path === path);
      io.say(`  test ${path}: sha256 ${hash}${ruled.length ? `; person ruling ${ruled.map(ruling => `${ruling.factId} accepts ${ruling.hash.slice(0, 12)}`).join(', ')}` : ''}`);
    }
  }
  for (const line of mutationScoreLines(thread)) io.say(line);
  const authors = testAuthors(thread);
  const reviewerFamilies = [...new Set(verdicts.map(verdict => verdict.verdict_verifier_family).filter(Boolean))];
  for (const path of barTestFiles(item).criterion.sort()) {
    const author = authors[path];
    io.say(`  test ${path}: author ${author ? `${agentName(author.seat)} [family ${author.family}]` : 'not recorded'}; reviewer family ${reviewerFamilies.join(', ') || 'none yet'}`);
  }
  if (item.item_commit) io.say(`submitted by ${agentName(item.item_built_by)}${item.item_builder_family ? ` [family ${item.item_builder_family}]` : ''} at ${item.item_commit}`);
  if (item.item_effective_head) io.say(`checked main merge: ${item.item_effective_head} (original submitted source and verdict retained)`);
  if (infra) io.say(`infra note: ${infra.note} (files: ${infra.files.join(', ') || 'none'})`);
  if (reviewer) io.say(`under review by ${agentName(reviewer)} until ${item.item_review_until}`);
  // Earlier verdicts as one line each, so an item sent back several times stays short to read
  // (N30); --history prints every note in full.
  const verdictLine = (verdict) => `${verdict.verdict_decision} ${verdict.verdict_reason} by ${agentName(verdict.verdict_by)}${verdict.verdict_verifier_family ? ` [family ${verdict.verdict_verifier_family}]` : ''} at ${verdict.verdict_commit.slice(0, 12)}`;
  const notes = verdicts.map((verdict, index) => (values.history || index === verdicts.length - 1 ? verdict.verdict_note : firstLineOf(verdict.verdict_note)));
  verdicts.forEach((verdict, index) => {
    io.say(`${verdictLine(verdict)}${notes[index] ? `: ${notes[index]}` : ''}`);
    io.say(`  check: ${verdict.check ?? 'unknown'}`);
    io.say(`  assurance: ${verdict.assurance}`);
  });
  if (notes.some((note, index) => note !== verdicts[index].verdict_note)) io.say(`(earlier verdicts shortened; every note in full: pullboard show ${id} --history)`);
  for (const correction of barCorrections(thread)) io.say(barCorrectionLine(correction));
  for (const receipt of clauseReceipts(thread)) io.say(`fail-before, pass-after receipt, clause ${receipt.number}: ${receipt.text}`);
  for (const line of mainMerge ? mainMergeLines(item, mainMerge, agentName) : []) io.say(line);
  if (item.item_merged_commit) io.say(`merged as ${item.item_merged_commit}`);
  if (item.item_withdrawn_reason) io.say(`withdrawn: ${item.item_withdrawn_reason}`);
  io.say('thread:');
  for (const entry of thread) {
    if (entry.kind === 'proof-run') continue;
    const stamp = `  ${entry.at}  ${agentDisplayName(agents, ctx.config, entry.by)}  `;
    if (entry.type === 'fact') {
      io.say(`${stamp}fact ${entry.kind} ${entry.id}${entry.answers ? ' (answers ' + entry.answers + ')' : entry.supersedes ? ' (supersedes ' + entry.supersedes + ')' : ''}: ${entry.text}`);
      if (entry.ref) io.say(`    ref: ${entry.ref.path}:${entry.ref.start}${entry.ref.end === entry.ref.start ? '' : '-' + entry.ref.end}@${entry.ref.commit}`);
    } else {
      const detail = entry.detail;
      io.say(`${stamp}${entry.kind}${detail.commit ? ' at ' + detail.commit : ''}${detail.previousTitle ? ` (title was: ${detail.previousTitle})` : ''}${detail.reason ? ': ' + detail.reason : ''}${detail.note ? `: ${entry.kind === 'escalate' ? firstLineOf(detail.note) : detail.note}` : ''}`);
    }
  }
  return 0;
}
