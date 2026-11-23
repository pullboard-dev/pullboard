/** Read small proof aggregates and projected facts without replaying the native event log [R1,R2]. */
import { caughtFrom } from '../../../../items/index.js';
import { decodedProofEvent } from '../../../../kernel/index.js';
import { proofCounter } from './counters.js';
import { currentProofCounters } from './counters.js';
import { proofCounterRows } from './counters.js';
import { eachProofCounterRow } from './counters.js';
import { barStats } from '../../../../stats/light.js';
import { projectFlowStats } from '../../../../stats/light.js';
import { proofAgentIds } from '../../../../stats/light.js';

/**
 * Fold per-event facts one at a time into the selected window's counters and the attributed actors, which equal a sort
 * of every fact: the first and last dates break ties by the order the facts were recorded in. Why: holding every fact
 * at once was about 200 MB on a 770k-event board [C7,#13010].
 */
function factFold(boundary, seats) {
  const start = boundary ? Date.parse(boundary) : null;
  let submissions = 0, rejections = 0, first = null, last = null;
  const merged = new Set();
  const anomalies = new Set();
  const actors = new Map();
  const families = new Map();
  /** Count one fact; `order` is its place in recorded order. */
  const visit = (row, order) => {
    if (boundary && row.at >= start) {
      if (row.submitted) submissions += 1;
      if (row.rejected) rejections += 1;
      if (row.merged) merged.add(row.item);
      if (row.merged && row.anomaly) anomalies.add(row.item);
      const time = Date.parse(row.date);
      if (!first || time < first.time || time === first.time && order < first.order) first = { time, order, date: row.date };
      if (!last || time > last.time || time === last.time && order > last.order) last = { time, order, date: row.date };
    }
    if (boundary && row.at < start || !seats.has(row.by)) return;
    if (!actors.has(row.by)) actors.set(row.by, { id: row.by, moves: 0, families: new Set() });
    const actor = actors.get(row.by); actor.moves += 1; actor.families.add(row.family);
    if (!families.has(row.family)) families.set(row.family, { name: row.family, moves: 0, agents: new Set() });
    const family = families.get(row.family); family.moves += 1; family.agents.add(row.by);
  };
  /** The selected window's counters, the way a filter of every fact counted them. */
  const counts = () => ({ since: boundary, submissions, rejections, merged: merged.size, mergedWithoutAccept: anomalies.size,
    firstEventAt: first?.date ?? null, lastEventAt: last?.date ?? null });
  /** The attributed agents and families, sorted. */
  const attributed = () => ({ agents: [...actors.values()].map(actor => ({ ...actor, families: [...actor.families].sort() })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    families: [...families.values()].map(family => ({ ...family, agents: family.agents.size })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) });
  return { visit, counts, attributed };
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
  const seats = proofAgentIds(board);
  const fold = factFold(boundary, seats);
  eachProofCounterRow(board, 'event', fold.visit);
  const counts = boundary ? fold.counts() : {
    since: null, submissions: summary.submissions, rejections: summary.rejections, merged: summary.merged,
    mergedWithoutAccept: summary.mergedWithoutAccept, firstEventAt: summary.firstEventAt, lastEventAt: summary.lastEventAt,
  };
  counts.rejectionShare = counts.submissions ? counts.rejections / counts.submissions : 0;
  const attributed = fold.attributed();
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
