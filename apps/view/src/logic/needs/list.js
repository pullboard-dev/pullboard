/** Adapt the shared Needs-you calls to the cockpit's legacy row shape without changing ownership. */

/**
 * Turn the shared person-call projection into the rows rendered by the cockpit.
 * @param {Array<object>} personalNeeds - Calls returned by the shared needs builder.
 * @param {Array<object>} holds - Holds from the selected project.
 * @returns {Array<object|Array<unknown>>}
 */
export function needsEntries(personalNeeds, holds) {
  return personalNeeds.filter((row) => !['draft', 'rigor-draft', 'sentinel-draft', 'agent-approved'].includes(row.kind)).map((row) => {
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
