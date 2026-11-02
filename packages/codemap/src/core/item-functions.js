/** Predict named function work from the exact-main code map without inventing unseen effects [N2,N20,C7]. */

/** Match a literal function or path name without treating its punctuation as a regular expression. */
function mentioned(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:\\bfunction\\s+|#|\\x60)${escaped}(?:\\x60|\\s*\\(|(?=$|[^\\w$]))|\\b${escaped}\\s*\\(`, 'u').test(text);
}

/** Unqualified paths cover all bodies; only explicit function references narrow a path. */
export function predictItemFunctions(map, item) {
  const text = [item.item_title, item.item_criterion, item.item_brief, item.item_files].filter(Boolean).join('\n');
  const paths = [...new Set([...text.matchAll(/\b(?:src|bin|packages|apps)\/[\w./-]+\.m?js\b/gu)].map(match => match[0]))];
  const modules = map.modules.filter(module => paths.includes(module.path));
  const importsOnly = /\b(?:imports?[- ]only|import block)\b/iu.test(text);
  const named = map.modules.flatMap(module => module.functions.filter(fn => mentioned(text, fn.name)));
  const functions = importsOnly ? [] : paths.length
    ? modules.flatMap(module => { const selected = module.functions.filter(fn => mentioned(text, fn.name)); return selected.length ? selected : module.functions; })
    : named;
  return { functions, paths, unknown: paths.some(path => !modules.some(module => module.path === path))
    || (!importsOnly && modules.some(module => !module.functions.length)) || (!paths.length && !functions.length) };
}

/** Distinguish a body collision from one-hop call adjacency and retain the map's actual importer tests. */
export function compareItemFunctions(map, first, second) {
  const left = predictItemFunctions(map, first), right = predictItemFunctions(map, second);
  const ids = new Set(right.functions.map(fn => fn.id));
  const shared = left.functions.filter(fn => ids.has(fn.id)).map(fn => fn.id).sort();
  const adjacent = left.functions.flatMap(fn => (fn.calls ?? []).filter(id => ids.has(id)).map(id => `${fn.id} -> ${id}`))
    .concat(right.functions.flatMap(fn => (fn.calls ?? []).filter(id => left.functions.some(other => other.id === id)).map(id => `${fn.id} -> ${id}`))).sort();
  const modules = new Set([...left.functions, ...right.functions].map(fn => fn.id.slice(0, fn.id.lastIndexOf('#'))));
  const tests = adjacent.length ? [...new Set(map.modules.filter(module => modules.has(module.path)).flatMap(module => module.tests ?? []))].sort() : [];
  const uncovered = adjacent.length ? map.modules.filter(module => modules.has(module.path) && !(module.tests ?? []).length).map(module => module.path).sort() : [];
  return { known: !left.unknown && !right.unknown, shared, adjacent, tests, uncovered };
}
