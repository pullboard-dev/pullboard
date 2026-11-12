/** Read the same derived snapshot for the CLI, briefing and view, without warming it [R1,R2]. */
import { CAPACITY_VERSION } from '../logic/capacity/counter.js';
import { planCapacity } from '../logic/capacity/model.js';
import { machineBudgetState } from './cost.js';

const STALE_MS = 30 * 60_000;

/** Re-judge a snapshot's staleness at the moment it is served, so a cached build never reports itself fresher than it is. */
export function capacityAtRead(snapshot, now = Date.now()) {
  return { ...snapshot, stale: snapshot.stale === true || !snapshot.asOf || now > Date.parse(snapshot.asOf) + STALE_MS };
}

/**
 * Attach the board's spend against the machine budget, so every capacity report renders the same budget line [N2].
 * With no budget set, or settings that cannot be read, the report carries no budget and renders no budget line.
 */
function withBudget(planner, board, now) {
  const budget = machineBudgetState(board, now);
  return budget ? { ...planner, budget } : planner;
}

/** Distinguish an unavailable migration from a measured empty board; never scan raw history here. */
export function readCapacity(board, now = Date.now(), reads = board.nativePorts) {
  return withBudget(readPlannedCapacity(board, now, reads), board, now);
}

/** The capacity snapshot itself, current or marked unavailable. */
function readPlannedCapacity(board, now, reads) {
  const ordinary = reads.currentProofCounters(board);
  const summary = reads.proofCounter(board, 'capacity-summary');
  const cached = reads.proofCounter(board, 'capacity-snapshot');
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
