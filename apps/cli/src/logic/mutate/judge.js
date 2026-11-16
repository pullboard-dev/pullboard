/** The pure judge for the first mutation gate: a cell's score may not drop below its last measured score, kind by kind [C7,U148]. */

/** The code a drop is refused with. */
export const MUTATION_SCORE_DROP = 'MUTATION_SCORE_DROP';

/**
 * Compare a cell's new per-kind scores with its earlier measured ones. A kind refuses when its caught share is lower than before;
 * a kind with no earlier row, or an earlier row with nothing seeded, is never refused, since there is nothing measured to hold it to.
 * Why shares compare by cross-multiplication: it avoids float rounding, so an equal share never reads as a drop.
 *
 * @param {{kind: string, caught: number, seeded: number}[]} earlier the last measured rows, from score()
 * @param {{kind: string, caught: number, seeded: number}[]} now the new rows, from score()
 * @returns {{ok: boolean, problems: {code: string, kind: string, earlier: string, now: string}[]}} the judgement; ok when there is no problem
 */
export function judgeScoreDrop(earlier, now) {
  const before = new Map((earlier ?? []).map((row) => [row.kind, row]));
  const problems = [];
  for (const row of now ?? []) {
    const old = before.get(row.kind);
    if (!old || !(old.seeded > 0) || !(row.seeded > 0)) continue;
    if (row.caught * old.seeded < old.caught * row.seeded) {
      problems.push({ code: MUTATION_SCORE_DROP, kind: row.kind, earlier: `${old.caught}/${old.seeded}`, now: `${row.caught}/${row.seeded}` });
    }
  }
  return { ok: problems.length === 0, problems };
}
