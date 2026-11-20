/** Validate the composed source before any landing publication [B35]. */
import { cellInventory } from '../../../codemap/index.js';
import { withCellSourceSnapshots } from '../../../codemap/index.js';
import { addedLines } from '../../../commits/index.js';
import { secretsIn } from '../../../commits/index.js';
import { commonJsIn } from '../../../gate/index.js';
import { importsIn } from '../../../gate/index.js';
import { cleanGitEnvironment } from '../../../git/index.js';
import { git } from '../../../git/index.js';
import { gitSpawnSync } from '../../../git/index.js';
import { repoInfo } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { composeItemPatches } from '../../../items/index.js';
import { Refused } from '../../../kernel/index.js';
import { loadKeyedResult } from '../../../pin/index.js';
import { pruneKeyedResults } from '../../../pin/index.js';
import { saveKeyedResult } from '../../../pin/index.js';
import { getItem } from '../../../store/index.js';
import { itemPatches } from '../../../store/index.js';
import { join } from 'node:path';
import { scratchRoot } from '../../../config/index.js';

const graphs = new Map();
/** Imports of each source; a source that does not compile imports nothing provable, as the seal graph also treats it (#2438). */
function tolerantImportsIn(sources) {
  try { return importsIn(sources); }
  catch (error) {
    if (error.message !== 'source does not compile as an ES module') throw error;
    return sources.map(source => {
      try { return importsIn([source])[0]; }
      catch (failure) { if (failure.message !== 'source does not compile as an ES module') throw failure; return []; }
    });
  }
}

const parsers = { importsIn: tolerantImportsIn, commonJsIn };

/** Check all ordered companion effects as one patch set, allowing unrelated later main edits. */
export function requireLandingCompanions(root, board, entries, tip) {
  // The tip's tree is read only once an item carries companions: a batch with none asked Git for it at every merge [C7].
  let tree;
  for (const entry of entries) {
    const item = getItem(board, entry.id ?? entry.item_id);
    const patches = itemPatches(board, item.item_id);
    if (!patches.length) continue;
    tree ??= git(root, ['rev-parse', `${tip}^{tree}`]);
    const expected = composeItemPatches(root, item, patches);
    const merged = tryGit(root, ['merge-tree', '--write-tree', `--merge-base=${item.item_commit}`, tip, expected.commit]);
    if (!Number.isInteger(merged.status) || merged.status < 0 || merged.status > 1) throw new Refused('LAND_COMPANION_SOURCE', `cannot read the exact companion composition for #${item.item_id}; restore its Git objects before landing`);
    if (merged.status !== 0 || merged.stdout.split('\n')[0] !== tree) {
      throw new Refused('LAND_COMPANION_MISSING', `landing #${item.item_id} does not contain its complete attached companion set; rebuild the batch from the checked composition`);
    }
  }
}

const MODULE_GRAPHS = 32;
const MODULE_SOURCE = /(?:^|\/)package\.json$|\.[cm]?js$/u;

