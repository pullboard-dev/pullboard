/** Committed file moves translate read identities; original checks and event evidence stay immutable [C7]. */
import {
  gitChildEnv,
  mainCheckout,
  tryGit,
} from '../../../../git/index.js';
import { gitExecFileSync } from '../../../../git/index.js';
import { literalShellWords } from '../../../../kernel/light.js';
import { pathMapFileWords } from './map/operands.js';
import { Refused } from '../../../../kernel/light.js';

/** Explain an unreadable rename map without accepting a partial or guessed identity. */
function invalidMap() {
  return new Refused('NO_POLICY', 'the root path-map.json and packages/codemap/data/plan/path-map/*.json shards must be committed old-path to new-path objects with relative file paths and no cycles; correct the map and retry');
}

/** Maps name complete repository-relative POSIX files, never directories outside the checkout. */
function relativeFile(value) {
  return typeof value === 'string' && value.length > 0 && !/[\\:\x00-\x1f\x7f]/u.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..');
}

/** Combine the exact selected tree's root compatibility map and per-cell shards, then flatten complete rename chains. */
export function readPathMap(root, { commit = 'HEAD' } = {}) {
  const listed = tryGit(root, ['ls-tree', '-r', '-z', commit, '--', 'path-map.json', 'packages/codemap/data/plan/path-map']);
  if (listed.status !== 0) throw invalidMap();
  const shards = listed.stdout.split('\0').filter(Boolean).map((entry) => {
    const match = /^100(?:644|755) blob ([a-f0-9]+)\t(.+)$/u.exec(entry);
    if (!match || !(match[2] === 'path-map.json' || /^packages\/codemap\/data\/plan\/path-map\/[a-z][a-z0-9-]*\.json$/u.test(match[2]))) throw invalidMap();
    return { oid: match[1] };
  });
  // One cat-file stream reads every shard, instead of one git show per shard (#2232).
  let blobs;
  try {
    blobs = shards.length ? gitExecFileSync(['cat-file', '--batch'], {
      cwd: root, env: gitChildEnv(root), input: `${shards.map((shard) => shard.oid).join('\n')}\n`, encoding: null, maxBuffer: 64 * 1024 * 1024,
    }) : Buffer.alloc(0);
  } catch { throw invalidMap(); }
  let at = 0;
  for (const shard of shards) {
    const end = blobs.indexOf(0x0a, at);
    const header = end < 0 ? [] : blobs.toString('utf8', at, end).split(' ');
    if (header[1] !== 'blob') throw invalidMap();
    const size = Number(header[2]);
    shard.text = blobs.toString('utf8', end + 1, end + 1 + size);
    at = end + 1 + size + 1;
  }
  return parsePathMaps(shards.map(shard => shard.text));
}

/** Validate and flatten all map shards using the same rules for committed and snapshot reads. */
function parsePathMaps(shards) {
  const map = new Map();
  for (const text of shards) {
    let data;
    try { data = JSON.parse(text); } catch { throw invalidMap(); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidMap();
    for (const [from, to] of Object.entries(data)) {
      if (!relativeFile(from) || !relativeFile(to) || map.has(from)) throw invalidMap();
      map.set(from, to);
    }
  }
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

/** Read the exact selected snapshot's map files and reject invalid names or nonregular entries. */
export function pathMapFromFiles(files, entries = files) {
  if (!(files instanceof Map) || !(entries instanceof Map)) throw invalidMap();
  const names = [...new Set([...entries.keys(), ...files.keys()])].filter(path => typeof path === 'string'
    && (path === 'path-map.json' || path === 'packages/codemap/data/plan/path-map' || path.startsWith('packages/codemap/data/plan/path-map/'))).sort();
  const shards = names.map(path => {
    if (!(path === 'path-map.json' || /^packages\/codemap\/data\/plan\/path-map\/[a-z][a-z0-9-]*\.json$/u.test(path))) throw invalidMap();
    const entry = entries.get(path), bytes = files.get(path);
    if (entries !== files && (!entry || !['100644', '100755'].includes(entry.mode))) throw invalidMap();
    if (!Buffer.isBuffer(bytes)) throw invalidMap();
    return bytes.toString('utf8');
  });
  return parsePathMaps(shards);
}

/** History readers share the primary branch's map even when called from an older worktree. */
export function historyPathMap(root) {
  const trunk = mainCheckout(root);
  return readPathMap(root, { commit: trunk?.commit ?? 'HEAD' });
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

/** Find a named test's regular file at a historical source, refusing ambiguous surviving aliases. */
export function pathAtCommit(root, map, path, commit) {
  const paths = historicalPaths(map, path);
  const selected = tryGit(root, ['ls-tree', '-z', commit, '--', ...paths.map(file => `:(literal)${file}`)]);
  if (selected.status !== 0) throw invalidMap();
  const files = selected.stdout.split('\0').filter(Boolean).filter(entry => /^100(?:644|755) blob /u.test(entry))
    .map(entry => entry.slice(entry.indexOf('\t') + 1));
  const current = mappedPath(map, path);
  if (files.includes(current)) return current;
  if (files.length === 1) return files[0];
  throw invalidMap();
}

/** Resolve exact literal shell words; preserve expansions, selectors, prose and all surrounding syntax. */
export function mappedCheck(root, command, options = {}) {
  const map = readPathMap(root, options);
  if (!map.size) return command;
  let result = command;
  for (const token of pathMapFileWords(command).reverse()) {
    const word = literalShellWords(token.raw)[0];
    const path = mappedPath(map, word);
    if (path !== word) result = result.slice(0, token.start) + `'${path.replaceAll("'", "'\\''")}'` + result.slice(token.end);
  }
  return result;
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

/** Where the cell lint baseline descriptor lives; named here so a caller that only needs the path loads no lint store [C7]. */
export const CELL_BASELINE_DIRECTORY = 'packages/codemap/data/baselines/lints';
export const CELL_BASELINE_DESCRIPTOR = CELL_BASELINE_DIRECTORY + '/index.json';
