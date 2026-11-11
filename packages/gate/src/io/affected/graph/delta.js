/** Update a base import graph for the modules whose blobs changed, instead of rebuilding every map [C7,V4]. */

/**
 * The module paths whose bytes differ between a prior graph and a tree, or null when the graph's shape would change
 * and only a full rebuild is canonical: a different set of module paths or of tracked paths (declared globs and inputs
 * resolve against them), a different package policy (the import map), or an unsupported file mode.
 *
 * @param {{ paths: string[], blobs: Map<string, string>, modules: Map<string, string>, importMap: object }} prior
 * @param {{ modules: Map<string, string>, blobs: Map<string, string>, unsafeInputs: Set<string>, importMap: object }} tree
 * @returns {string[] | null}
 */
export function changedModules(prior, tree) {
  if (tree.unsafeInputs.size || prior.blobs.size !== tree.blobs.size || prior.paths.length !== tree.modules.size
    || JSON.stringify(prior.importMap) !== JSON.stringify(tree.importMap)) return null;
  for (const path of tree.blobs.keys()) if (!prior.blobs.has(path)) return null;
  for (const path of tree.modules.keys()) if (!prior.modules.has(path)) return null;
  return [...tree.modules.keys()].filter(path => prior.blobs.get(path) !== tree.blobs.get(path));
}

/**
 * A working copy of the prior graph for this tree with the changed modules' contributions removed: their entries in
 * every per-module map, and their place as an importer in the reverse map. Unchanged modules keep everything they
 * contributed. The prior graph is never modified.
 */
export function forkWithout(prior, tree, changed) {
  const gone = new Set(changed);
  const reverse = new Map();
  for (const [dependency, importers] of prior.reverse) {
    const kept = new Set([...importers].filter(importer => !gone.has(importer)));
    if (kept.size) reverse.set(dependency, kept);
  }
  const without = map => new Map([...map].filter(([path]) => !gone.has(path)));
  return { paths: [...tree.modules.keys()], modules: tree.modules, blobs: tree.blobs, unsafeInputs: tree.unsafeInputs,
    importMap: tree.importMap, reverse, unknown: without(prior.unknown), undeclared: without(prior.undeclared),
    testTreeReaders: new Set([...prior.testTreeReaders].filter(path => !gone.has(path))),
    sourceTreeReaders: new Set([...prior.sourceTreeReaders].filter(path => !gone.has(path))),
    docInputs: new Map(), imports: without(prior.imports), commonJs: new Map(), utilities: new Set() };
}
