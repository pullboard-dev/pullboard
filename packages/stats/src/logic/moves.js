/** Separate recorded native moves from commands explicitly supplied by seats [R1,R2,C7]. */
import { Refused } from '../../../kernel/light.js';
import { pipelineLimit } from './pipeline.js';

const MOVES = new Set(['add', 'claim', 'renew', 'release', 'submit', 'reserve', 'accept', 'reject', 'reopen', 'merged', 'refreeze', 'withdraw']);
const COMMAND = /^[a-z][a-z-]*(?: [a-z][a-z-]*)?$/u;

/** Validate an explicit, argument-free command transcript; never discover or read provider sessions. */
export function moveTranscripts(document) {
  if (!document || document.version !== 1 || !Array.isArray(document.sessions)) {
    throw new Refused('USAGE', 'command transcripts need {"version":1,"sessions":[{"id":"session","item":1,"seat":"core-1","commands":["claim","show","submit"]}]}');
  }
  const ids = new Set();
  if (document.sessions.length > 10000) throw new Refused('USAGE', 'supply at most 10000 transcript sessions');
  return document.sessions.map(session => {
    if (!session || typeof session.id !== 'string' || !session.id || session.id.length > 200 || ids.has(session.id)
      || !Number.isSafeInteger(session.item) || session.item < 1 || typeof session.seat !== 'string' || !session.seat || session.seat.length > 200
      || !Array.isArray(session.commands) || session.commands.length > 10000
      || session.commands.some(command => typeof command !== 'string' || command.length > 80 || !COMMAND.test(command))) {
      throw new Refused('USAGE', 'each transcript needs a unique id, positive item, seat and bounded argument-free command names; never supply private prompts or credentials');
    }
    ids.add(session.id);
    return { id: session.id, item: session.item, seat: session.seat, commands: [...session.commands] };
  });
}

/** Count commands and adjacent repeated sequences only within each recorded independent trace. */
function summarize(traces, denominator) {
  const counts = new Map(), sequences = new Map();
  for (const commands of traces) {
    for (const command of commands) counts.set(command, (counts.get(command) ?? 0) + 1);
    for (const length of [2, 3]) for (let at = 0; at + length <= commands.length; at += 1) {
      const sequence = JSON.stringify(commands.slice(at, at + length));
      sequences.set(sequence, (sequences.get(sequence) ?? 0) + 1);
    }
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const ranked = entries => entries.sort((a, b) => b.count - a.count || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { count: total, perLandedItem: denominator ? total / denominator : null,
    byCommand: ranked([...counts].map(([command, count]) => ({ command, count, perLandedItem: denominator ? count / denominator : null }))),
    repeatedSequences: ranked([...sequences].filter(([, count]) => count > 1).map(([sequence, count]) => ({ commands: JSON.parse(sequence), count }))).slice(0, 20) };
}

/** Report last-N landed item moves and separately measured supplied commands, with missing coverage explicit. */
export function movesStats(history, { limit = 20, transcripts } = {}) {
  limit = pipelineLimit(limit);
  const ordered = [...history].sort((a, b) => a.event_id - b.event_id), landed = new Map();
  for (const event of ordered) if (event.event_kind === 'merged' && event.item_id != null) landed.set(event.item_id, event.event_id);
  const selected = new Map([...landed].sort((a, b) => b[1] - a[1]).slice(0, limit));
  const traces = new Map(), otherTraces = new Map();
  for (const event of ordered) {
    if (!selected.has(event.item_id) || event.event_id > selected.get(event.item_id)) continue;
    const rows = MOVES.has(event.event_kind) ? traces : otherTraces;
    const key = JSON.stringify([event.item_id, event.event_by]);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(event.event_kind);
  }
  const sessions = transcripts === undefined ? [] : moveTranscripts(transcripts);
  const supplied = sessions.filter(session => selected.has(session.item));
  const covered = new Set(supplied.map(session => session.item));
  const commands = summarize(supplied.map(session => session.commands), covered.size);
  const work = summarize([...otherTraces.values()], selected.size);
  return { version: 1, limit, landedItems: [...selected.keys()], count: selected.size,
    eventMoves: { ...summarize([...traces.values()], selected.size), includedKinds: [...MOVES], evidence: 'Native lifecycle move events, not CLI invocation counts: one command may emit several events; read-only and refused commands may emit none.' },
    otherEvents: { count: work.count, perLandedItem: work.perLandedItem,
      byKind: work.byCommand.map(({ command, ...row }) => ({ kind: command, ...row })),
      evidence: 'Item-scoped facts, proofs, usage and other non-lifecycle events are separate agent work, excluded from lifecycle moves and supplied commands.' },
    suppliedCommands: { ...commands, sessions: supplied.length, coveredItems: [...covered].sort((a, b) => a - b),
      unmeasuredItems: [...selected.keys()].filter(id => !covered.has(id)), ignoredSessions: sessions.length - supplied.length,
      evidence: 'Only explicitly supplied session commands; averages use covered landed items. Supplied sessions do not establish complete item coverage.' },
    polling: { status: supplied.length ? commands.byCommand.find(row => row.command === 'status')?.count ?? 0 : null,
      show: supplied.length ? commands.byCommand.find(row => row.command === 'show')?.count ?? 0 : null,
      repeated: commands.repeatedSequences.filter(row => row.commands.every(command => command === 'status' || command === 'show')),
      evidence: 'Recorded status/show calls and repeated read sequences; intent and unrecorded polling are unknown.' },
    numericTarget: null };
}

/** Render the measurement boundary alongside every human-readable count. */
export function movesLines(report) {
  const show = value => value === null ? 'unmeasured' : String(value);
  const lines = [`moves: last ${report.count} landed items (requested ${report.limit})`,
    `native event moves: ${report.eventMoves.count}; per landed item ${show(report.eventMoves.perLandedItem)}`, report.eventMoves.evidence];
  for (const row of report.eventMoves.byCommand) lines.push(`  event ${row.command}: ${row.count}; per landed item ${show(row.perLandedItem)}`);
  for (const row of report.eventMoves.repeatedSequences) lines.push(`  repeated event moves: ${row.commands.join(' → ')} (${row.count})`);
  lines.push(`other item events: ${report.otherEvents.count}; per landed item ${show(report.otherEvents.perLandedItem)}`, report.otherEvents.evidence);
  for (const row of report.otherEvents.byKind) lines.push(`  ${row.kind}: ${row.count}; per landed item ${show(row.perLandedItem)}`);
  lines.push(`supplied commands: ${report.suppliedCommands.sessions ? report.suppliedCommands.count : 'unmeasured'}; ${report.suppliedCommands.coveredItems.length} landed items with supplied sessions`, report.suppliedCommands.evidence);
  for (const row of report.suppliedCommands.byCommand) lines.push(`  command ${row.command}: ${row.count}; per covered landed item ${show(row.perLandedItem)}`);
  for (const row of report.suppliedCommands.repeatedSequences) lines.push(`  repeated commands: ${row.commands.join(' → ')} (${row.count})`);
  lines.push(`status/show polling candidates: status ${show(report.polling.status)}; show ${show(report.polling.show)}; ${report.polling.evidence}`);
  lines.push('numeric target: unmeasured; the trial target has not been frozen');
  return lines;
}
