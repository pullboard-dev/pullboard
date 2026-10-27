/** Committed file moves translate read identities; original checks and event evidence stay immutable [C7]. */
import { tryGit } from './git.js';
import { literalShellWords } from './literal-shell-words.js';
import { Refused } from './refused.js';

/** Explain an unreadable rename map without accepting a partial or guessed identity. */
function invalidMap() {
  return new Refused('NO_POLICY', 'path-map.json must be a committed old-path to new-path object with relative file paths and no cycles; correct the map and retry');
}

/** Maps name complete repository-relative POSIX files, never directories outside the checkout. */
function relativeFile(value) {
  return typeof value === 'string' && value.length > 0 && !/[\\:\x00-\x1f\x7f]/u.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..');
}

/** Read the exact selected tree's plain old-to-new object and flatten each complete rename chain. */
export function readPathMap(root, { commit = 'HEAD' } = {}) {
  const entry = tryGit(root, ['ls-tree', '-z', commit, '--', 'path-map.json']);
  if (entry.status !== 0) throw invalidMap();
  if (!entry.stdout) return new Map();
  if (!/^100(?:644|755) blob [a-f0-9]+\tpath-map\.json\0$/u.test(entry.stdout)) throw invalidMap();
  const source = tryGit(root, ['show', `${commit}:path-map.json`]);
  if (source.status !== 0) throw invalidMap();
  let data;
  try { data = JSON.parse(source.stdout); } catch { throw invalidMap(); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidMap();
  const map = new Map(Object.entries(data));
  for (const [from, to] of map) if (!relativeFile(from) || !relativeFile(to)) throw invalidMap();
  const resolved = new Map();
  for (const from of map.keys()) {
    let path = from;
    const visited = new Set();
    while (map.has(path)) {
      if (visited.has(path)) throw invalidMap();
      visited.add(path);
      path = map.get(path);
    }
    resolved.set(from, path);
  }
  return resolved;
}

/** Resolve one explicit identity, allowing the conventional leading ./ without guessing basenames. */
export function mappedPath(map, path) {
  const relative = path.startsWith('./') ? path.slice(2) : path;
  return map.get(relative) ?? path;
}

/** Every historic alias of one file is available to Git history and future co-change readers. */
export function historicalPaths(map, path) {
  const current = mappedPath(map, path);
  return [...new Set([path, current, ...[...map].filter(([, target]) => target === current).map(([from]) => from)])];
}

/** Resolve exact literal shell words; preserve expansions, selectors, prose and all surrounding syntax. */
export function mappedCheck(root, command, options = {}) {
  const map = readPathMap(root, options);
  if (!map.size) return command;
  return command.replace(/(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\[\s\S]|[^\s;&|<>()'"])+/gu, raw => {
    const words = literalShellWords(raw);
    if (words?.length !== 1) return raw;
    const path = mappedPath(map, words[0]);
    return path === words[0] ? raw : `'${path.replaceAll("'", "'\\''")}'`;
  });
}

/** A read projection joins renamed test causes without rewriting the recorded cause or its evidence. */
export function mappedCause(map, key) {
  const match = /^test:(.+?)::([\s\S]+)$/u.exec(key);
  return match ? `test:${mappedPath(map, match[1])}::${match[2]}` : key;
}

/** Count companion identities in already captured commit path groups, once per group, for future tooling. */
export function coChangedPaths(map, target, groups) {
  const wanted = mappedPath(map, target);
  const counts = new Map();
  for (const group of groups) {
    const files = new Set(group.map(path => mappedPath(map, path)));
    if (!files.has(wanted)) continue;
    for (const file of files) if (file !== wanted) counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return [...counts].map(([file, count]) => ({ file, count })).sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
}
