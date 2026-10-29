/** Deterministic allowance changes, never a gate on machine load or live diagnostic counts [C7]. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.js';

export const BOARD_HOLD_BASELINE = 'src/board-hold-baseline.json';

/** Read the committed source allowance separately from private machine observations. */
export function readBoardHoldBaseline(root) {
  return JSON.parse(readFileSync(root ? join(root, BOARD_HOLD_BASELINE) : new URL('./board-hold-baseline.json', import.meta.url), 'utf8'));
}

/** Require an explicit first observation, then refuse any increase or return to unmeasured. */
export function boardHoldBaselineProblems(current, previous) {
  const count = current?.allowancePerDay;
  if (current?.version !== 1 || count !== null && (!Number.isSafeInteger(count) || count < 0)) return ['invalid board hold allowance'];
  if (count === null) {
    if (current.observedDay !== null || current.fact !== null) return ['an unmeasured allowance has no observed day or fact'];
    return previous?.allowancePerDay != null ? ['a measured board hold allowance cannot return to unmeasured'] : [];
  }
  const day = current.observedDay;
  if (typeof day !== 'string' || !/^\d{4}-\d\d-\d\d$/u.test(day)
    || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day
    || typeof current.fact !== 'string' || !current.fact.trim()) return ['a measured allowance needs a full UTC day and its recorded fact'];
  if (!previous) return ['introduce an unmeasured baseline before recording its first full day'];
  return previous.allowancePerDay !== null && count > previous.allowancePerDay
    ? [`board hold allowance grew from ${previous.allowancePerDay} to ${count}; the ratchet only falls`] : [];
}

/** Preserve the lowest reachable allowance, so an unrelated child cannot hide an earlier increase. */
export function committedBoardHoldBaselineProblems(root) {
  const current = readBoardHoldBaseline(root);
  const refs = git(root, ['log', '--full-history', '--format=%H', 'HEAD', '--', BOARD_HOLD_BASELINE]).split('\n').filter(Boolean);
  const previous = [];
  for (const ref of refs) {
    try { previous.push(JSON.parse(git(root, ['show', `${ref}:${BOARD_HOLD_BASELINE}`]))); }
    catch (error) {
      if (git(root, ['ls-tree', ref, '--', BOARD_HOLD_BASELINE])) throw error;
    }
  }
  if (!previous.some(value => value.allowancePerDay === null)) previous.push(undefined);
  return [...new Set(previous.flatMap(value => boardHoldBaselineProblems(current, value)))];
}
