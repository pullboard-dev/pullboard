/** The review lines `pullboard show` prints: machine verification, review tier, eligible reviewers and builder parents, kept pure so a thin door can print them without the heavy readers [C7]. */

/**
 * The review section's printed lines, in the order show prints them (other sections sit between the machine line and the tier line, so each comes back named).
 *
 * @param {any} machine whether machine verification is on for the item
 * @param {{ tier: string, requiredFamily?: string, ready?: boolean, eligible?: string[], authorParents?: { parent: string, seats: string[] }[] }} independence the item's review independence
 * @returns {{ machine: string, tier: string, eligible: string, parents: string[] }}
 */
export function reviewLines(machine, independence) {
  return {
    machine: `machine-verified: ${machine ? 'on (frozen commands; strict and sensitive changes require review)' : 'off'}`,
    tier: `review tier: ${independence.tier}${independence.requiredFamily ? `; required family ${independence.requiredFamily}` : ''}`,
    eligible: `eligible reviewers: ${independence.ready ? independence.eligible.join(', ') || 'none' : 'not submitted'}`,
    // One line per builder parent session: the reason a seat under it is not offered the review, with no coordinator fact [V1,B3,C7].
    parents: (independence.authorParents ?? []).map(({ parent, seats }) => parent === 'unknown'
      ? `builder parent session: unknown (${seats.join(', ')}); no seat is excluded by parent`
      : `builder parent session ${parent} (${seats.join(', ')}): seats under this parent are not offered the review`),
  };
}
