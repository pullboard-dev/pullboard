/** Derive current registry correctness from declarations rather than a live golden [C7,V4]. */

/** Report invalid identities, allocation collisions, missing slots and missing explicit recovery entries. */
export function registryProblems({ registry, leaves, sources, nextSteps }) {
  const problems = [];
  const operations = new Set();
  for (const [name, declaration] of Object.entries(registry)) {
    if (name !== declaration.operation || operations.has(declaration.operation)) problems.push(`duplicate or mismatched operation ${name}`);
    operations.add(declaration.operation);
    if (!Number.isSafeInteger(declaration.engine) || declaration.engine < 1) problems.push(`invalid move engine ${name}`);
    if (typeof declaration.itemIdFirstArgument !== 'boolean') problems.push(`missing item slots ${name}`);
    for (const [code, step] of Object.entries(declaration.nextSteps ?? {})) {
      if (typeof step !== 'string' || !step.trim() || nextSteps[code] !== step) problems.push(`missing recovery entry ${code}`);
    }
  }
  const names = new Set();
  const allocated = new Set();
  for (const leaf of leaves) {
    if (names.has(leaf.name)) problems.push(`duplicate engine name ${leaf.name}`);
    names.add(leaf.name);
    // Concurrent placeholders deliberately share a provisional floor; only landed numbers are unique.
    if (leaf.number === null) continue;
    if (!Number.isSafeInteger(leaf.number) || leaf.number < 1 || allocated.has(leaf.number)) problems.push(`duplicate or invalid engine number ${leaf.number}`);
    allocated.add(leaf.number);
  }
  for (const source of sources) {
    for (const match of source.matchAll(/new Refused\(\s*['"]([A-Z][A-Z0-9_]*)['"]/gu)) {
      if (typeof nextSteps[match[1]] !== 'string' || !nextSteps[match[1]].trim()) problems.push(`missing recovery entry ${match[1]}`);
    }
  }
  return [...new Set(problems)];
}
