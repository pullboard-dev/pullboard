/** Time one named phase of a landing batch and say its elapsed milliseconds, so a slow landing names its phase [C7,B3]. */
import { recordLandingSpan } from '../../../resources/index.js';

/** The landing step span each said phase records: the merge composes, the gate proves, the push publishes [C7]. */
const SPAN_PHASE = { merge: 'compose', gate: 'prove', 'lease check': 'lease check', push: 'publish' };

/** The line a timed phase says, and the test reads: the phase name and its milliseconds. */
export const PHASE_LINE = /^landing phase (merge|gate|lease check|push): (\d+) ms$/u;

/**
 * Run a phase and say how long it took, even when it throws, and record it as a landing step span.
 * Why: one 300 s hang ceiling hid which of merge, gate, guardian lease check and push ate the time.
 * @param {(line: string) => void} say
 * @param {'merge'|'gate'|'lease check'|'push'} name
 * @param {() => any} work
 * @returns {Promise<any>} whatever the work returns
 */
export async function timedPhase(say, name, work) {
  const start = Date.now();
  let failed = null;
  try { return await work(); }
  catch (error) { failed = error; throw error; }
  finally {
    say?.(`landing phase ${name}: ${Date.now() - start} ms`);
    recordLandingSpan({ phase: SPAN_PHASE[name] ?? name, start, ...(failed ? { outcome: 'failed', code: failed.code ?? failed.name ?? null } : {}) });
  }
}
