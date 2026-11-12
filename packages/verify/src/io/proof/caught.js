/** Read small proof aggregates and projected facts without replaying the native event log [R1,R2]. */
import { caughtFrom } from '../../../../items/index.js';
import { decodedProofEvent } from '../../../../kernel/index.js';
import { proofCounter } from './counters.js';
import { currentProofCounters } from './counters.js';
import { proofCounterRows } from './counters.js';
import { barStats } from '../../../../stats/light.js';
import { projectFlowStats } from '../../../../stats/light.js';
import { proofAgentIds } from '../../../../stats/light.js';

/** Assemble selected-window counters from timestamped contributions, not decoded native events. */
function windowCounts(facts, boundary) {
  const start = Date.parse(boundary);
  const selected = facts.filter(row => row.at >= start);
  const merged = new Set(selected.filter(row => row.merged).map(row => row.item));
  const anomalies = new Set(selected.filter(row => row.merged && row.anomaly).map(row => row.item));
  const dates = selected.map(row => row.date).sort((a, b) => Date.parse(a) - Date.parse(b));
  return { since: boundary, submissions: selected.filter(row => row.submitted).length,
    rejections: selected.filter(row => row.rejected).length, merged: merged.size, mergedWithoutAccept: anomalies.size,
    firstEventAt: dates[0] ?? null, lastEventAt: dates.at(-1) ?? null };
}

/** Attribute a date window using the family recorded at each move, including older declarations. */
function windowActors(facts, boundary, seats) {
  const actors = new Map();
  const families = new Map();
  for (const row of facts) {
    if (boundary && row.at < Date.parse(boundary) || !seats.has(row.by)) continue;
    if (!actors.has(row.by)) actors.set(row.by, { id: row.by, moves: 0, families: new Set() });
    const actor = actors.get(row.by); actor.moves += 1; actor.families.add(row.family);
    if (!families.has(row.family)) families.set(row.family, { name: row.family, moves: 0, agents: new Set() });
    const family = families.get(row.family); family.moves += 1; family.agents.add(row.by);
  }
  return { agents: [...actors.values()].map(actor => ({ ...actor, families: [...actor.families].sort() })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    families: [...families.values()].map(family => ({ ...family, agents: family.agents.size })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) };
}

/** Retain the independently specified ordinal reject/verdict pairing while decoding only catch shards. */
export function counterCaught(board, boundary) {
  if (!currentProofCounters(board)) return null;
  const history = proofCounterRows(board, 'catch').map(row => decodedProofEvent(row, row.detail));
  const verdicts = board.db.prepare('SELECT * FROM verdict ORDER BY verdict_id').all();
  return caughtFrom(history, verdicts, boundary);
}

/** Project observation-time queues from append-time item/actor facts, keeping clock expiry dynamic. */
export function counterProofStats(board, boundary, now) {
  const summary = currentProofCounters(board);
  if (!summary) return null;
  const items = proofCounterRows(board, 'item');
  const actors = proofCounterRows(board, 'actor');
  const facts = proofCounterRows(board, 'event');
  const seats = proofAgentIds(board);
  const counts = boundary ? windowCounts(facts, boundary) : {
    since: null, submissions: summary.submissions, rejections: summary.rejections, merged: summary.merged,
    mergedWithoutAccept: summary.mergedWithoutAccept, firstEventAt: summary.firstEventAt, lastEventAt: summary.lastEventAt,
  };
  counts.rejectionShare = counts.submissions ? counts.rejections / counts.submissions : 0;
  const attributed = windowActors(facts, boundary, seats);
  const creators = items.filter(item => item.creator !== undefined).map(item => ({ event_kind: 'add', item_id: item.id, event_by: item.creator }));
  const corrections = proofCounterRows(board, 'bar').map(row => decodedProofEvent({ ...row, event_kind: 'edit' }, row.detail));
  const verdicts = board.db.prepare('SELECT * FROM verdict ORDER BY verdict_id').all();
  const report = proofCounter(board, 'report-summary');
  const reportCurrent = report?.version === FLOW_REPORT_VERSION && !report.invalid && report.last === summary.last;
  const flow = { reportPolicy: reportCurrent ? proofCounter(board, 'report-policy') : null,
    ...(reportCurrent ? { reportItems: proofCounterRows(board, 'report-item') } : {}), items: items.filter(item => item.id !== null && item.id !== undefined).map(item => item.flow),
    actors: actors.filter(actor => seats.has(actor.id)).map(actor => actor.flow), dailyEvents: proofCounterRows(board, 'daily') };
  return { ...counts, agentCount: attributed.agents.length, familyCount: attributed.families.length, ...attributed,
    bars: barStats([...creators, ...corrections], verdicts, boundary), caught: counterCaught(board, boundary),
    flow: projectFlowStats(flow, boundary, now, counts) };
}
import { FLOW_REPORT_VERSION } from '../../../../stats/light.js';
