/** @pullboard-module-loads packages/jobs/index.js */
import { createRequire } from 'node:module';
import { clauseReceipts } from '../../../../../packages/state/index.js';
import { itemProgress } from '../../../../../packages/roadmap/light.js';
import { progressLine } from '../../../../../packages/roadmap/light.js';
import { submitHandoff } from '../../../../../packages/store/light.js';
import { mutationScoreLines } from '../../logic/mutate/score.js';
import { coreLines } from '../../logic/show/core.js';
import { tailLines } from '../../logic/show/tail.js';
import { fieldLines } from '../../logic/show/fields.js';
import { reviewLines } from '../../logic/show/review.js';
import { usageLine } from '../../logic/show/usage.js';
import { queuedGateLines } from '../../logic/show/gate.js';
import { supersededStop } from '../../logic/show/gate.js';
import { pulledRedLines } from '../../logic/show/gate.js';
import { pulledWaitingLines } from '../../logic/show/gate.js';
import { queueWaitLines } from '../../logic/show/gate.js';
import { landingPhaseLines } from '../../logic/show/gate.js';
import { exactTreeLine } from '../../logic/show/gate.js';
import { exactTreeOf } from '../../logic/show/gate.js';
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { typedFieldsEnabled } from '../../../../../packages/config/index.js';
import { hunkFreshnessEnabled } from '../../../../../packages/config/index.js';
import { derivedStateEnabled } from '../../../../../packages/config/index.js';
import { submitComposeAsObject } from '../../../../../packages/config/index.js';
import { localUsage } from '../../../../../packages/config/index.js';
import { dollarText } from '../../../../../packages/config/index.js';
import { trunkRef } from '../../../../../packages/git/light.js';
import { verifiedPasskeyRowDecision } from '../../../../../packages/person/read.js';
import { withBoardRead } from '../board/read.js';
import {
  testRuntimeEnvironment,
  testRuntimeRows,
} from '../../../../../packages/verify/light.js';
/** The pullboard show command, in its own module so an item adding another command never edits these lines. */
import {
  displayAgentName,
} from '../../../../../packages/seats/browser.js';
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
  showReads,
  showReviewPacket,
  staleVerdictRefusal,
  verdictProjector,
} from '../../../../../packages/verify/read.js';
import {
  agentDisplayName,
  context,
  firstLineOf,
  identifyCaller,
  idArg,
  foreignStates,
  itemLine,
  sayBrief,
} from '../read.js';
import { relayStateExists } from '../../../../../packages/store/light.js';
import { readableRigorText } from '../../../../../packages/store/browser.js';
import { itemCost } from '../../../../../packages/stats/light.js';
import { publicUsage } from '../../../../../packages/stats/light.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { itemFolderPath } from '../item/folder/identity.js';

const requireModule = createRequire(import.meta.url);
/** The jobs cell loads at the first gate job or gate panel a show renders: a show of an item with no gate job never pays its 17 modules [C7,#11912]. */
const jobsCell = () => requireModule('../../../../../packages/jobs/index.js');

/** Query-only dispatch defers the explicit native provider until a genuine write fallback. */
export const nativeBoardRequired = false;

/**
 * The item's newest gate job as its step and, once done, the gate its receipt recorded; null when it has none.
 * Why: a pulled submit returns queued at once, and this is how a script reads the gate's settled verdict [C7,#6821].
 */
export function newestGateJob(db, id, receipts = [], { runs = null } = {}) {
  if (runs) return newestRunGateJob(db, id, receipts, runs);
  let job;
  try {
    if (!db.prepare("SELECT 1 FROM job WHERE job_kind = 'gate' AND job_item = ? LIMIT 1").get(id)) return null;
    job = jobsCell().jobsOf(db, { kind: 'gate', item: id }).at(-1);
  } catch (error) { if (/no such table/u.test(error.message)) return null; throw error; }
  if (!job) return null;
  // The receipt's plan, counts and log read back in the inline gate's shape; a receipt without them reads as it was [P7].
  const posted = job.steps.find(step => step.name === 'receipt')?.payload ?? null;
  return { id: job.id, step: job.step, ...settleOf(job.steps), gate: jobsCell().settledGate(job.id, posted, new Set(receipts.map(receipt => receipt.id))) };
}

