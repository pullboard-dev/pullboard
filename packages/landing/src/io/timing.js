/** Time one named phase of a landing batch and say its elapsed milliseconds, so a slow landing names its phase [C7,B3]. */
import { recordLandingSpan } from '../../../resources/index.js';

/** The landing step span each said phase records: the merge composes, the gate proves, the push publishes; static checks and CLI smoke keep their span names [C7]. */
const SPAN_PHASE = { merge: 'compose', gate: 'prove', 'lease check': 'lease check', push: 'publish', 'static checks': 'static', 'cli smoke': 'smoke' };

/** The line a timed phase says, and the test reads: the phase name and its milliseconds. */
export const PHASE_LINE = /^landing phase (merge|static checks|cli smoke|gate|runner wait|tests|lease check|push): (\d+) ms$/u;

/**
 * Run a phase and say how long it took, even when it throws, and record it as a landing step span.
 * Why: one 300 s hang ceiling hid which of merge, gate, guardian lease check and push ate the time.
 * @param {(line: string) => void} say
 * @param {'merge'|'static checks'|'cli smoke'|'gate'|'lease check'|'push'} name
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

/**
 * Say the two halves of a runner-run gate: the runner wait, from the gate job being queued to a runner claiming it, and
 * the tests, from that claim to the recorded gate result. Marks missing or out of order say nothing for that half.
 * Why: one gate phase hid whether a slow landing waited for a free runner or ran slow tests [C7,B3].
 * @param {(line: string) => void} say
 * @param {{ queuedAt?: number, claimedAt?: number, resultAt?: number } | null | undefined} marks - epoch ms
 * @returns {{ phase: 'runner wait'|'tests', ms: number }[]} the phases said, in order
 */
export function sayGateSplit(say, marks) {
  const mark = (name) => Number.isSafeInteger(marks?.[name]) ? marks[name] : null;
  const halves = [['runner wait', mark('queuedAt'), mark('claimedAt')], ['tests', mark('claimedAt'), mark('resultAt')]];
  const said = [];
  for (const [phase, from, to] of halves) {
    if (from === null || to === null || to < from) continue;
    say?.(`landing phase ${phase}: ${to - from} ms`);
    said.push({ phase, ms: to - from });
  }
  return said;
}
