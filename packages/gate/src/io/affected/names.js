/** Follow a change through a re-exporting door by the names each importer takes, behind gate.namedImportSelection [C7,V4]. */
import { namedBindingsIn } from '../../../../codemap/index.js';
import { repositoryImport } from '../../../../codemap/index.js';
import { namedImportSelectionOn } from '../../../../config/light.js';

/** The names an importer takes from one module through `from` edges, or null when it takes the whole module. */
function carried(rows, importer, path, names, importMap) {
  const resolves = source => source !== null && repositoryImport(importer, source, importMap) === path;
  const relevant = name => names === null || names.has(name);
  let touched = false;
  const out = new Set();
  // An unresolved row naming this module, or one whose module cannot be read, takes the whole door.
  if (rows.unresolved.some(row => row.source === null || resolves(row.source))) return null;
  for (const row of rows.imports) {
    if (!resolves(row.source)) continue;
    touched = true;
    if (row.names.some(entry => relevant(entry.imported))) return null;
  }
  for (const row of rows.reexports) {
    if (!resolves(row.source)) continue;
    touched = true;
    for (const entry of row.names) if (relevant(entry.imported)) out.add(entry.exported);
  }
  // An edge no import statement explains (a declared load, the CLI entry, discovery) is the whole module.
  return touched ? out : null;
}

/**
 * The reach step of affected-test selection. `reach(graph, path, importer)` is true when the importer must be (re)queued:
 * the first time it is reached, or when the names it carries grow. Off, every importer carries the whole module, so the
 * step is exactly "not reached before". On, an importer that only re-exports names from the module carries those names
 * on, and one that imports only names the module does not carry is not reached. Paths already in `reached` (the changed
 * files and documentation readers) carry everything.
 *
 * @param {boolean | undefined} enabled - Undefined reads gate.namedImportSelection.
 * @param {Set<string>} reached
 * @returns {{ reach: (graph: { reverse: Map<string, Set<string>>, modules: Map<string, string>, importMap: object }, path: string, importer: string) => boolean }}
 */
export function namedReach(enabled, reached) {
  const on = enabled ?? namedImportSelectionOn();
  const names = new Map();
  const parsed = new WeakMap();
  const known = path => names.has(path) ? names.get(path) : reached.has(path) ? null : undefined;
  /** Each importer's named bindings, parsed for every importer of `path` at once so a door costs one parse. */
  const rowsOf = (graph, path, importer) => {
    if (!parsed.has(graph)) parsed.set(graph, new Map());
    const memo = parsed.get(graph);
    if (!memo.has(importer)) {
      const wanted = [...graph.reverse.get(path) ?? []].filter(module => !memo.has(module) && graph.modules.has(module));
      namedBindingsIn(wanted.map(module => graph.modules.get(module))).forEach((rows, index) => memo.set(wanted[index], rows));
    }
    return memo.get(importer) ?? null;
  };
  return {
    reach(graph, path, importer) {
      const had = known(importer);
      if (had === null) return false;
      const rows = on ? rowsOf(graph, path, importer) : null;
      const add = rows ? carried(rows, importer, path, known(path) ?? null, graph.importMap) : null;
      if (add === null) { names.set(importer, null); return true; }
      const next = new Set([...had ?? [], ...add]);
      if (!next.size || (had && next.size === had.size)) return false;
      names.set(importer, next);
      return true;
    },
  };
}
