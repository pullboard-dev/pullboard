/** Adapt the shared Needs-you calls to the cockpit's legacy row shape without changing ownership. */

/** What the person reads when a call's own words carry a code, command, token or relay term [C6,N26]. */
export const PLAIN_FALLBACK = Object.freeze({
  block: ['Pullboard stopped a request that only you can clear.', 'Ask your coordinator to take the next step.'],
  pending: [null, 'Answer it in the Spec tab.'],
  'relay-health': [null, 'Keep working; your moves wait here until the connection to your phone is back.'],
});
/** One pattern per leak kind: a bracketed or parenthesised code, a shell command line, a token or key, a relay term. */
export const LEAKS = [
  /\[[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\]|\([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\)/u,
  /(?:^|[\s`$])(?:\$ ?)?(?:pullboard|node|git|npm|npx|sh|bash)\s+[-\w./<]/u,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|[A-Fa-f0-9]{40,}|[A-Za-z0-9+/_-]{32,}={0,2})\b/u,
  /\b(?:checkpoints?|outbox(?:es)?|digests?|leases?)\b/iu,
];

/**
 * Give a call that is only the person's to read plain words: a leaking field is swapped for its fallback.
 * Why: the person never knows how Pullboard works (H23); agent-facing output keeps its codes elsewhere.
 * @param {object} row - One shared Needs-you call.
 * @returns {object} The same call, or a copy with plain text and step.
 */
export function plainNeedWords(row) {
  const fallback = PLAIN_FALLBACK[row.kind];
  if (!fallback) return row;
  const leaks = (text) => LEAKS.some((pattern) => pattern.test(String(text ?? '')));
  return { ...row, text: fallback[0] && leaks(row.text) ? fallback[0] : row.text, what: leaks(row.what) ? fallback[1] : row.what };
}

/**
 * Turn the shared person-call projection into the rows rendered by the cockpit.
 * @param {Array<object>} personalNeeds - Calls returned by the shared needs builder.
 * @param {Array<object>} holds - Holds from the selected project.
 * @returns {Array<object|Array<unknown>>}
 */
export function needsEntries(personalNeeds, holds) {
  return personalNeeds.filter((row) => !['draft', 'rigor-draft', 'sentinel-draft', 'agent-approved'].includes(row.kind)).map(plainNeedWords).map((row) => {
    if (row.kind === 'spec-revision') return { revision: row };
    if (row.kind === 'decision') return ['decide:' + row.id, row.ref, row.text, 'decide', row.at];
    if (row.kind === 'pending') return ['spec:' + row.id, row.ref, row.text, 'answer ' + row.ref];
    if (row.kind === 'block') return [null, row.ref, row.text, row.what, row.at, 'block'];
    if (row.kind === 'relay-health') return [null, row.ref, row.text, row.what, row.at, 'relay-health'];
    return ['tab:shouts', row.ref, row.text, row.what, holds.find((hold) => hold.hold_lane === row.id)?.hold_at];
  });
}

/**
 * Render each adapted Needs-you row with its established action, except a local relay alert is inspection-only.
 * @param {Function} needRow - The page's escaped standard Needs-you renderer.
 * @param {Function} specRevisionRow - The page's spec revision renderer.
 * @param {object|Array<unknown>} entry - One adapted Needs-you row.
 * @returns {string}
 */
export function renderNeedsRow(needRow, specRevisionRow, entry) {
  if (entry.revision) return specRevisionRow(entry.revision);
  if (entry[5] === 'block') return needRow(entry, entry[3], 'next step');
  if (entry[5] === 'relay-health') return needRow(entry, entry[3], 'inspect');
  if (entry[3] === 'decide') return needRow([entry[0], '', entry[2], entry[3], entry[4]], 'a decision, asked by ' + entry[1], 'decide');
  if (entry[0].startsWith('spec:')) return needRow(entry, 'an open question in SPEC.md', 'answer');
  return needRow(entry, entry[3], 'release');
}
