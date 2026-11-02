/** Classify tracked test inputs by their first owned production dependencies [C7,CD64]. */

/** Build deterministic ownership for old paths, moved bodies, and existing cell roots. */
function cellFor(file, plan) {
  for (const cell of plan.cells) {
    if (cell.paths.some(([old, moved]) => file === old || file === moved)) return cell.name;
  }
  return plan.cells.find(cell => file.startsWith(`${cell.root}/`))?.name ?? null;
}

/** Test helpers are traversed; the first production cell stops each branch of the graph. */
function classify(file, inventory, plan) {
  if (!/\.[cm]?js$/u.test(file)) return { file, kind: 'undecidable', reason: 'not a JavaScript module' };
  if (!inventory.files.has(file)) return { file, kind: 'undecidable', reason: 'tracked file is unavailable or not regular' };
  const pending = [file], seen = new Set(), cells = new Set(), reasons = new Set();
  const unknown = new Map();
  for (const row of inventory.unknown) {
    const rows = unknown.get(row.file) ?? [];
    rows.push(row.reason); unknown.set(row.file, rows);
  }
  while (pending.length) {
    const current = pending.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const reason of unknown.get(current) ?? []) reasons.add(reason);
    for (const edge of inventory.edges.get(current) ?? []) {
      const target = edge.target;
      if (!inventory.files.has(target)) { reasons.add(`missing input ${target}`); continue; }
      const testInput = target.startsWith('test/') || /^docs\/.*\.test\.[cm]?js$/u.test(target);
      if (testInput) pending.push(target);
      else {
        const owner = cellFor(target, plan);
        if (owner) cells.add(owner);
        else reasons.add(`unowned input ${target}`);
      }
    }
  }
  const ordered = [...cells].sort();
  if (reasons.size) return { file, kind: 'undecidable', reason: [...reasons].sort().join('; '), cells: ordered };
  if (ordered.length === 1) return { file, kind: 'cell', cell: ordered[0] };
  if (ordered.length > 1) return { file, kind: 'journey', cells: ordered };
  return { file, kind: 'undecidable', reason: 'no owned production dependency' };
}

/** Classify every supplied tracked test/ path and docs test in stable path order. */
export function classifyTestFiles(tracked, inventory, plan) {
  return [...new Set(tracked)].filter(file => file.startsWith('test/') || /^docs\/.*\.test\.[cm]?js$/u.test(file))
    .sort().map(file => classify(file, inventory, plan));
}
