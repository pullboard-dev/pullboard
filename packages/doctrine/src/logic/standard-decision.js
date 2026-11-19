/** The DOCTRINE.md row line a person's decision on a standard doctrine default projects [C7,#2007]. */
/** An error carrying the rule code the wiring maps to a refusal. */
function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * The row line for deciding `row`, a standard doctrine row: approve keeps its text and tier under status approved;
 * decline writes `- <id> [wont] <reason>`, and a decline without a reason throws an error with `code`
 * DECLINE_NEEDS_REASON and the message composing doctrine uses (this pure file imports no other cell, so the wiring turns it into a refusal).
 *
 * @param {{ id: string, text: string, tier?: string }} row - The standard row decided on.
 * @param {{ decision: 'approve' | 'decline', reason?: string }} choice - The person's decision and, for a decline, why.
 * @returns {string} The row line to write into the repo's doctrine file.
 */
export function standardDecisionLine(row, { decision, reason = '' }) {
  if (decision === 'approve') return `- ${row.id} [approved${row.tier ? `, ${row.tier}` : ''}] ${row.text}`;
  if (decision !== 'decline') throw coded('BAD_DECISION', `a decision is approve or decline, not ${String(decision)}; pass one of them`);
  const why = String(reason ?? '').trim();
  if (!why) throw coded('DECLINE_NEEDS_REASON', 'declining a standard rule needs a reason in its text: - PB2 [wont] <why>');
  return `- ${row.id} [wont] ${why}`;
}
