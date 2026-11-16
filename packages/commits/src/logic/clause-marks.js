/**
 * Clause marks: the numbered clauses of a frozen bar, each with whether a tick covers it [C7].
 * Pure: it reads only its arguments. Why: a submit shows the builder every clause beside its evidence before the gate
 * queues, so a missed clause is caught before a reviewer reads it.
 */

/** A numbered clause starts a line or the text as `<n>. `. */
const NUMBERED = /(?:^|\n)\s*(\d+)\.\s+/gu;

/**
 * Split a criterion into its numbered clauses, in the order written; text with no numbering is one clause.
 *
 * @param {string | null | undefined} criterion
 * @returns {{ number: number, text: string }[]}
 */
function splitClauses(criterion) {
  const text = String(criterion ?? '').normalize('NFC');
  const heads = [...text.matchAll(NUMBERED)];
  if (!heads.length) return text.trim() ? [{ number: 1, text: text.replace(/\s+/gu, ' ').trim() }] : [];
  return heads.map((head, index) => ({
    number: Number(head[1]),
    text: text.slice(head.index + head[0].length, heads[index + 1]?.index ?? text.length).replace(/\s+/gu, ' ').trim(),
  }));
}

/**
 * One mark per clause of the criterion: its number, text, whether it is ticked and the evidence the tick carries.
 * A tick is a clause number or `{ clause, evidence }`; with no ticks every clause comes back unmarked.
 *
 * @param {string | null | undefined} criterion - the frozen bar
 * @param {(number | { clause: number, evidence?: string })[] | null | undefined} ticks
 * @returns {{ number: number, text: string, ticked: boolean, evidence: string | null }[]}
 */
export function clauseMarks(criterion, ticks) {
  const given = new Map();
  for (const tick of ticks ?? []) {
    const number = Number(typeof tick === 'object' && tick !== null ? tick.clause : tick);
    if (!Number.isInteger(number)) continue;
    const evidence = typeof tick === 'object' && tick !== null ? String(tick.evidence ?? '').replace(/\s+/gu, ' ').trim() : '';
    given.set(number, evidence || given.get(number) || '');
  }
  return splitClauses(criterion).map(clause => ({
    ...clause,
    ticked: given.has(clause.number),
    evidence: given.get(clause.number) || null,
  }));
}
