import { testFile } from '../io/cell/lint/inventory.js';
import { mappedPath } from './path/map.js';
/** Plan startable import-cut work per importing cell without changing the accepted move order [C7,D3]. */
/** The board refuses a brief longer than this (item-routing.js); this cell sits below it, so it cannot import it. */
const BRIEF_LIMIT = 8000;

/** Preserve removed source provenance separately from active ownership, without aliasing its replacement. */
export function retiredRows(plan) {
  const rows = plan.retired ?? [];
  if (!Array.isArray(rows)) throw new Error('retired placements must be an array');
  const seen = new Set();
  for (const entry of rows) {
    const cell = plan.cells.find(value => value.name === entry?.cell);
    const row = entry?.row;
    if (!cell || !Array.isArray(row) || row.length !== 3 || !['seed', 'rule', 'imports'].includes(row[2])
      || row.slice(0, 2).some(path => typeof path !== 'string' || /[\\:\x00-\x1f\x7f]/u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..'))
      || !row[1].startsWith(`${cell.root}/`) || seen.has(row[0])
      || plan.cells.some(value => value.paths.some(active => active[0] === row[0]))) throw new Error('invalid or active retired historical placement');
    seen.add(row[0]);
  }
  return rows;
}

/** Stable identity for a cut item, independent of move numbering and board allocation. */
export function cutTitle(cell) { return `Cells import cuts: ${cell} removes imports into later cells`; }

/** Resolve one historical source identity only when its unique placement stayed put or moved lower. */
function historicalPlacement(plan, original, path) {
  const found = plan.cells.flatMap(cell => cell.paths.filter(row => row[0] === path).map(row => ({ cell, row })));
  const retired = retiredRows(plan).filter(entry => entry.cell === original.name && entry.row[0] === path);
  if (!found.length && retired.length === 1) return retired[0].row;
  return found.length === 1 && found[0].cell.order <= original.order ? found[0].row : null;
}

/** Group every recorded import occurrence by its importing cell; repeated imports remain distinct occurrences. */
export function importCuts(plan) {
  const cells = new Map(plan.cells.map(cell => [cell.name, cell]));
  const groups = new Map();
  for (const target of plan.cells) for (const link of target.cuts) {
    const importer = cells.get(link.cell);
    if (!importer || !/^(?:app:)?[a-z]+$/u.test(importer.name) || importer.order >= target.order) throw new Error('cut links must name an earlier importing cell');
    const group = groups.get(importer.name) ?? { cell: importer.name, order: importer.order, edges: [] };
    for (const [index, edge] of link.edges.entries()) {
      const [from, to, extra] = edge.split('->');
      const source = historicalPlacement(plan, importer, from), destination = historicalPlacement(plan, target, to);
      if (extra || !source || !destination) {
        throw new Error(`cut import is outside its named cells: ${edge}`);
      }
      group.edges.push({ id: `${importer.name}->${target.name}:${index}`, from, to, target: target.name,
        how: destination[1].includes('/src/logic/')
          ? 'move the shared pure definition below both cells, retaining the provider front door'
          : 'invert the dependency by passing the provider operation or state through an explicit caller-supplied port' });
    }
    groups.set(importer.name, group);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order).map(group => ({ ...group,
    files: [...new Set(group.edges.flatMap(edge => [edge.from, edge.to]))].sort(),
    targets: [...new Set(group.edges.map(edge => edge.target))],
  }));
}

/**
 * The brief for one cell's cuts, under the board's brief limit: every edge with its strategy when that fits, else
 * every edge with each strategy stated once, else a pointer to the full list that the item's own check prints.
 */
export function cutBrief(group, check) {
  const head = `Import-cut plan for ${group.cell}, from committed packages/codemap/data/plan/cells.json and its shards (#1593).`;
  // Labelled sections the routing check reads (Files:, Test:); Files comes last before Test so no prose lands inside it.
  const files = `Files:\n${group.files.map(file => `- ${file}`).join('\n')}`;
  const tail = `Test: ${check} passes. Add focused behavior regressions for changed ports or extracted definitions; the full suite remains mandatory.`;
  const full = `Imports to remove and implementation strategy (each recorded occurrence appears once):\n${group.edges.map(edge => `- [${edge.id}] ${edge.from} -> ${edge.to}: ${edge.how}`).join('\n')}`;
  const strategies = [...new Set(group.edges.map(edge => edge.how))];
  const compact = `Imports to remove (each recorded occurrence appears once; strategy by letter):\n${strategies.map((how, index) => `${String.fromCharCode(65 + index)}: ${how}`).join('\n')}\n${group.edges.map(edge => `- [${edge.id}] ${edge.from} -> ${edge.to} (${String.fromCharCode(65 + strategies.indexOf(edge.how))})`).join('\n')}`;
  const pointer = `Imports to remove: all ${group.edges.length} occurrences, each with its strategy, are printed by node packages/codemap/src/io/cells/scripts/plan.js --cuts ${group.cell}.`;
  for (const body of [[head, full, files, tail], [head, compact, files, tail], [head, pointer, files, tail], [head, pointer, tail]]) {
    const brief = body.join('\n\n');
    if (brief.length <= BRIEF_LIMIT) return brief;
  }
  throw new Error(`the ${group.cell} cut brief cannot fit the brief limit`);
}

/** Build independent add commands; no move-tooling dependency or implicit chain prevents disjoint cuts starting now. */
export function cutItemCommands(plan, ids = new Map()) {
  return importCuts(plan).filter(group => !ids.has(group.cell)).map(group => {
    const check = `node packages/codemap/src/io/cells/scripts/plan.js --cuts ${group.cell} && npm run gate`;
    const criterion = `Remove all ${group.edges.length} import occurrences listed below from ${group.cell} into its later cells. Apply each named lower-layer extraction or explicit port inversion without hiding the dependency in a shim or computed loader. The cut check and full suite pass on Node 22.13 and 24; preserve behavior, historical engine numbers and recorded events. No dependency on #1395 or any cell move is required. Coordinate any overlapping files before editing; items with disjoint file sets may run in parallel.`;
    const brief = cutBrief(group, check);
    return { group, args: ['add', 'core', cutTitle(group.cell), '--criterion', criterion,
      '--specs', 'C7,D3,doctrine:CD64', '--check', check, '--brief', brief, '--json'] };
  });
}

/** Refresh real import-cut occurrences without changing any frozen move identity, path or ordering. */
export function refreshPlanCuts(plan, edges, map, unknown = []) {
  const owners = new Map();
  for (const cell of plan.cells) for (const [from, to] of cell.paths) {
    for (const path of [from, to, mappedPath(map, from)]) {
      const prior = owners.get(path);
      if (prior && (prior.cell !== cell.name || prior.from !== from)) throw new Error(`ambiguous planned source identity ${path}`);
      owners.set(path, { cell: cell.name, from });
    }
  }
  const positions = new Map(plan.cells.map(cell => [cell.name, cell.order]));
  const cuts = new Map(plan.cells.map(cell => [cell.name, new Map()]));
  for (const [file, rows] of edges) for (const { target } of rows) {
    if (testFile(file) || testFile(target)) continue;
    const from = owners.get(file), to = owners.get(target);
    if (!from || !to || positions.get(from.cell) >= positions.get(to.cell)) continue;
    const groups = cuts.get(to.cell), occurrences = groups.get(from.cell) ?? [];
    occurrences.push(`${from.from}->${to.from}`);
    groups.set(from.cell, occurrences);
  }
  // An unresolved loader cannot prove that an earlier recorded dependency disappeared.
  const uncertain = new Set(unknown.map(row => owners.get(row.file)?.from).filter(Boolean));
  for (const cell of plan.cells) for (const prior of cell.cuts) {
    const groups = cuts.get(cell.name), occurrences = groups.get(prior.cell) ?? [];
    const counts = new Map();
    for (const edge of prior.edges) if (uncertain.has(edge.split('->')[0])) counts.set(edge, (counts.get(edge) ?? 0) + 1);
    for (const [edge, count] of counts) for (let n = occurrences.filter(value => value === edge).length; n < count; n++) occurrences.push(edge);
    if (occurrences.length) groups.set(prior.cell, occurrences);
  }
  const cells = plan.cells.map(cell => ({ ...cell, cuts: [...cuts.get(cell.name)]
    .sort(([a], [b]) => positions.get(a) - positions.get(b))
    .map(([name, occurrences]) => ({ cell: name, imports: occurrences.length, edges: occurrences.sort() })) }));
  return { ...plan, cells };
}
