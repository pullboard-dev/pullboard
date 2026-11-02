/** Authored build estimates gate scope without inventing durations for historical items [N2,B3]. */
import { Refused } from '../../../kernel/index.js';

/** Require a positive finite number of minutes; null explicitly restores an unknown estimate. */
export function validateExpectedBuildMinutes(value) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Refused('BAD_BUILD_ESTIMATE', 'expected build time must be positive minutes or unknown; use --expected-minutes <minutes|unknown>');
  }
}

/** Parse the authored CLI value without silently treating empty or nonnumeric text as an estimate. */
export function parseExpectedBuildMinutes(value) {
  if (value === undefined) return undefined;
  if (value === 'unknown') return null;
  const minutes = typeof value === 'string' && value.trim() ? Number(value) : NaN;
  validateExpectedBuildMinutes(minutes);
  return minutes;
}

/** Refuse oversized build scope with an actionable parent/children cut, keeping unknown estimates explicit. */
export function expectedBuildProblem(item, budgetMinutes = 30) {
  if (typeof budgetMinutes !== 'number' || !Number.isFinite(budgetMinutes) || budgetMinutes <= 0) {
    return new Refused('BAD_BUILD_BUDGET', 'restore a positive itemBuildBudgetMinutes setting, then retry');
  }
  const expected = item.item_expected_build_minutes;
  if (expected == null || expected <= budgetMinutes) return null;
  return new Refused('ITEM_BUILD_BUDGET', `item #${item.item_id} expects ${expected} build minutes, above the ${budgetMinutes}-minute board budget`,
    `cut #${item.item_id} into a parent and children with --expected-minutes at or below ${budgetMinutes}; claim a child instead`);
}
