/** Derive current registry correctness from declarations rather than a live golden [C7,V4]. */

/**
 * Engine numbers that two landed engines already share. Each entry names both engines, the commits that introduced them and why
 * it stays: events recorded under 145 replay by that number, so renumbering would change recorded history [C7,V4].
 */
export const HISTORICAL_DUPLICATE_ENGINES = Object.freeze({
  145: Object.freeze({
    engines: Object.freeze(['ITEM_PATCH_AUTO_ENGINE', 'UNCHANGED_REFREEZE_ENGINE']),
    commits: Object.freeze(['4b32b9c40c', '9573fad586']),
    reason: 'both landed with number 145 on 7 Nov; recorded events replay by number, so neither is renumbered after the fact',
  }),
});

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
  const holders = new Map();
  for (const leaf of leaves) {
    if (names.has(leaf.name)) problems.push(`duplicate engine name ${leaf.name}`);
    names.add(leaf.name);
    // Concurrent placeholders deliberately share a provisional floor; only landed numbers are unique.
    if (leaf.number === null) continue;
    const exception = HISTORICAL_DUPLICATE_ENGINES[leaf.number];
    const named = exception?.engines.includes(leaf.name) && (holders.get(leaf.number) ?? []).every(name => exception.engines.includes(name));
    if (!Number.isSafeInteger(leaf.number) || leaf.number < 1 || allocated.has(leaf.number) && !named) problems.push(`duplicate or invalid engine number ${leaf.number}`);
    allocated.add(leaf.number);
    holders.set(leaf.number, [...(holders.get(leaf.number) ?? []), leaf.name]);
  }
  for (const source of sources) {
    for (const match of source.matchAll(/new Refused\(\s*['"]([A-Z][A-Z0-9_]*)['"]/gu)) {
      if (typeof nextSteps[match[1]] !== 'string' || !nextSteps[match[1]].trim()) problems.push(`missing recovery entry ${match[1]}`);
    }
  }
  return [...new Set(problems)];
}
