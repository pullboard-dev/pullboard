/** Read the same derived snapshot for the CLI, briefing and view, without warming it [R1,R2]. */
import { CAPACITY_VERSION } from './capacity-counter.js';
import { planCapacity } from './capacity-model.js';
import { currentProofCounters } from './proof-counters.js';
import { proofCounter } from './proof-counters.js';

const STALE_MS = 30 * 60_000;

/** Re-judge a snapshot's staleness at the moment it is served, so a cached build never reports itself fresher than it is. */
export function capacityAtRead(snapshot, now = Date.now()) {
  return { ...snapshot, stale: snapshot.stale === true || !snapshot.asOf || now > Date.parse(snapshot.asOf) + STALE_MS };
}

/** Distinguish an unavailable migration from a measured empty board; never scan raw history here. */
export function readCapacity(board, now = Date.now()) {
  const ordinary = currentProofCounters(board);
  const summary = proofCounter(board, 'capacity-summary');
  const cached = proofCounter(board, 'capacity-snapshot');
  if (ordinary && summary?.version === CAPACITY_VERSION && !summary.invalid && summary.last === ordinary.last && cached) {
    return capacityAtRead(cached, now);
  }
  const missing = planCapacity({ items: [], now, sequence: ordinary?.last, simulate: false });
  return { ...missing, available: false, asOf: null, needsYou: null, workHours: null, tInfinityHours: null,
    bounds: { criticalPathHours: null, stragglerHours: null, landingHours: null }, curve: [],
    monteCarlo: { replicates: 100, completed: 0, nonFinishing: 0, asOf: null, sequence: null },
    agents: { recommended: null, lower: null, upper: null }, finishHours: { lower: null, upper: null },
    binding: { kind: 'unknown', text: 'Capacity measurements are not current.' },
    lever: { kind: 'measure', text: 'An ordinary board write rebuilds the local capacity index.' },
    unknown: ['capacity index is missing, incompatible or behind the board'], stale: true };
}
