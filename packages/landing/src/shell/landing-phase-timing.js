/** Time one named phase of a landing batch and say its elapsed milliseconds, so a slow landing names its phase [C7,B3]. */

/** The line a timed phase says, and the test reads: the phase name and its milliseconds. */
export const PHASE_LINE = /^landing phase (merge|gate|lease check|push): (\d+) ms$/u;

/**
 * Run a phase and say how long it took, even when it throws.
 * Why: one 300 s hang ceiling hid which of merge, gate, guardian lease check and push ate the time.
 * @param {(line: string) => void} say
 * @param {'merge'|'gate'|'lease check'|'push'} name
 * @param {() => any} work
 * @returns {Promise<any>} whatever the work returns
 */
export async function timedPhase(say, name, work) {
  const start = Date.now();
  try { return await work(); }
  finally { say?.(`landing phase ${name}: ${Date.now() - start} ms`); }
}
