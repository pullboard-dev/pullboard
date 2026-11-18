/** The returned items that need a person's judgement: a wall or a decision, with the reason, latest refusal and attempts [C7,#2220]. */

/** The stop reasons only a person's judgement moves; abandoned, rework and blocked items go back to a builder or wait. */
const JUDGEMENT = new Set(['wall', 'decision']);

/**
 * Keep each returned item whose stop reason is wall or decision, as { id, reason, refusalText, attempts } in the order
 * given; omit abandoned, rework and blocked items. Why: those need no ruling, and a list that mixed them in would hide the
 * few items a person must look at [C7,#2220].
 * @param {{ id: number, reason: string, refusalText?: string, attempts?: number }[]} returned
 * @returns {{ id: number, reason: string, refusalText: string, attempts: number }[]}
 */
export function needsJudgement(returned) {
  return returned
    .filter(item => JUDGEMENT.has(item.reason))
    .map(({ id, reason, refusalText, attempts }) => ({ id, reason, refusalText: refusalText ?? '', attempts: Number.isInteger(attempts) ? attempts : 0 }));
}
