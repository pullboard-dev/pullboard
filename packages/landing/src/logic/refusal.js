/**
 * Which landing refusals are the candidate's own, judged from code and message alone so the batch sizer in core and
 * the return step in shell agree. Why: a two-item batch blocked for one item's content (an unplaced generated file
 * made the worktree dirty) was adopted again every minute on 6 Nov, because the sizer saw a refusal with no red and
 * kept the batch at two, where no item is ever returned [C7,#2901,#2967].
 */
export const ITEM_REFUSALS = new Set(['LAND_HEADER', 'LAND_PLAN_UNPLACED', 'LAND_ENGINE_UNNUMBERED', 'LAND_COMPANION_MISSING', 'LAND_MODULE_PARSE', 'LAND_STATIC_RED', 'RATCHET_ROSE']);

/** True when a refusal code and message name the candidate's own content rather than the landing's machinery. */
export function itemRefusalText(code, message = '') {
  if (!code) return false;
  if (ITEM_REFUSALS.has(code)) return true;
  const text = String(message ?? '');
  // The CLI smoke naming the candidate's exit, documentation that cannot regenerate from the merged tree, a red
  // static check on the merged tree, a merge that leaves a generated file the cells plan does not place, or a red
  // pre-push gate on the landing tree.
  return (code === 'LAND_CLI_SMOKE' && /^(?:\[LAND_CLI_SMOKE\] )?the candidate's /u.test(text))
    || (code === 'LAND_MERGE' && /update-docs\.js failed in the merged tree/u.test(text))
    || (code === 'GATE_RED' && /static checks are red/u.test(text))
    || (code === 'LAND_DIRTY' && /placement failed for .*; repair the cells plan/u.test(text))
    // The pre-push hook ran the gate on the landing tree and it was red: the merged tree's red, as a landing gate red [C7,#6270].
    || (code === 'LAND_PUSH' && /pre-push: blocked[\s\S]*the gate is red/u.test(text));
}
