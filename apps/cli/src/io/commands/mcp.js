/** The pullboard mcp command, in its own module so an item adding another command never edits these lines. */
import {
  serveMcp,
} from '../../../../../packages/mcp/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  context,
  main,
} from '../entry.js';

import { tryGit } from '../../../../../packages/git/index.js';
import { codeMapGraph } from '../../../../../packages/gate/heavy.js';
import { selectAffectedTests } from '../../../../../packages/gate/heavy.js';
import { scanSource } from '../../../../../packages/codemap/index.js';
import { repositoryImport } from '../../../../../packages/codemap/index.js';
import { readCellRule } from '../../../../../packages/codemap/light.js';
import { personNeeds } from '../../../../../packages/spec/index.js';
import { personNeedsState } from '../../../../view/index.js';
import { refusalDocument } from '../../logic/step/words.js';

/** Compose the actual shared person obligations at the CLI boundary, outside the MCP transport. */
function readPersonNeeds(cwd) {
  return personNeeds(personNeedsState(cwd));
}

/** Refuse traversal and absolute paths before consulting any committed blob, including missing paths. */
function repositoryPath(value) {
  if (typeof value !== 'string' || !value || /[\\\u0000-\u001f\u007f]/u.test(value)
    || value.startsWith('/') || /^[A-Za-z]:/u.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Refused('BAD_REQUEST', `path outside the repository or not canonical: ${JSON.stringify(value)}; use a repository-relative path`);
  }
  return value;
}

/** Observed direct imports and simple calls retain the scanner's limitations instead of claiming completeness. */
function usages(graph, path, symbol) {
  const importers = [];
  const callers = [];
  for (const [file, source] of [...graph.modules].sort(([a], [b]) => a.localeCompare(b))) {
    const resolved = specifier => repositoryImport(file, specifier, graph.importMap);
    const module = scanSource(file, source);
    const importsTarget = symbol
      ? module.imports.some(entry => resolved(entry.from) === path && entry.names.some(binding => binding.imported === symbol || binding.imported === '*'))
      : (graph.imports.get(file) ?? []).some(specifier => resolved(specifier) === path);
    if (importsTarget) importers.push(file);
    if (!symbol) continue;
    const names = new Set(file === path ? [symbol] : []);
    for (const entry of module.imports) if (resolved(entry.from) === path) {
      for (const binding of entry.names) {
        if (binding.imported === symbol) names.add(binding.local);
        if (binding.imported === '*') names.add(`${binding.local}.${symbol}`);
      }
    }
    for (const fn of module.functions) if (fn.localCalls.some(name => names.has(name))) callers.push({ file, function: fn.name, line: fn.line });
  }
  return { target: path + (symbol ? `#${symbol}` : ''), importers, callers,
    complete: false, limitation: 'Observed direct imports and named calls only; dynamic dispatch, re-exported bindings and shadowing require source review.' };
}

/** The cell a committed path sits in, read from its folder: packages/<cell> or apps/<app>, a cell only when its front door is committed [C7,#2467]. */
function cellOfFolder(graph, path) {
  const folder = /^(packages|apps)\/([^/]+)\//u.exec(path);
  if (!folder) return null;
  const frontDoor = `${folder[1]}/${folder[2]}/index.js`;
  if (!graph.blobs.has(frontDoor)) return null;
  return { name: folder[1] === 'apps' ? `app:${folder[2]}` : folder[2], edgeName: `${folder[1] === 'apps' ? 'apps/' : ''}${folder[2]}`, frontDoor };
}

/** The cells an edge rule lets one cell import, named as the cell order names them and listed in that order. */
function declaredImports(rule, edgeName) {
  const named = target => (target.startsWith('apps/') ? `app:${target.slice('apps/'.length)}` : target);
  const targets = rule.allowedEdges.filter(edge => edge.startsWith(`${edgeName}->`)).map(edge => named(edge.slice(edgeName.length + 2).replace(/\/src$/u, '')));
  const rank = name => (rule.cellOrder.includes(name) ? rule.cellOrder.indexOf(name) : rule.cellOrder.length);
  return [...new Set(targets)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Serve commit-stamped read-only map queries through existing compiler, selector and declared-rule readers. */
async function readCodeMap(cwd, name, input) {
  const located = tryGit(cwd, ['rev-parse', '--show-toplevel']);
  const pinned = tryGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (located.status || pinned.status) throw new Refused('BAD_REQUEST', 'code-map tools need a Git repository with a committed HEAD; commit the fixture or restore the checkout');
  const root = located.stdout.trim();
  const commit = pinned.stdout.trim();
  const parts = name === 'usages' ? input.target.split('#') : [];
  if (parts.length > 2 || (parts.length === 2 && !/^[A-Za-z_$][\w$]*$/u.test(parts[1]))) throw new Refused('BAD_REQUEST', 'usages needs a module path or module#function; use an exact named function');
  const paths = name === 'impact' ? input.files.map(repositoryPath) : [repositoryPath(name === 'usages' ? parts[0] : input.path)];
  const graph = codeMapGraph(root, commit);
  for (const path of paths) if (!graph.blobs.has(path)) throw new Refused('BAD_REQUEST', `path ${path} is not a committed repository file; commit it or use a tracked path`);
  if (name === 'cell') {
    const cell = cellOfFolder(graph, paths[0]);
    return { version: 1, commit, path: paths[0], cell: cell?.name ?? null, frontDoor: cell?.frontDoor ?? null,
      allowedImports: cell ? declaredImports(await readCellRule(root), cell.edgeName) : [], sameCellImports: Boolean(cell), temporaryEdges: [],
      unknown: cell ? null : 'file is not in a cell folder: packages/<cell> or apps/<app> with a committed front door' };
  }
  const unknown = [...graph.unknown, ...graph.undeclared].sort(([a], [b]) => a.localeCompare(b)).map(([file, reason]) => ({ file, reason }));
  if (name === 'usages' && !graph.modules.has(paths[0])) throw new Refused('BAD_REQUEST', `path ${paths[0]} is not a committed JavaScript module; use a module path`);
  if (name === 'usages') return { version: 1, commit, ...usages(graph, paths[0], parts[1]), unknown };
  const reached = new Set(paths);
  for (const file of reached) for (const importer of graph.reverse.get(file) ?? []) reached.add(importer);
  return { version: 1, commit, changed: [...new Set(paths)].sort(), dependentModules: [...reached].filter(file => !paths.includes(file)).sort(),
    tests: selectAffectedTests(root, { base: commit, commit, changed: [...new Set(paths)].sort() }), unknown };
}

/**
 * Serve MCP over stdio as this checkout's agent (A9). Stdout carries only the protocol, so the command
 * takes no --json; each tool call runs its own CLI command, with its own relay sync, through main.
 * A person's move never comes through it (P6).
 */
export async function mcpHere(io, { first, values }) {
  if (first) throw new Refused('USAGE', 'pullboard mcp takes no arguments; run pullboard mcp from the agent\'s worktree');
  if (values.json) throw new Refused('USAGE', 'pullboard mcp speaks MCP on stdout; run pullboard mcp without --json');
  context(io);
  return serveMcp({ cwd: io.cwd, input: io.stdin, output: io.stdout, log: io.stderr, runCommand: io.runCommand, readCodeMap, readPersonNeeds, formatRefusal: refusalDocument });
}

/** Run `pullboard mcp` and return its exit code. */
export async function run(io, args) {
  return await mcpHere(io, args);
}
