/** Cut an over-budget item with a check into one child per clause; pure, the cli slice wires it into add [C7,#2539]. */

/** Split a criterion into its numbered clauses ("1. text [test] 2. text"); unnumbered text is one clause. */
export function criterionClauses(criterion = '') {
  const text = String(criterion).trim();
  const marks = [...text.matchAll(/(?:^|\s)(\d+)\.\s+/gu)];
  const starts = [];
  let next = 1;
  for (const mark of marks) if (Number(mark[1]) === next) { starts.push(mark); next += 1; }
  if (starts.length === 0) return text ? [text] : [];
  return starts.map((mark, index) => text.slice(mark.index + mark[0].length, starts[index + 1]?.index ?? text.length).trim());
}

/**
 * Cut an item whose expected minutes exceed the budget and that has a check: one child per clause, each inheriting the
 * check and sized at or under the budget. Over budget with no check is not cut: it gets a note asking for a check and its
 * route is unchanged. At or under the budget, or with no estimate, the item is returned unchanged.
 * @param {{criterion?: string, check?: string, route?: string, expectedMinutes?: number|null}} item
 * @param {number} budgetMinutes itemBuildBudgetMinutes
 * @returns {{item: object, children: object[], note: string|null}}
 */
export function cutItem(item, budgetMinutes = 30) {
  const expected = item.expectedMinutes;
  if (expected == null || expected <= budgetMinutes) return { item, children: [], note: null };
  if (!item.check) return { item, children: [], note: 'over the build budget with no check: add a check so it can be cut into one child per clause' };
  const clauses = criterionClauses(item.criterion);
  if (clauses.length < 2) return { item, children: [], note: 'over the build budget with a single clause: split the clause by hand' };
  const share = Math.min(budgetMinutes, Math.ceil(expected / clauses.length));
  const children = clauses.map((clause, index) => ({
    criterion: clause, check: item.check, route: item.route, expectedMinutes: share, clause: index + 1,
  }));
  return { item, children, note: null };
}
