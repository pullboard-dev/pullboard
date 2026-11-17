/** Which accepted items may gate in parallel: pure, no I/O, used only behind landing.parallelGates [B3,C7]. */

/** Whether two items share a changed file or an affected test. */
function overlaps(a, b) {
  const files = new Set(a.files ?? []);
  const tests = new Set(a.tests ?? []);
  return (b.files ?? []).some(file => files.has(file)) || (b.tests ?? []).some(test => tests.has(test));
}

/**
 * Group items (`{ id, files, tests }`, in accept order) so no two items in a group touch the same file or affected test.
 * Each item joins the first group it does not overlap, so the same input always gives the same groups in the same order.
 */
export function parallelGatePlan(items) {
  const groups = [];
  for (const item of items) {
    const group = groups.find(members => members.every(member => !overlaps(member, item)));
    if (group) group.push(item); else groups.push([item]);
  }
  return groups.map(members => members.map(member => member.id));
}
