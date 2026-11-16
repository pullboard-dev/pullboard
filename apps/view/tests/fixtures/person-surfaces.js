/** Person-surface fixture: a detector for Pullboard internals in person text, and a board of every refusal [H23]. */

/** Each leak kind with the pattern that finds it; one table so a new kind is one row. */
const LEAKS = Object.freeze([
  ['bracketed code', /\[[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\]/u],
  ['shell command line', /(?:^|[\s`$])(?:\$ ?)?(?:pullboard|node|git|npm|npx|sh|bash)\s+[-\w./<]/u],
  ['token or key', /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|[A-Fa-f0-9]{40,}|[A-Za-z0-9+/_-]{32,}={0,2})\b/u],
  ['relay term', /\b(?:checkpoints?|outbox(?:es)?|digests?|leases?)\b/iu],
]);

/**
 * Find every Pullboard internal in a piece of person-facing text.
 * Why: the person never sees refusal codes, commands, secrets or relay words (H23); one detector keeps that check uniform.
 * @param {string} text
 * @returns {{kind: string, match: string}[]} Empty when the text is plain.
 */
export function personSurfaceLeaks(text) {
  const found = [];
  for (const [kind, pattern] of LEAKS) {
    const hit = pattern.exec(String(text ?? ''));
    if (hit) found.push({ kind, match: hit[0].trim() });
  }
  return found;
}

/**
 * Build the seeded board: one case per refusal in the catalog, never hand-listed.
 * Why: a person-surface check is only as wide as the refusals it is run over. The caller passes the catalog, so this fixture
 * imports no other cell.
 * @param {Record<string, string>} defaultSteps The catalog of refusal codes and their next steps.
 * @param {(step: string) => string} stepFor The step as the person is shown it.
 * @param {Record<string, string>} [steps] The catalog with the move steps added; defaults to `defaultSteps`.
 * @returns {{code: string, agentText: string, next: string}[]} Agent-facing text keeps its code; `next` is the catalog step.
 */
export function seededPersonBoard(defaultSteps, stepFor, steps = defaultSteps) {
  return Object.keys(defaultSteps).map((code) => ({ code, agentText: `[${code}] refused for the fixture`, next: stepFor(steps[code]) }));
}