/** The outcome of a gate job's newest note:shards.settled step, as { settle }; none while no such step exists [C7,#11935]. */
function settleOf(steps) {
  const outcome = steps.filter(step => step.name === 'note:shards.settled').at(-1)?.payload?.outcome;
  return typeof outcome === 'string' ? { settle: outcome } : {};
}

/**
 * The item's newest gate with runs_store on: its outcome from the board's run row, its live step and receipt from the
 * runs file, which this only reads. A receipt the runs file no longer keeps falls back to the run row's capped summary [B2,#9013].
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's handle.
 * @param {number} id
 * @param {{ id: string }[]} receipts
 * @param {{ db: import('node:sqlite').DatabaseSync | null }} runs - The read-only runs holder (boardRunsReader).
 */
function newestRunGateJob(db, id, receipts, runs) {
  let run;
  try { run = db.prepare("SELECT * FROM run WHERE run_kind = 'gate' AND run_item = ? ORDER BY run_created, rowid").all(id).at(-1); } catch (error) { if (/no such table/u.test(error.message)) return null; throw error; }
  if (!run) return null;
  const live = runs.db ? jobsCell().jobView(runs.db, run.run_job) : null;
  const posted = live?.steps.find(step => step.name === 'receipt')?.payload ?? null;
  let summary = null;
  try { summary = run.run_state === 'done' ? JSON.parse(run.run_summary ?? 'null') : null; } catch { summary = null; }
  const step = run.run_state === 'done' ? 'done' : live?.step ?? run.run_state;
  return { id: run.run_job, step, ...settleOf(live?.steps ?? []), ...(run.run_outcome ? { outcome: run.run_outcome } : {}),
    gate: jobsCell().settledGate(run.run_job, posted ?? (summary ? { receipt: summary } : null), new Set(receipts.map(receipt => receipt.id))) };
}

/**
 * The main commit and the verdict reader of the derived-state table, or null when the table is not current for main [C7,#10572].
 * Why lazy: the health cell loads only with health.derivedState on, so the cold path of show loads nothing more with it off.
 * An item with no row answers undefined, and the projector computes its freshness as before.
 */
async function derivedVerdictTable(root, board, verdictTrunk) {
  let main;
  try { main = verdictTrunk(root, { trunkRef }); } catch { return null; }
  const { readDerivedState } = await import('../../../../../packages/health/index.js');
  const table = readDerivedState(board, { mainCommit: main, enabled: true });
  return table ? { main, derived: item => table.verdicts.get(String(item.item_id)) } : null;
}

