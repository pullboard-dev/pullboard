/** Plan startable import-cut work per importing cell without changing the accepted move order [C7,D3]. */

/** Stable identity for a cut item, independent of move numbering and board allocation. */
export function cutTitle(cell) { return `Cells import cuts: ${cell} removes imports into later cells`; }

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
      if (extra || !importer.paths.some(([path]) => path === from) || !target.paths.some(([path]) => path === to)) {
        throw new Error(`cut import is outside its named cells: ${edge}`);
      }
      const destination = target.paths.find(([path]) => path === to)?.[1];
      group.edges.push({ id: `${importer.name}->${target.name}:${index}`, from, to, target: target.name,
        how: destination?.includes('/src/core/')
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

/** Build independent add commands; no move-tooling dependency or implicit chain prevents disjoint cuts starting now. */
export function cutItemCommands(plan, ids = new Map()) {
  return importCuts(plan).filter(group => !ids.has(group.cell)).map(group => {
    const check = `node bin/cells-plan.js --cuts ${group.cell} && npm run gate`;
    const criterion = `Remove all ${group.edges.length} import occurrences listed below from ${group.cell} into its later cells. Apply each named lower-layer extraction or explicit port inversion without hiding the dependency in a shim or computed loader. The cut check and full suite pass on Node 22.13 and 24; preserve behavior, historical engine numbers and recorded events. No dependency on #1395 or any cell move is required. Coordinate any overlapping files before editing; items with disjoint file sets may run in parallel.`;
    const brief = [`Import-cut plan for ${group.cell}, from committed bin/cells-plan.json and its shards (#1593).`,
      `Files potentially touched (importer plus provider endpoints; retain ownership coordination):\n${group.files.map(file => `- ${file}`).join('\n')}`,
      `Imports to remove and implementation strategy (each recorded occurrence appears once):\n${group.edges.map(edge => `- [${edge.id}] ${edge.from} -> ${edge.to}: ${edge.how}`).join('\n')}`,
      `Check: ${check}. Add focused behavior regressions for changed ports or extracted definitions; the full suite remains mandatory.`].join('\n\n');
    return { group, args: ['add', 'core', cutTitle(group.cell), '--criterion', criterion,
      '--specs', 'C7,D3,doctrine:CD64', '--check', check, '--brief', brief, '--json'] };
  });
}
