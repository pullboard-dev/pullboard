/** Wall-clock case budgets charged for runner load per core, the same rule the file budgets use [C7]. */
import { availableParallelism } from 'node:os';
import { loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';
import { testFileLoadScale } from '../../../../packages/gate/heavy.js';

/**
 * Start a clock; calling the returned stop function gives the wall time, the runner load scale over the span and the
 * charged time (wall divided by scale).
 * Why: a runner runs many jobs at once, so a case that needs 300 ms alone takes 600 ms beside them; dividing by the
 * measured one-minute load per core (testFileLoadScale, at most 4x) keeps the budget number and charges the case for
 * its own work, idle runner or busy (#6525, #4944).
 *
 * @returns {() => { wall: number, scale: number, ms: number }}
 */
export function loadClock() {
  const loads = [loadavg()[0]];
  const started = performance.now();
  return () => {
    const wall = performance.now() - started;
    loads.push(loadavg()[0]);
    const scale = testFileLoadScale(loads, availableParallelism());
    return { wall, scale, ms: wall / scale };
  };
}

/** Describe one charged measurement for an assertion message: its own time, and the wall time when load scaled it. */
export function chargedText({ wall, scale, ms }) {
  return scale > 1 ? `${Math.round(ms)} ms of its own (${Math.round(wall)} ms wall at runner load ${scale.toFixed(1)}x)` : `${Math.round(ms)} ms`;
}