/** Run `pullboard show` and return its exit code. */
export async function run(io, { first, values }) {
  const ctx = context(io);
  const id = idArg(first);
  // The packet is read from the board's store: no checkout, no test run, no full item projection (#2451).
  if (values.review) { const full = await import('../../../../../packages/store/index.js'); return showReviewPacket(ctx, id, (work) => withBoardRead(ctx, (board) => work(board, full)), { json: values.json }); }
  // The verify reads come from their defining modules through the read door, never the full index, so a cold show loads only what it calls [C7,#11911].
  const { recordedVerificationComparison, renderVerificationComparison, machineVerification, testHashRulings, testAuthors, barTestFiles, verdictTrunk, reviewEligibility, barCorrectionLine, barCorrections } = await showReads();
  const prices = loadMachineSettings().costPrices;
  const { fields, links, item, foreign, queuedSubmit, queuedJobId, gateJob, gateText, verdicts, moves, thread, related, reviewer, agents, mainMerge, submits, approval, cost, proofReceipts, independence, progress, machine } = await withBoardRead(ctx, async (board) => {
    // With health.derivedState on and the table swept at the current main, the verdict freshness comes from its row [C7,#10572].
    const table = derivedStateEnabled() ? await derivedVerdictTable(ctx.info.root, board, verdictTrunk) : null;
    // An accept whose only conflict with main is one the mechanical merge resolves stays fresh, as it does at landing; the merge index loads only for an accepted item [C7,#11417].
    const stored = store.getItem(board, id);
    const residualConflicts = stored?.item_status === 'verified' ? (await import('../../../../../packages/merge/index.js')).mechanicalConflictFiles : null;
    const item = verdictProjector(ctx.info.root, board, table ? { main: table.main } : {}, { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem, trunkRef, hunkKeyed: hunkFreshnessEnabled(), residualConflicts, ...(table ? { derived: table.derived } : {}) }).project(stored);
    const failureLines = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`main_red_failure_lines:${id}`);
    if (failureLines) item.main_red_failure_lines = JSON.parse(failureLines.meta_value);
    // A landed item keeps the timed phases of the landing that merged it, as its landing receipt said them [C7,#8960].
    const landingPhases = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`landing_phases:${id}`);
    if (landingPhases) item.landing_phases = JSON.parse(landingPhases.meta_value);
    // The exact-tree record of the landing batch that carried a landed item sits beside its phases; an older landing has none [V16,V38].
    const exactTree = item.item_merged_commit ? exactTreeOf(board.db, id) : undefined;
    if (exactTree) item.landing_exact_tree = exactTree;
    // Typed fields load the full store only while items.typedFields is on: with it off the read is what it was [C7,#9352].
    const fields = typedFieldsEnabled() ? (await import('../../../../../packages/store/index.js')).itemFields(board, id, { enabled: true }) : [];
    // Free related links (#9356) load beside the fields, so with the setting off no link is read and show is as it was [C7].
    const links = typedFieldsEnabled() ? (await import('../../../../../packages/store/index.js')).relatedLinks(board, id, { enabled: true })
      .map(other => ({ id: other, title: board.db.prepare('SELECT item_title FROM item WHERE item_id=?').get(other)?.item_title ?? '' })) : [];
    const job = submitHandoff(board, id);
    const queuedSubmit = job ? { state: job.state, ...(Object.hasOwn(job, 'gateGreen') ? { gateGreen: job.gateGreen } : {}), commit: job.commit, tree: job.tree, executionCommit: job.executionCommit, executionTree: job.executionTree, companionDigest: job.companionDigest, ...(job.error ? { error: job.error } : {}), ...(job.requeuedFor ? { requeuedFor: job.requeuedFor } : {}), ...(supersededStop(job, item) ? { superseded: { agentId: job.agentId } } : {}) } : null;
    // The gate panel reads the jobs cell: a job whose lease lapsed shows as stalled, never as running [C7].
    const handoffWorkerAlive = job ? (await import('../alive.js')).handoffWorkerAlive : null;
    const panel = job ? jobsCell().gatePanel(board.db, job.id, { workerAlive: () => handoffWorkerAlive(board, job) }) : null;
    // The landed-from-main reader lives in the roadmap barrel, which loads only with landing.landedFromMain on, so a cold show reaches the barrel only when it calls it [C7,#11918].
    const onMain = ctx.config?.landing?.landedFromMain === true ? (await import('../../../../../packages/roadmap/index.js')).landedOnMain(ctx.info.root, ctx.config) : null;
    const result = { item, queuedSubmit, queuedJobId: job?.id ?? null, gateText: panel?.text ?? null, machine: machineVerification(board, item), progress: itemProgress(board, id, { onMain }), independence: reviewEligibility(board, item, { policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family }), verdicts: store.verdictsFor(board, id), thread: store.itemThread(board, id),
      proofReceipts: store.proofReceipts(board, id),
      approval: specApprovalState(ctx.info.root, { board, config: ctx.config, ids: itemSpecIds(item) }, { store, verifiedPasskeyRowDecision }), cost: itemCost(board, id, prices) };
    // JSON retains every public detail field; text-only labels and related-item searches add nothing to it. It also names
    // the newest gate job and, once done, its receipt's gate: a pulled gate keeps no hand-off record to read instead [C7].
    // The full store loads only when this board keeps its runs in a runs file: the light store has no runs reader [B2,#9013].
    const runsOn = (() => { try { return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('runs_store')?.meta_value === '1'; } catch { return false; } })();
    const runs = runsOn ? (await import('../../../../../packages/store/index.js')).boardRunsReader(board, ctx.file) : null;
    const gateJob = newestGateJob(board.db, id, result.proofReceipts, { runs });
    if (values.json) return { ...result, gateJob, fields, links };
    result.foreign = await foreignStates(board, item, async () => (await import('../../../../../packages/store/index.js')).foreignDependencyStates);
    const history = store.events(board, { itemId: id });
    return { ...result, gateJob, fields, links, moves: history.filter((event) => ['attempt', 'escalate'].includes(event.event_kind)),
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
    io.result({ ...item, ...(fields.length ? { fields } : {}), ...(links.length ? { relatedLinks: links } : {}), progress, machineVerification: machine, ...(comparison ? { comparison } : {}), ...(queuedSubmit ? { queuedSubmit } : {}), ...(gateJob ? { gateJob } : {}), reviewEligibility: independence, checkText, verdicts, thread, ...(proofReceipts.length ? { proofReceipts } : {}), ...(item.landing_phases || item.landing_exact_tree ? { landing: { ...(item.landing_phases ? { phases: item.landing_phases } : {}), ...(item.landing_exact_tree ? { exactTree: item.landing_exact_tree } : {}) } } : {}), agentApproved, approvalQualification, ...(cost.models.length || cost.shared ? { usage: localUsage(cost, publicUsage) } : {}), ...(relayPending.length ? { relayPending } : {}) });
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
  const core = coreLines(item, { itemLine: itemLine(item, agentName, Boolean(mainMerge), foreign, ctx.clock.now()), checkText });
  io.say(core.item);
  if (item.item_gate_runner === 'none') io.say(`next: pullboard runner local, or pullboard submit ${item.item_id} again`);
  if (item.item_status === 'claimed' && item.item_owner === callerId) {
    // A seat builds in its item folder, never its seat checkout: naming "this checkout" sent builders to commit item work there (#3691).
    const seatPath = agents.find((agent) => agent.agent_id === callerId)?.agent_path;
    io.say(seatPath
      ? `you hold #${item.item_id}; build and commit in its item folder ${itemFolderPath(seatPath, item.item_id)}, then run pullboard submit ${item.item_id} there`
      : `you hold #${item.item_id}; continue building in this checkout, then run pullboard submit ${item.item_id}`);
  }
  io.say(progressLine(progress));
  if (core.expectedBuild) io.say(core.expectedBuild);
  if (comparison) io.say(renderVerificationComparison(comparison));
  const review = reviewLines(machine, independence);
  io.say(review.machine);
  for (const line of queuedGateLines(queuedSubmit, gateText)) io.say(line);
  for (const line of pulledRedLines(gateJob, item)) io.say(line);
  for (const line of pulledWaitingLines(gateJob, item, thread)) io.say(line);
  for (const line of queueWaitLines(gateJob)) io.say(line);
  // A finished red gate keeps its full log while the item is open; its failing assertions print here [C7,#3381].
  if (queuedJobId && queuedSubmit && !['queued', 'running', 'green'].includes(queuedSubmit.state) && queuedSubmit.gateGreen !== true) {
    // The gate cell loads only for a finished red gate or a recorded check baseline: a plain read never pays for it [C7].
    const { retainedGateAssertions } = await import('../../../../../packages/gate/heavy.js');
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
  if (item.item_verdict_state) io.say(staleVerdictRefusal(item, item.item_verdict_state, { composeAsObject: submitComposeAsObject() }).message);
  io.say(review.tier);
  io.say(review.eligible);
  for (const line of review.parents) io.say(line);
  const usage = usageLine(cost, { detail: values.detail, dollars: dollarText(cost) });
  if (usage) io.say(usage);
  if (core.criterion) io.say(core.criterion);
  for (const line of core.check) io.say(line);
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
  if (item.item_check_baseline) (await import('../../../../../packages/gate/heavy.js')).sayCheckBaseline(io, item, { runnerLive: (await import('../runner/local.js')).anyRunnerLive() });
  for (const failure of item.main_red_failure_lines ?? []) io.say(`main red: ${failure.name}: ${failure.firstError}`);
  for (const line of fieldLines(fields, links)) io.say(line);
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
  const tail = tailLines(item, { builderName: agentName(item.item_built_by), reviewerName: reviewer ? agentName(reviewer) : null, infra });
  for (const line of tail.before) io.say(line);
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
  if (tail.mergedAs) io.say(tail.mergedAs);
  for (const line of landingPhaseLines(item.landing_phases)) io.say(line);
  if (item.landing_exact_tree) io.say(exactTreeLine(item.landing_exact_tree));
  if (tail.withdrawn) io.say(tail.withdrawn);
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