/** Read Git objects without hooks or replace refs, in the form the caller asks for. */
function objects(root, args, input) {
  const result = gitSpawnSync(['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env: { ...cleanGitEnvironment(), GIT_OPTIONAL_LOCKS: '0' }, ...(input === undefined ? { encoding: 'utf8' } : { input }), maxBuffer: 1024 * 1024 * 1024 });
  if (result.status !== 0) throw new Refused('LAND_MODULE_SOURCE', `cannot inspect exact landing modules: git ${args[0]} failed; restore the source and retry`);
  return result.stdout;
}

/**
 * The module graph of one tree built from its Git objects: every path from one ls-tree and the bytes of each module and
 * package.json from one cat-file --batch, parsed by the same inventory a checkout uses. Other files keep their path and
 * no bytes, since only their existence is read. Why: a worktree per call cost a full checkout of the repository [C7,#3359].
 */
function treeGraph(root, tree) {
  const entries = new Map(), wanted = new Map();
  for (const row of objects(root, ['ls-tree', '-r', '-z', '--full-tree', tree]).split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t');
    const [mode, , sha] = row.slice(0, tab).split(' ');
    const path = row.slice(tab + 1);
    entries.set(path, { mode, sha });
    if ((mode === '100644' || mode === '100755') && MODULE_SOURCE.test(path)) wanted.set(path, sha);
  }
  const shas = [...new Set(wanted.values())], bytes = new Map();
  if (shas.length) {
    const out = objects(root, ['cat-file', '--batch'], shas.map(sha => `${sha}\n`).join(''));
    let offset = 0;
    for (const sha of shas) {
      const end = out.indexOf(10, offset), [, type, size] = out.subarray(offset, end).toString('utf8').split(' ');
      if (type !== 'blob') throw new Refused('LAND_MODULE_SOURCE', 'cannot inspect exact landing modules: a committed blob is unavailable; restore the source and retry');
      bytes.set(sha, out.subarray(end + 1, end + 1 + Number(size)));
      offset = end + 1 + Number(size) + 1;
    }
  }
  const files = new Map([...entries].filter(([, entry]) => entry.mode === '100644' || entry.mode === '100755').map(([path, entry]) => [path, wanted.has(path) ? bytes.get(entry.sha) : Buffer.alloc(0)]));
  // A virtual folder that is never created: every read of it is answered from the snapshot, none from a disk.
  const snapshot = { root: join(scratchRoot(), `pullboard-landing-graph-${tree}`), entries, files };
  const { edges, unknown } = withCellSourceSnapshots(snapshot, () => cellInventory(snapshot.root, parsers));
  return { edges, unknown };
}

/** The on-disk cache entry of a tree's graph, or null when it is missing, damaged or another tree's. */
function cachedGraph(directory, tree) {
  try {
    const data = JSON.parse(loadKeyedResult(directory, tree)?.toString('utf8') ?? 'null');
    if (data?.version !== 1 || data.tree !== tree || !Array.isArray(data.edges) || !Array.isArray(data.unknown)) return null;
    return { edges: new Map(data.edges), unknown: data.unknown };
  } catch { return null; }
}

/** Record a graph by its tree id and keep only the newest entries; the cache is optional, so a failed write costs a rebuild. */
function storeGraph(directory, tree, graph) {
  try {
    saveKeyedResult(directory, tree, JSON.stringify({ version: 1, tree, edges: [...graph.edges], unknown: graph.unknown }));
    pruneKeyedResults(directory, MODULE_GRAPHS);
  } catch { /* The next process builds it again. */ }
}

/**
 * The module graph at a commit, from its Git objects with no worktree or checkout, cached in memory and on disk by tree id.
 * The disk entry lives under the git dir's pullboard folder, so a second lander process for the same tree runs no ls-tree.
 *
 * @param {string} root any checkout of the repository
 * @param {string} commit the exact commit to read
 * @returns {{ edges: Map<string, any[]>, unknown: any[] }}
 */
export function graphAt(root, commit) {
  const common = repoInfo(root).commonDir;
  const tree = git(root, ['rev-parse', `${commit}^{tree}`]);
  const key = `${common}:${tree}`;
  if (graphs.has(key)) return graphs.get(key);
  const directory = join(common, 'pullboard', 'module-graphs');
  let graph = cachedGraph(directory, tree);
  if (!graph) { graph = treeGraph(root, tree); storeGraph(directory, tree, graph); }
  graphs.set(key, graph);
  if (graphs.size > 8) graphs.delete(graphs.keys().next().value);
  return graph;
}

/** A literal local import is a resolution failure; computed loaders remain the full gate's responsibility. */
function missingImports(graph) {
  return graph.unknown.filter(row => /^missing import target /u.test(row.reason ?? ''));
}

/** Identify inherited main debt without exempting a new importer or a newly deleted target. */
function edgeKey(row) { return JSON.stringify([row.file, row.specifier, row.reason]); }

/**
 * The changed ES modules that do not parse alone at the composed tip.
 * Why: the inventory reads through tolerantImportsIn, which treats an uncompilable source as importing nothing, so the
 * parse failure must be found here, directly, or a duplicate import lands [C7].
 */
function brokenModules(root, tip, changed) {
  const modules = changed.filter(file => /\.(?:m?js)$/u.test(file));
  const sources = committedSources(root, tip, modules);
  return modules.filter(file => {
    const source = sources.has(file) ? sources.get(file) : shownSource(root, tip, file);
    if (source === null) return false;
    try { importsIn([source], undefined); return false; } catch { return true; }
  });
}

/** One file's committed text as `git show` prints it (trimmed), or null when Git cannot show it. */
function shownSource(root, tip, file) {
  const shown = tryGit(root, ['show', `${tip}:${file}`]);
  return shown.status === 0 ? shown.stdout : null;
}

/**
 * The committed text of each changed module through one `git cat-file --batch`, trimmed as `git show` output is; a path
 * the batch reports missing is null, and one it cannot frame as a blob is left out for the per-file read.
 * Why: a landing read every changed module with its own Git process at each merge group, sixteen a group in a batch [C7].
 */
function committedSources(root, tip, files) {
  const sources = new Map();
  if (!files.length || files.some(file => /[\r\n]/u.test(file))) return sources;
  const result = gitSpawnSync(['--no-replace-objects', '-c', 'core.quotepath=false', '-c', 'gc.auto=0', 'cat-file', '--batch'],
    { cwd: root, input: files.map(file => `${tip}:${file}\n`).join(''), maxBuffer: 1 << 28 });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) return sources;
  let at = 0;
  for (const file of files) {
    const end = result.stdout.indexOf(10, at);
    if (end < 0) break;
    const header = result.stdout.subarray(at, end).toString('utf8');
    at = end + 1;
    if (header === `${tip}:${file} missing`) { sources.set(file, null); continue; }
    const blob = /^[0-9a-f]{40,64} (\S+) (\d+)$/u.exec(header);
    if (!blob) break;
    const size = Number(blob[2]);
    if (blob[1] === 'blob') sources.set(file, result.stdout.subarray(at, at + size).toString('utf8').trim());
    at += size + 1;
  }
  return sources;
}

/**
 * The refusal for a composed module that does not parse, naming the changed files that fail alone.
 * Why: a duplicate import in a composition killed the worker as LAND_WORKER, which blamed no item and left the batch
 * pinned in merging; a parse failure is the composed content's own and ends the batch terminally [C7].
 */
function parseRefusal(root, tip, changed, broken = brokenModules(root, tip, changed)) {
  const refusal = new Refused('LAND_MODULE_PARSE', `the composed landing has ${broken.length ? broken.join(', ') : 'a module'} that does not parse as an ES module; fix the duplicate or invalid declaration and resubmit`);
  refusal.broken = broken;
  return refusal;
}

/**
 * Refuse a composed landing whose lines added over `base` hold a possible secret, naming each file:line and never the value.
 * Why: the pre-commit scan is skipped by a --no-verify commit, so landing reruns the same scanner before main moves [#5968].
 */
export function requireLandingSecretFree(root, base, tip) {
  const diff = git(root, ['diff', '--text', '--no-ext-diff', '--no-textconv', '--no-color', '-U0', base, tip], { maxBuffer: 1 << 28 });
  const found = secretsIn(addedLines(diff));
  if (!found.length) return;
  const refusal = new Refused('LANDING_SECRET', `the composed landing adds a possible secret: ${found.join('; ')}`, 'remove the value from the item\'s commits (rewrite them, never add a revert) and resubmit');
  refusal.found = found;
  throw refusal;
}

/** Inspect source only: no candidate module is imported or evaluated before main moves; secrets are refused first [#5968]. */
export async function requireLandingModuleResolution(root, base, tip) {
  requireLandingSecretFree(root, base, tip);
  const before = graphAt(root, base);
  const changed = git(root, ['diff', '--no-renames', '--name-only', '-z', base, tip]).split('\0').filter(Boolean);
  const broken = brokenModules(root, tip, changed);
  if (broken.length) throw parseRefusal(root, tip, changed, broken);
  let after;
  try { after = graphAt(root, tip); }
  catch (error) {
    if (error.message !== 'source does not compile as an ES module') throw error;
    throw parseRefusal(root, tip, changed);
  }
  const inherited = new Set(missingImports(before).map(edgeKey));
  const missing = missingImports(after).filter(row => !inherited.has(edgeKey(row)));
  if (missing.length) throw new Refused('LAND_MODULE_RESOLUTION', `the composed landing leaves missing module targets: ${missing.map(row => `${row.file}: ${row.specifier} (${row.reason})`).join('; ')}; restore or repoint every importer before landing`);
}
