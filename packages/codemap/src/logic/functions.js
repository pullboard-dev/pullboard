/** Predict named function work from the exact-main code map without inventing unseen effects [N2,N20,C7]. */

const WORD = /^\w+$/u;

/** Match a literal function or path name without treating its punctuation as a regular expression. */
function mentioned(text, name, words) {
  // Both alternatives of the pattern need the literal name, and a plain word name needs it as a whole word, so a text without it cannot match.
  if (!(WORD.test(name) ? words.has(name) : text.includes(name))) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:\\bfunction\\s+|#|\\x60)${escaped}(?:\\x60|\\s*\\(|(?=$|[^\\w$]))|\\b${escaped}\\s*\\(`, 'u').test(text);
}

const predictions = new WeakMap();

/** Unqualified paths cover all bodies; only explicit function references narrow a path. */
export function predictItemFunctions(map, item) {
  const text = [item.item_title, item.item_criterion, item.item_brief, item.item_files].filter(Boolean).join('\n');
  let cache = predictions.get(map);
  if (!cache) { cache = new Map(); predictions.set(map, cache); }
  if (cache.has(text)) return cache.get(text);
  const paths = [...new Set([...text.matchAll(/\b(?:src|bin|packages|apps)\/[\w./-]+\.m?js\b/gu)].map(match => match[0]))];
  const all = map.modules;
  const modules = all.filter(module => paths.includes(module.path));
  const importHint = /\bimports?[- ]only\b/iu.test(text);
  const pool = paths.length ? modules : all;
  const words = new Set(text.split(/\W+/u));
  const named = pool.flatMap(module => module.functions.filter(fn => mentioned(text, fn.name, words)));
  const importsOnly = importHint && named.length === 0;
  const functions = importsOnly ? [] : paths.length
    ? modules.flatMap(module => { const selected = module.functions.filter(fn => named.includes(fn)); return selected.length ? selected : module.functions; })
    : named;
  const result = { functions, paths, unknown: paths.some(path => !modules.some(module => module.path === path))
    || (!importsOnly && modules.some(module => !module.functions.length)) || (!paths.length && !functions.length) };
  if (cache.size >= 512) cache.clear();
  cache.set(text, result);
  return result;
}

const shapes = new WeakMap();

/** The function ids of one prediction and its calls indexed by callee, built once per prediction object. */
function shapeOf(prediction) {
  let shape = shapes.get(prediction);
  if (!shape) {
    const ids = new Set(), calledBy = new Map();
    for (const fn of prediction.functions) {
      ids.add(fn.id);
      for (const id of fn.calls ?? []) {
        const callers = calledBy.get(id);
        if (callers) callers.push(fn.id); else calledBy.set(id, [fn.id]);
      }
    }
    shape = { ids, calledBy };
    shapes.set(prediction, shape);
  }
  return shape;
}

/** Edges caller -> callee where the callee is in the other prediction, walking the smaller side. */
function edgesInto(callers, other, edges) {
  if (callers.calledBy.size <= other.ids.size) {
    for (const [id, from] of callers.calledBy) if (other.ids.has(id)) for (const caller of from) edges.push(`${caller} -> ${id}`);
  } else {
    for (const id of other.ids) { const from = callers.calledBy.get(id); if (from) for (const caller of from) edges.push(`${caller} -> ${id}`); }
  }
}

const modulesByPath = new WeakMap();

/** The map's modules grouped by path, built once per map and only when an adjacent pair needs its tests. */
function modulesAt(map) {
  let byPath = modulesByPath.get(map);
  if (!byPath) {
    byPath = new Map();
    for (const module of map.modules) { const list = byPath.get(module.path); if (list) list.push(module); else byPath.set(module.path, [module]); }
    modulesByPath.set(map, byPath);
  }
  return byPath;
}

/** Distinguish a body collision from one-hop call adjacency over two predictions, and retain the map's actual importer tests. */
export function compareItemPredictions(map, left, right) {
  const a = shapeOf(left), b = shapeOf(right), shared = [], adjacent = [];
  const [small, large] = a.ids.size <= b.ids.size ? [a, b] : [b, a];
  for (const id of small.ids) if (large.ids.has(id)) shared.push(id);
  edgesInto(a, b, adjacent);
  edgesInto(b, a, adjacent);
  shared.sort();
  adjacent.sort();
  let tests = [], uncovered = [];
  if (adjacent.length) {
    const named = new Set([...a.ids, ...b.ids].map(id => id.slice(0, id.lastIndexOf('#')))), byPath = modulesAt(map);
    const found = [...named].flatMap(path => byPath.get(path) ?? []);
    tests = [...new Set(found.flatMap(module => module.tests ?? []))].sort();
    uncovered = found.filter(module => !(module.tests ?? []).length).map(module => module.path).sort();
  }
  return { known: !left.unknown && !right.unknown, shared, adjacent, tests, uncovered };
}

/** Distinguish a body collision from one-hop call adjacency and retain the map's actual importer tests. */
export function compareItemFunctions(map, first, second) {
  return compareItemPredictions(map, predictItemFunctions(map, first), predictItemFunctions(map, second));
}
