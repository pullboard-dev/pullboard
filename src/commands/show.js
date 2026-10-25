import { withBoardRead } from '../cli-board-read.js';
import {
  testRuntimeEnvironment,
  testRuntimeRows,
} from '../execution-environment.js';
/** The pullboard show command, in its own module so an item adding another command never edits these lines. */
import {
  displayAgentName,
} from '../agent-names.js';
import {
  barCorrectionLine,
  barCorrections,
} from '../bar-corrections.js';
import * as store from '../board-query.js';
import {
  agentApprovalLine,
  itemAgentApprovals,
  specApprovalState,
} from '../spec-approval.js';
import {
  sayCheckBaseline,
} from '../check-baseline-format.js';
import * as infraNotes from '../infra-note.js';
import {
  mainMergeFor,
  mainMergeLines,
} from '../trunk-conflict.js';
import {
  staleVerdictRefusal,
  verdictProjector,
} from '../verdict-freshness.js';
import {
  agentDisplayName,
  context,
  firstLineOf,
  idArg,
  itemLine,
  sayBrief,
} from '../cli-read-context.js';
import { relayStateExists } from '../local-state.js';

/** Run `pullboard show` and return its exit code. */
export async function run(io, { first, values }) {
  const ctx = context(io);
  const id = idArg(first);
  const { item, verdicts, moves, thread, related, reviewer, agents, mainMerge, infra, approval, proofReceipts } = await withBoardRead(ctx, (board) => {
    const item = verdictProjector(ctx.info.root, board).project(store.getItem(board, id));
    const result = { item, verdicts: store.verdictsFor(board, id), thread: store.itemThread(board, id),
      proofReceipts: store.proofReceipts(board, id),
      approval: specApprovalState(ctx.info.root, { board, config: ctx.config }) };
    // JSON retains every public detail field; text-only labels and related-item searches add nothing to it.
    if (values.json) return result;
    const history = store.events(board, { itemId: id });
    return { ...result, moves: history.filter((event) => ['attempt', 'escalate'].includes(event.event_kind)),
      related: store.relatedItems(board, item), reviewer: store.reviewHolder(board, item),
      agents: store.listAgents(board), mainMerge: mainMergeFor(board, id), infra: infraNotes.infraNoteOf(history) };
  });

  const agentApproved = itemAgentApprovals(item, approval);
  const approvalQualification = agentApprovalLine(agentApproved);
  // #922: moves on this item made while the relay was down wait in this machine's relay outbox until it answers.
  // Without a relay link or deleted-copy notice there is no outbox to read, so the relay client never loads.
  const outbox = relayStateExists(ctx.info.commonDir) ? (await import('../relay.js')).relayStatus(ctx.info.root).outbox : undefined;
  const relayPending = (outbox ?? []).filter((move) => move.item === id);
  const frozen = item.item_frozen ? JSON.parse(item.item_frozen) : null;
  const checkText = frozen ? frozen.check ?? '' : item.item_check ?? '';
  if (values.json) {
    io.result({ ...item, checkText, verdicts, thread, ...(proofReceipts.length ? { proofReceipts } : {}), agentApproved, approvalQualification, ...(relayPending.length ? { relayPending } : {}) });
    return 0;
  }
  const agentName = (id) => displayAgentName(agents.find((agent) => agent.agent_id === id) ?? { agent_id: id }, ctx.config.agents.names);
  io.say(itemLine(item, agentName, Boolean(mainMerge)));
  if (item.item_status === 'verified' && approvalQualification) io.say(approvalQualification);
  if (item.item_verdict_state) io.say(staleVerdictRefusal(item, item.item_verdict_state).message);
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
    const counts = Object.values(receipt.counts).some(value => value === null) ? 'test counts unknown'
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
  sayCheckBaseline(io, item);
  sayBrief(io, item.item_brief);
  for (const move of relayPending) io.say(`pending in the relay outbox: ${move.operation}${move.actor ? ` by ${move.actor}` : ''} (made ${move.queuedAt}); it goes up in order when the relay answers`);
  for (const { item: other, shared } of related) {
    io.say(`related: #${other.item_id} ${other.item_title}: ${shared.slice(0, 4).join(', ')}${shared.length > 4 ? ', ...' : ''} (git log -p -1 ${other.item_commit.slice(0, 12)} -- ${shared[0]})`);
  }
  const attempts = moves.filter((event) => event.event_kind === 'attempt').map((event) => JSON.parse(event.event_detail).result);
  if (attempts.length) io.say(`unattended attempts: ${attempts.join(', ')}`);
  for (const event of moves.filter((entry) => entry.event_kind === 'escalate')) {
    const detail = JSON.parse(event.event_detail);
    io.say(`escalated ${detail.from} -> ${detail.to} by ${agentName(event.event_by)}${detail.attempt ? `, pinned at ${detail.attempt}` : ''}: ${detail.note.split('\n')[0]}`);
  }
  if (frozen) {
    io.say(`frozen at claim (${item.item_frozen_digest.slice(0, 12)}):`);
    frozen.rows.forEach((row) => io.say(`  ${row.id}: ${row.text}${row.gate ? `  | gate: ${row.gate}` : ''}`));
  }
  if (item.item_commit) io.say(`submitted by ${agentName(item.item_built_by)}${item.item_builder_family ? ` [family ${item.item_builder_family}]` : ''} at ${item.item_commit}`);
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
      io.say(`${stamp}${entry.kind}${detail.commit ? ' at ' + detail.commit : ''}${detail.reason ? ': ' + detail.reason : ''}${detail.note ? `: ${detail.note}` : ''}`);
    }
  }
  return 0;
}
