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

/** Name a classified row's home: its cell, its journey's cells, or why it is unknown. */
function home(row) {
  if (row.kind === 'cell') return `cell ${row.cell}`;
  if (row.kind === 'journey') return `journey ${row.cells.join(',')}`;
  return `unknown ${row.reason}`;
}

/** Compare two strings by code unit so the report never depends on the locale. */
function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Render the --place-tests report: one line per test file or docs check with its home, in path order,
 * then how many files each plan cell gets (zero included), the journey count and the unknown count [C7,CD64].
 */
export function placementReport(rows, cellNames = []) {
  const lines = [...rows].sort((a, b) => byCodeUnit(a.file, b.file)).map(row => `${row.file}\t${home(row)}`);
  const perCell = new Map([...new Set(cellNames)].map(name => [name, 0]));
  for (const row of rows) if (row.kind === 'cell') perCell.set(row.cell, (perCell.get(row.cell) ?? 0) + 1);
  for (const [name, count] of [...perCell].sort(([a], [b]) => byCodeUnit(a, b))) lines.push(`files for cell ${name}: ${count}`);
  lines.push(`journeys: ${rows.filter(row => row.kind === 'journey').length}`);
  lines.push(`unknown: ${rows.filter(row => row.kind !== 'cell' && row.kind !== 'journey').length}`);
  lines.push(`total: ${rows.length}`);
  return lines;
}

/** Classify every tracked test file and docs check in a checkout and render the placement report. */
export function placeTests(tracked, inventory, plan) {
  return placementReport(classifyTestFiles(tracked, inventory, plan), plan.cells.map(cell => cell.name));
}
