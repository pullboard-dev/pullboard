/** Predict named function work from the exact-main code map without inventing unseen effects [N2,N20,C7]. */

/** Match a literal function or path name without treating its punctuation as a regular expression. */
function mentioned(text, name) {
  // Both alternatives of the pattern need the literal name, so a text without it cannot match.
  if (!text.includes(name)) return false;
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
  const named = pool.flatMap(module => module.functions.filter(fn => mentioned(text, fn.name)));
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

const idSets = new WeakMap();

/** The function ids of one prediction as a set, built once per prediction object. */
function idsOf(prediction) {
  let ids = idSets.get(prediction);
  if (!ids) { ids = new Set(prediction.functions.map(fn => fn.id)); idSets.set(prediction, ids); }
  return ids;
}

/** Distinguish a body collision from one-hop call adjacency over two predictions, and retain the map's actual importer tests. */
export function compareItemPredictions(map, left, right) {
  const leftIds = idsOf(left), rightIds = idsOf(right), shared = [], adjacent = [];
  for (const fn of left.functions) {
    if (rightIds.has(fn.id)) shared.push(fn.id);
    for (const id of fn.calls ?? []) if (rightIds.has(id)) adjacent.push(`${fn.id} -> ${id}`);
  }
  for (const fn of right.functions) for (const id of fn.calls ?? []) if (leftIds.has(id)) adjacent.push(`${fn.id} -> ${id}`);
  shared.sort();
  adjacent.sort();
  let tests = [], uncovered = [];
  if (adjacent.length) {
    const modules = new Set([...left.functions, ...right.functions].map(fn => fn.id.slice(0, fn.id.lastIndexOf('#'))));
    tests = [...new Set(map.modules.filter(module => modules.has(module.path)).flatMap(module => module.tests ?? []))].sort();
    uncovered = map.modules.filter(module => modules.has(module.path) && !(module.tests ?? []).length).map(module => module.path).sort();
  }
  return { known: !left.unknown && !right.unknown, shared, adjacent, tests, uncovered };
}

/** Distinguish a body collision from one-hop call adjacency and retain the map's actual importer tests. */
export function compareItemFunctions(map, first, second) {
  return compareItemPredictions(map, predictItemFunctions(map, first), predictItemFunctions(map, second));
}
