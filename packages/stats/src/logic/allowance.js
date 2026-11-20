/** A seat's allowance as the one warning line the coordinator surfaces print [C7]. */

/** The percent left at or under which a seat gets the warning line, and the lower one that makes it urgent. */
const WARN_AT = 20;
const URGENT_AT = 5;

/**
 * One line for a seat's allowance, or null when plenty is left.
 *
 * @param {{ known: boolean, percentLeft?: number, windowMinutes?: number, resetsAt?: string }} allowance what seatAllowance returns
 * @param {string} seat the seat's name
 * @returns {string | null} "warning:" from 20 percent down to above 5, "urgent:" at 5 or less, the unknown line without a reading, null above 20
 */
export function allowanceWarning(allowance, seat) {
  if (!allowance?.known) return `${seat} allowance: unknown`;
  const { percentLeft, resetsAt } = allowance;
  if (percentLeft > WARN_AT) return null;
  const level = percentLeft <= URGENT_AT ? 'urgent' : 'warning';
  return `${level}: ${seat} allowance ${percentLeft}% left, resets ${resetsAt}`;
}
