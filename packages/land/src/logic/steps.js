/** Pure reading of a landing batch's step log: the six finish steps in order and which one comes next [C7]. */

/** The landing batch's finish steps in order (RFC 0008 DJ11). */
export const FINISH_STEPS = Object.freeze(['select', 'compose', 'prove', 'merge', 'record', 'publish']);

/**
 * The payloads of the finish steps a landing's log already holds, by step name.
 *
 * Why: a resumed landing hands each later step what the earlier steps wrote, so it reads them from the log,
 * never from the process that wrote them.
 *
 * @param {{ steps: { name: string, payload: any }[] }} view - A jobView.
 * @returns {Record<string, any>}
 */
export function writtenSteps(view) {
  const written = {};
  for (const step of view.steps) if (FINISH_STEPS.includes(step.name) && !(step.name in written)) written[step.name] = step.payload;
  return written;
}

/**
 * The next finish step a landing owes, or null when every step is written.
 *
 * @param {{ steps: { name: string }[] }} view - A jobView.
 * @returns {string | null}
 */
export function nextFinishStep(view) {
  const written = writtenSteps(view);
  return FINISH_STEPS.find(name => !(name in written)) ?? null;
}
