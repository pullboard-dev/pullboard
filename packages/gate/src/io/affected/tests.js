/** Select committed Node test files through import edges; uncertainty requires the full gate [V4,C7]. */
import { spawnSync } from 'node:child_process';
import { cachedAffectedGraph } from './graph/cache.js';
import { DOCS_TREE_INPUT } from './inputs.js';
import { isSourceCellLine } from './inputs.js';
import { readsChangedCell } from './inputs.js';
import { sourceCellPrefixes } from './inputs.js';
import { changedModules } from './graph/delta.js';
import { forkWithout } from './graph/delta.js';
import { documentationInputs } from './inputs.js';
import { unknownRootTests } from './roots.js';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { cleanGitEnvironment } from '../../../../git/index.js';
import { repositoryImport } from '../../../../codemap/index.js';
import {
  COMMAND_CANDIDATE,
  ENGINE_CANDIDATE,
} from '../../../../kernel/index.js';
import {
  commonJsIn,
  compileModules,
  declaredLoads,
  declaredSourceLoads,
  globPattern,
  headerLines,
  importsIn,
  mainCommit,
} from '../../../../codemap/index.js';
import { newPackageCliReach } from '../../logic/reach.js';
import { newKeylessImports } from '../../logic/reach.js';

const MODULE = /\.[cm]?js$/u;
const TEST = /\.(?:test|spec)\.[cm]?js$/u;
const DOC = /^docs\/.+\.md$/u;
// A scanner declares this header rather than executing code while the graph is read.
const TEST_TREE_INPUT = '/** @pullboard-test-input test-tree */';
const SOURCE_TREE_INPUT = '/** @pullboard-test-input source-tree */';
const COMMAND_REGISTRY = 'apps/cli/src/io/commands/index.js';
const GLOBAL = new Set(['apps/cli/src/io/run/tests.js', 'packages/gate/src/io/run-tests.js', 'packages/gate/src/io/run-tests-watchdog-source.js', 'packages/gate/bin/run-tests.js', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);

/** Resolve tag-led committed inputs; prose quotations stay inert and malformed annotations stay unknown. */
function declaredInputs(source, paths) {
  const declarations = headerLines(source).filter(line => /^\s*(?:\/\*+|\*|\/\/)\s*@pullboard-test-input\b/u.test(line));
  const inputs = new Set();
  for (const line of declarations) {
    const match = /^\/\*\* @pullboard-test-input (.+?) \*\/$/u.exec(line.trim());
    if (!match) return null;
    if (isSourceCellLine(line)) { if (sourceCellPrefixes(line) === null) return null; continue; }
    for (const value of match[1].trim().split(/\s+/u)) {
      if (['source-tree', 'test-tree', 'docs-tree'].includes(value)) continue;
      if (value.startsWith('/') || value.split('/').some(part => !part || part === '..' || part === '.')) return null;
      const pattern = globPattern(value);
      if (!pattern) return null;
      const matches = paths.filter(path => pattern.test(path));
      if (!matches.length) return null;
      for (const path of matches) inputs.add(path);
    }
  }
  return [...inputs];
}

/** Only a real description-only package edit lacks implicit loader, dependency and runtime effects. */
function descriptionOnlyPackage(root, base, commit) {
  try {
    const before = JSON.parse(selectionGit(root, ['show', `${base}:package.json`]));
    const after = JSON.parse(selectionGit(root, ['show', `${commit}:package.json`]));
    if (before.description === after.description) return false;
    delete before.description;
    delete after.description;
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.every(key => JSON.stringify(before[key]) === JSON.stringify(after[key]));
  } catch { return false; }
}

/** The one computed form the selector resolves (#803): new URL('<literal relative path>', import.meta.url), with or without .href. */
const URL_LITERAL = /^\s*new\s+URL\(\s*(['"])([^'"\\\r\n]+)\1\s*,\s*import\.meta\.url\s*\)(?:\s*\.\s*href)?\s*$/u;

/**
 * The repository modules a test file's computed imports read, when every one of them is new URL('<literal relative
 * path>', import.meta.url). Any other computed specifier (a variable, a call, an environment value, any expression)
 * cannot be resolved safely, so the file must declare what it loads; without that this returns null and the caller
 * falls back to the whole suite (#803).
 *
 * @param {string} source the test file's text
 * @param {string} path the test file's repository path
 * @param {string[]} modulePaths every module path in the committed tree
 * @returns {string[] | null} the modules it reads, or null when some computed import is not that literal form
 */
function literalLoads(source, path, modulePaths) {
  const targets = new Set();
  for (const call of source.matchAll(/\bimport\s*\(/gu)) {
    const start = call.index + call[0].length;
    if (/^\s*(?:'[^'\\\r\n]*'|"[^"\\\r\n]*")\s*\)/u.test(source.slice(start))) continue;
    let depth = 1, end = start;
    for (; end < source.length && depth; end += 1) depth += source[end] === '(' ? 1 : source[end] === ')' ? -1 : 0;
    const literal = URL_LITERAL.exec(source.slice(start, end - 1));
    if (!literal) return null;
    // Resolve as the runtime does: a file URL against this file, percent-escapes decoded; anything else is unresolved.
    let target;
    try { target = posix.relative('/repo', fileURLToPath(new URL(literal[2], pathToFileURL(posix.join('/repo', path))))); }
    catch { return null; }
    if (target.startsWith('../') || posix.isAbsolute(target)) return null;
    if (!MODULE.test(target) || !modulePaths.includes(target)) return null;
    targets.add(target);
  }
  return [...targets];
}

/** Read exact objects from this checkout, ignoring ambient Git selectors and replacement refs. */
function selectionGit(root, args) {
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.quotepath=false', ...args], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('the committed import graph could not be read');
  return result.stdout;
}

/** Read all committed module blobs in one Git batch, preserving exact names and source bytes; a header-only scan passes `completeGraph: false`, since it reads text and needs no ES-module import graph; `blobs` maps every tracked path to its object id. */
function modulesAt(root, commit, { completeGraph = true, prior } = {}) {
  const tracked = selectionGit(root, ['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t');
    const [mode, type, hash] = record.slice(0, tab).split(' ');
    return { mode, type, hash, path: record.slice(tab + 1) };
  });
  const entries = tracked.filter(entry => MODULE.test(entry.path));
  // V8 compiles a require() expression as ESM too, but cannot supply its CommonJS edges.
  const manifest = tracked.find(entry => entry.path === 'package.json');
  if (manifest && (manifest.type !== 'blob' || manifest.mode === '120000')) throw new Error('the root package policy is not a regular tracked file');
  const policy = manifest ? JSON.parse(selectionGit(root, ['show', `${commit}:package.json`])) : {};
  if (completeGraph && entries.some(entry => entry.path.endsWith('.js'))) {
    if (policy.type !== 'module' || tracked.some(entry => entry.path.endsWith('/package.json'))) {
      throw new Error('CommonJS or nested package scopes cannot supply a complete ES-module import graph');
    }
  }
  if (entries.some(entry => entry.type !== 'blob' || entry.mode === '120000')) {
    throw new Error('a tracked module uses an unsupported file mode');
  }
  const blobs = new Map(tracked.map(entry => [entry.path, entry.hash]));
  const unsafeInputs = new Set(tracked.filter(entry => entry.mode === '120000' || entry.type !== 'blob').map(entry => entry.path));
  if (!entries.length) return { modules: new Map(), blobs, unsafeInputs, importMap: policy.imports ?? {} };
  // A prior graph already holds the bytes of every blob this tree shares with it; read only the rest.
  const known = new Map(prior ? [...prior.blobs].filter(([path]) => prior.modules.has(path)).map(([path, hash]) => [hash, prior.modules.get(path)]) : []);
  const hashes = [...new Set(entries.map(entry => entry.hash))].filter(hash => !known.has(hash));
  const result = !hashes.length ? { status: 0, stdout: Buffer.alloc(0) } : spawnSync('git', ['--no-replace-objects', 'cat-file', '--batch'], {
    cwd: root, env: cleanGitEnvironment(), input: hashes.join('\n') + '\n', maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('committed module blobs could not be read');
  const sources = known;
  let at = 0;
  for (const hash of hashes) {
    const end = result.stdout.indexOf(10, at);
    const [actual, type, count] = result.stdout.subarray(at, end).toString().split(' ');
    const size = Number(count);
    if (actual !== hash || type !== 'blob' || !Number.isSafeInteger(size) || size < 0) throw new Error('committed module batch is incomplete');
    at = end + 1;
    sources.set(hash, result.stdout.subarray(at, at + size).toString('utf8'));
    at += size + 1;
  }
  return { modules: new Map(entries.map(entry => [entry.path, sources.get(entry.hash)])), blobs, unsafeInputs, importMap: policy.imports ?? {} };
}

/**
 * Admit only exact named builtin-export synchronization, TypeScript stripping or the name predicate isBuiltin, none of which loads modules.
 * Rewrite that exact import and ask V8 whether another node:module edge remains. Text in comments
 * or strings cannot hide a real unknown import. Keep dynamic builtin loaders and CommonJS unknown.
 */
function knownBuiltinUtilities(sources, imports, parse) {
  const indices = sources.flatMap((_source, index) => imports[index].includes('node:module') ? [index] : []);
  if (!indices.length) return new Set();
  const utility = /\bimport\s*\{\s*(?:syncBuiltinESMExports|stripTypeScriptTypes|isBuiltin)\s*,?\s*\}\s*from\s*(['"])node:module\1/gu;
  const rewritten = indices.map(index => sources[index].replace(utility,
    (_match, quote) => `import { syncBuiltinESMExports } from ${quote}node:fs${quote}`));
  const remaining = importsIn(rewritten, parse);
  // Reuse V8's code-versus-text probe for the dynamic builtin loader as well as CommonJS words.
  const loaders = commonJsIn(indices.map(index => sources[index].replace(/\bgetBuiltinModule\b/gu, 'createRequire')), parse);
  return new Set(indices.filter((_index, offset) => !remaining[offset].includes('node:module') && !loaders[offset]));
}

/** Compile this tree's import edges, plus the literal child-CLI dependency used by fixture modules. */
/** Wire one module's imports, declared reads and discovery needs into the graph state. */
function contribute(g, path) {
  const { paths, modules, blobs, unsafeInputs, importMap, reverse, unknown, undeclared, testTreeReaders, sourceTreeReaders } = g;
  const imports = g.imports.get(path);
  const sourceLoads = declaredSourceLoads(modules.get(path), paths);
  const inputs = declaredInputs(modules.get(path), [...blobs.keys()]);
  if (inputs === null) unknown.set(path, 'invalid or unmatched declared test input');
  for (const input of inputs ?? []) {
    if (unsafeInputs.has(input)) unknown.set(path, 'declared input escapes through an unsupported file mode');
    if (!reverse.has(input)) reverse.set(input, new Set());
    reverse.get(input).add(path);
  }
  const declaredLoader = sourceLoads?.length > 0;
  if (path.endsWith('.cjs') || g.commonJs.get(path)) {
    if (!declaredLoader) unknown.set(path, 'CommonJS loader declares no complete @pullboard-module-loads reach');
    for (const load of sourceLoads ?? []) {
      if (!reverse.has(load)) reverse.set(load, new Set());
      reverse.get(load).add(path);
    }
  }
  if (TEST.test(path)) {
    for (const line of headerLines(modules.get(path))) {
      if (line === TEST_TREE_INPUT) testTreeReaders.add(path);
      else if (line === SOURCE_TREE_INPUT) sourceTreeReaders.add(path);
      else if (line === DOCS_TREE_INPUT) continue;
    }
  }
  for (const target of imports) {
    if (target === 'node:module') {
      if (!g.utilities.has(path) && !declaredLoader) unknown.set(path, 'a reached module may create CommonJS imports');
      continue;
    }
    if (target.startsWith('node:')) continue;
    if (target === '(computed)' && TEST.test(path)) {
      const declared = declaredLoads(modules.get(path), paths);
      const loads = declared === null ? [] : declared.length ? declared : literalLoads(modules.get(path), path, paths) ?? [];
      if (!loads.length) undeclared.set(path, 'a computed import declares no @pullboard-test-loads and names no module it can read');
      for (const load of loads) {
        if (!reverse.has(load)) reverse.set(load, new Set());
        reverse.get(load).add(path);
      }
      continue;
    }
    // Source loaders explicitly declare their committed module universe; unknown loaders still fail closed.
    if (target === '(computed)' && !TEST.test(path)) {
      const loads = declaredSourceLoads(modules.get(path), paths);
      if (loads?.length) {
        for (const load of loads) {
          if (!reverse.has(load)) reverse.set(load, new Set());
          reverse.get(load).add(path);
        }
        continue;
      }
    }
    // The command registry loads its sibling modules by discovery; synthetic edges below stand for those imports (#804).
    if (target === '(computed)' && path === COMMAND_REGISTRY) continue;
    if (!target.startsWith('.') && !target.startsWith('#')) {
      unknown.set(path, target === '(computed)' ? 'non-literal dynamic import' : 'unresolved package import');
      continue;
    }
    const dependency = repositoryImport(path, target, importMap);
    if (!dependency || (target.startsWith('#') && !modules.has(dependency))) {
      unknown.set(path, 'unresolved repository import'); continue;
    }
    if (target.startsWith('#')) {
      if (!reverse.has('package.json')) reverse.set('package.json', new Set());
      reverse.get('package.json').add(path);
    }
    if (!reverse.has(dependency)) reverse.set(dependency, new Set());
    reverse.get(dependency).add(path);
  }
  // A child process is not an import edge, but tests and helpers that name the CLI entry depend on
  // every module it imports. Keep this literal path edge narrow and build it for each committed tree.
  // A product module that only names the path as text launches nothing here: its edge moves onto the tests that import it
  // and name the repo root, where this tree's CLI is launched (#3812).
  if (modules.get(path).includes('apps/cli/pullboard.js') && isTestCode(path)) addCliEdge(reverse, path);
  if (isTestCode(path) && NAMES_REPO_ROOT.test(modules.get(path))) {
    for (const dependency of importedPaths(g, path)) {
      if (!isTestCode(dependency) && modules.get(dependency)?.includes('apps/cli/pullboard.js')) addCliEdge(reverse, path);
    }
  }
}

/** Whether a path is test code: a test file, or anything under a test folder, such as a shared fixture. */
function isTestCode(path) { return TEST.test(path) || /(?:^|\/)tests?\//u.test(path); }

/** A test that hands the repository root to code it imports launches this tree's CLI through that code. */
const NAMES_REPO_ROOT = /\b(?:ROOT|repoRoot|REPO_ROOT)\b|import\.meta\.dirname|process\.cwd\(\)|new URL\(\s*['"]\.\.\/?['"]/u;

/** Make the CLI entry depend on nothing but record that this path exercises it as a subprocess. */
function addCliEdge(reverse, path) {
  if (!reverse.has('apps/cli/pullboard.js')) reverse.set('apps/cli/pullboard.js', new Set());
  reverse.get('apps/cli/pullboard.js').add(path);
}

/** The repository modules a module imports by literal specifier. */
function importedPaths(g, path) {
  const out = [];
  for (const target of g.imports.get(path) ?? []) {
    if (!target.startsWith('.') && !target.startsWith('#')) continue;
    const dependency = repositoryImport(path, target, g.importMap);
    if (dependency) out.push(dependency);
  }
  return out;
}

/** Compile the given modules once and add their edges; the only place a module is parsed for the graph. */
function addModules(g, paths, probe) {
  const sources = paths.map(path => g.modules.get(path));
  // A probe records which modules were wired and which source texts reached the parser, for tests of the delta.
  const parse = !probe ? undefined : (list => { probe.parsed.push(...list); return compileModules(list); });
  probe?.imported.push(...paths);
  const imports = importsIn(sources, parse);
  const commonJs = commonJsIn(sources, parse);
  const utilities = knownBuiltinUtilities(sources, imports, parse);
  paths.forEach((path, index) => {
    g.imports.set(path, imports[index]); g.commonJs.set(path, commonJs[index]);
    if (utilities.has(index)) g.utilities.add(path);
  });
  for (const path of paths) contribute(g, path);
}

/**
 * Build the import graph of a tree. With a `prior` graph of another tree that has the same module paths, tracked
 * paths and package policy, only the modules whose blob changed are parsed and rewired; anything else rebuilds all.
 * `probe` (tests) is { builds, imported: [], parsed: [] }: it counts full builds and records what was parsed.
 */
function buildGraph(root, commit, prior, probe) {
  const tree = modulesAt(root, commit, { prior });
  const changed = prior && changedModules(prior, tree);
  let g;
  if (changed) { g = forkWithout(prior, tree, changed); addModules(g, changed, probe); }
  else {
    if (probe) probe.builds = (probe.builds ?? 0) + 1;
    g = { paths: [...tree.modules.keys()], ...tree, reverse: new Map(), unknown: new Map(), undeclared: new Map(), testTreeReaders: new Set(),
      sourceTreeReaders: new Set(), docInputs: new Map(), imports: new Map(), commonJs: new Map(), utilities: new Set() };
    addModules(g, g.paths, probe);
  }
  // Discovery is not an import: the command registry loads each apps/cli/src/io/commands module, and machine.js reads each
  // packages/state/src/logic/engines/*-engine.js leaf as text. A change to one reaches the reader, so everything that imports the reader is selected.
  for (const module of g.paths) {
    const reader = module.startsWith('apps/cli/src/io/commands/') && COMMAND_CANDIDATE.test(module.slice('apps/cli/src/io/commands/'.length)) ? COMMAND_REGISTRY
      : module.startsWith('packages/state/src/logic/engines/') && ENGINE_CANDIDATE.test(module.slice('packages/state/src/logic/engines/'.length)) ? 'packages/state/src/io/machine.js' : null;
    if (!reader) continue;
    if (!g.reverse.has(module)) g.reverse.set(module, new Set());
    g.reverse.get(module).add(reader);
  }
  return { paths: g.paths, reverse: g.reverse, unknown: g.unknown, undeclared: g.undeclared, testTreeReaders: g.testTreeReaders,
    sourceTreeReaders: g.sourceTreeReaders, docInputs: g.docInputs, modules: g.modules, blobs: g.blobs,
    imports: new Map(g.paths.map(path => [path, g.imports.get(path)])), importMap: g.importMap };
}

/**
 * The import graph at a commit. A main commit's graph is cached machine-wide, so a fresh checkout or runner job reuses
 * it. Any other commit is a candidate: it is derived from `prior` (the base graph), reading only the blobs that differ,
 * and is not persisted. Documentation reach is specific to this selection and never cached.
 */
function graphAt(root, commit, changedDocs = [], prior = null, probe = null) {
  const pinned = selectionGit(root, ['rev-parse', '--verify', `${commit}^{commit}`]).trim();
  const graph = prior ? buildGraph(root, pinned, prior, probe) : cachedAffectedGraph(root, pinned, () => buildGraph(root, pinned, null, probe));
  if (changedDocs.length) {
    for (const path of graph.paths) {
      graph.docInputs.set(path, documentationInputs(path, graph.modules.get(path), graph.imports.get(path), changedDocs));
    }
  }
  return graph;
}

/**
 * Each committed test file's transitive import closure: the test, every module it reaches through the same edges
 * selection uses (imports, declared loads, the CLI entry, command and engine discovery), sorted. A closure that reaches
 * an import the graph cannot resolve, or a test whose computed import declares nothing, has `files: null` and a reason,
 * so a caller that keys results on it runs that file rather than trust an incomplete closure [C7].
 *
 * @param {string} root
 * @param {string} [commit]
 * @returns {{ closures: Map<string, { files: string[] | null, helpers?: string[], reason: string }>, modules: Map<string, string>, blobs: Map<string, string> }}
 */
export function testClosures(root, commit = 'HEAD') {
  return closuresInGraph(graphAt(root, commit));
}

/** Expose the same commit-pinned import graph for read-only code-map observations, never a new selector. */
export function codeMapGraph(root, commit = 'HEAD', prior = null, probe = null) {
  return graphAt(root, commit, [], prior, probe);
}

/**
 * One refusal row per package module that reaches a CLI front door in the selection graph at HEAD but not at accepted main.
 * Such reach puts the whole CLI in every closure through that module, so cell-lints refuses it [C7].
 *
 * @param {string} root
 * @returns {string[]} Empty when main is unknown (nothing can rise) or no module newly reaches the CLI.
 */
export function cliReachRows(root) {
  const main = mainCommit(root);
  if (!main) return [];
  return newPackageCliReach(codeMapGraph(root, main), codeMapGraph(root, 'HEAD')).map(({ module, path }) =>
    `cliReach:${module}: reaches ${path.at(-1)} through ${path.join(' -> ')}, which it did not on main ${main.slice(0, 12)}; next: pass the CLI-side entry point in as a parameter or move the shared piece down into a package`);
}

/**
 * One refusal row per module a test closure reaches whose import the graph cannot read at HEAD but could on accepted
 * main. Every test reaching it loses its closure key and reruns at every landing, so cell-lints refuses it (#5840).
 *
 * @param {string} root
 * @returns {string[]} Empty when main is unknown or no reached module newly hides its imports.
 */
export function keylessRows(root) {
  const main = mainCommit(root);
  if (!main) return [];
  return newKeylessImports(codeMapGraph(root, main), codeMapGraph(root, 'HEAD'), path => TEST.test(path)).map(({ module, reason, tests }) =>
    `keyless:${module}: ${reason}, reached by ${tests} test file(s), which main ${main.slice(0, 12)} could read; next: import a literal path, or declare every module it loads in a leading /** @pullboard-module-loads <paths> */ header`);
}

/** Compute the same complete-or-unknown root closures from an already-pinned selection graph. */
function closuresInGraph(graph) {
  const forward = new Map();
  for (const [dependency, importers] of graph.reverse) {
    for (const importer of importers) {
      if (!forward.has(importer)) forward.set(importer, new Set());
      forward.get(importer).add(dependency);
    }
  }
  const closures = new Map();
  for (const test of graph.paths.filter(path => TEST.test(path))) {
    let reason = graph.undeclared.get(test) ?? '';
    const reached = new Set([test]);
    const queue = [test];
    for (let at = 0; at < queue.length && !reason; at += 1) {
      const path = queue[at];
      if (graph.unknown.has(path)) { reason = `${graph.unknown.get(path)} in reached file ${path}`; break; }
      // An imported unreadable test leaves this closure incomplete as well, so it never reuses a green receipt [C7].
      if (path !== test && graph.undeclared.has(path)) { reason = `${graph.undeclared.get(path)} in reached file ${path}`; break; }
      for (const dependency of forward.get(path) ?? []) {
        if (!reached.has(dependency)) { reached.add(dependency); queue.push(dependency); }
      }
    }
    // The test and the test/ helpers it reaches without passing through product code: its own test-side reads.
    const helpers = new Set([test]);
    for (const path of helpers) {
      for (const dependency of forward.get(path) ?? []) if (dependency.startsWith('test/') || /^(?:packages|apps)\/[^/]+\/tests\//u.test(dependency)) helpers.add(dependency);
    }
    closures.set(test, reason ? { files: null, reason } : { files: [...reached].sort(), helpers: [...helpers].sort(), reason: '' });
  }
  /** Reach conservative edges, except the runner's caller-selected universe when the caller separately keys selected files and refuses custom reporters. */
  const reach = (entries, { withoutSelectedRunnerModules = false } = {}) => {
    const reached = new Set(entries.filter(path => graph.blobs.has(path)));
    for (const path of reached) {
      let dependencies = forward.get(path) ?? [];
      if (withoutSelectedRunnerModules && ['apps/cli/src/io/run/tests.js', 'packages/gate/src/io/run-tests.js', 'packages/gate/src/io/test/file/dispatch.js'].includes(path)) {
        // These two ** declarations admit caller-selected reporters and test files. The caller
        // refuses custom reporters and keys each selected test's own complete closure. Keep every literal import and URL guard, and all other modules'
        // conservative discovery edges; ordinary affected-test selection still follows **.
        const targets = (graph.imports.get(path) ?? []).filter(target => target.startsWith('.') || target.startsWith('#'));
        for (const match of (graph.modules.get(path) ?? '').matchAll(/new\s+URL\(\s*(['"`])([^'"`\\$\r\n]+)\1\s*,\s*import\.meta\.url\s*\)/gu)) targets.push(match[2]);
        dependencies = targets.map(target => repositoryImport(path, target, graph.importMap)).filter(target => graph.blobs.has(target));
      }
      for (const dependency of dependencies) reached.add(dependency);
    }
    return [...reached].sort();
  };
  return { closures, modules: graph.modules, blobs: graph.blobs, reach };
}

/**
 * Select explicit test-tree repo guards on source or test changes, independently of affected-test deferral.
 * Both committed trees bind the obligation: removing a declaration cannot drop an accepted guard.
 * Missing bases retain every scanner; unreadable Git inputs refuse instead of silently omitting one.
 */
export function selectTestTreeGuards(root, { base, trunk, commit = 'HEAD', changed } = {}) {
  if (trunk) {
    const mergeBase = selectionGit(root, ['merge-base', trunk, commit]).trim();
    if (mergeBase !== selectionGit(root, ['rev-parse', '--verify', `${commit}^{commit}`]).trim()) base = mergeBase;
    changed = undefined;
  }
  if (base) changed ??= selectionGit(root, ['diff', '--no-renames', '--name-only', '-z', base, commit]).split('\0').filter(Boolean);
  const testChanged = !base || changed.some(path => path.startsWith('test/') || /^(?:packages|apps)\/[^/]+\/tests\//u.test(path)
    || TEST.test(path) || /^test\.[cm]?js$/u.test(path));
  const sourceChanged = !base || changed.some(path => /^(?:src|bin|packages|apps)\//u.test(path));
  if (!testChanged && !sourceChanged) return [];
  const guards = new Set();
  // A guard the base tree names follows its file through a rename in the commit; a deleted one keeps its old path and is refused.
  const renames = base ? renamedPaths(root, base, commit) : new Map();
  for (const revision of [...new Set([base, commit].filter(Boolean))]) {
    for (const [path, source] of modulesAt(root, revision, { completeGraph: false }).modules) {
      if (!TEST.test(path)) continue;
      const headers = headerLines(source);
      if (headers.includes(TEST_TREE_INPUT)) guards.add(revision === base ? renames.get(path) ?? path : path);
    }
  }
  return [...guards].sort();
}

/** Map each path Git detects as renamed between two commits to its new path; copies and deletions are not renames. */
function renamedPaths(root, base, commit) {
  const fields = selectionGit(root, ['diff', '-M', '--name-status', '-z', base, commit]).split('\0');
  const renames = new Map();
  for (let at = 0; at < fields.length; at++) {
    const status = fields[at];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      if (status.startsWith('R')) renames.set(fields[at + 1], fields[at + 2]);
      at += 2;
    } else at += 1;
  }
  return renames;
}

/** One test's reason for joining a gate: the changed file and import chain that reached it, or what forced it in. */
function selectionReason(test, via, changed, isReached, unresolved) {
  if (isReached) {
    const chain = [test];
    for (let at = via.get(test); at !== undefined && chain.length < 50; at = via.get(at)) chain.push(at);
    return chain.length === 1 ? `changed: ${test}` : `${chain.at(-1)} -> ${chain.slice(0, -1).reverse().join(' -> ')}`;
  }
  const hit = unresolved.find(line => line.startsWith(`${test}: `));
  return hit ? `unresolved closure: ${hit.slice(test.length + 2)}` : 'reads a changed test or source tree';
}

/**
 * Select changed tests and every transitive importer in the old and new trees. Old edges cover
 * deletions and renames; declared tree readers also cover changed test or source inputs. Other filesystem
 * reads and process launches are not import edges, except literal documentation inputs and modules that
 * mention the Pullboard CLI entry (`apps/cli/pullboard.js`), whose imported modules they exercise as subprocesses.
 *
 * @param {string} root
 * @param {{base:string|null, trunk?:string, commit?:string, changed?:string[]}} options
 * @returns {{full:boolean, reason:string, files:string[]}}
 */
export function selectAffectedTests(root, { base, trunk, commit = 'HEAD', changed, probe = null }) {
  let files = [];
  try {
    if (!base) return { full: true, reason: 'no claim head recorded; the change cannot be selected', files };
    // The merge base includes topic parents and merge resolutions that receipt history omits.
    if (trunk) {
      const mergeBase = selectionGit(root, ['merge-base', trunk, commit]).trim();
      const submitted = selectionGit(root, ['rev-parse', '--verify', `${commit}^{commit}`]).trim();
      // A trunk submission has no distinct branch base; its claim bounds the submitted work.
      if (mergeBase !== submitted) base = mergeBase;
      changed = undefined;
    }
    changed ??= selectionGit(root, ['diff', '--no-renames', '--name-only', '-z', base, commit]).split('\0').filter(Boolean);
    const changedDocs = changed.filter(path => DOC.test(path));
    const before = graphAt(root, base, changedDocs, null, probe);
    const after = graphAt(root, commit, changedDocs, before, probe);
    files = after.paths.filter(path => TEST.test(path)).sort();
    const fallback = changed.find(path => GLOBAL.has(path) || path.startsWith('.githooks/'));
    if (fallback) return { full: true, reason: `${fallback} controls the gate or dependency selection`, files };
    if (!files.length) return { full: true, reason: 'no committed Node test files can be selected', files };
    if (changed.includes('package.json') && !descriptionOnlyPackage(root, base, commit)) {
      return { full: true, reason: 'package.json changes implicit runtime or package effects', files };
    }
    const unsupported = changed.find(path => !MODULE.test(path) && !DOC.test(path)
      && !before.reverse.has(path) && !after.reverse.has(path));
    if (unsupported) return { full: true, reason: `import selection cannot compute the effect of ${unsupported}`, files };
    // A test whose computed import cannot be read is an unknown root: it and every test importing it always run, and the
    // rest stay focused, so one unreadable file never forces the whole suite (it planned 1,044 files per landing) [C7].
    const reached = new Set(changed);
    const queue = [...changed];
    // Why each path joined: the path that reached it, so a selected test can name its changed file and import chain.
    const via = new Map();
    for (const doc of changed.filter(path => DOC.test(path))) {
      for (const graph of [before, after]) {
        for (const [reader, inputs] of graph.docInputs) {
          if ([...inputs].some(input => input === doc || doc.startsWith(input + '/'))) {
            if (!reached.has(reader)) { reached.add(reader); via.set(reader, doc); queue.push(reader); }
          }
        }
      }
    }
    for (let at = 0; at < queue.length; at += 1) {
      const path = queue[at];
      for (const graph of [before, after]) {
        if (graph.unknown.has(path)) return { full: true, reason: `${graph.unknown.get(path)} in reached file ${path}`, files };
        for (const importer of graph.reverse.get(path) ?? []) {
          if (!reached.has(importer)) { reached.add(importer); via.set(importer, path); queue.push(importer); }
        }
      }
    }
    const changedTestInput = changed.some(path => path.startsWith('test/') || /^(?:packages|apps)\/[^/]+\/tests\//u.test(path) || TEST.test(path) || /^test\.[cm]?js$/u.test(path));
    const changedSourceInput = changed.some(path => /^(?:src|bin|packages|apps)\//u.test(path));
    // An opaque loader may read any changed dependency: retain its roots without inventing missing edges.
    // A change with no code module in it cannot reach an opaque loader's import closure, so it retains no root [V4].
    const codeChanged = changed.some(path => MODULE.test(path));
    const unknownRoots = [before, after].map(graph => unknownRootTests(graph, path => TEST.test(path)));
    const unknownRoot = path => codeChanged && unknownRoots.some(roots => roots.has(path));
    const rootReason = path => (unknownRoots[1].has(path) ? unknownRoots[1] : unknownRoots[0]).reasonOf(path);
    const cellReads = path => changedSourceInput && [before, after].some(graph => readsChangedCell(headerLines(graph.modules.get(path) ?? ''), changed));
    const selected = files.filter(path => reached.has(path) || unknownRoot(path) || cellReads(path)
      || (changedTestInput && (before.testTreeReaders.has(path) || after.testTreeReaders.has(path)))
      || (changedSourceInput && (before.sourceTreeReaders.has(path) || after.sourceTreeReaders.has(path))));
    if (selected.length === files.length) return { full: true, reason: 'the change reaches every test file', files };
    const unresolved = selected.filter(path => unknownRoot(path) && !reached.has(path)).map(path => `${path}: ${rootReason(path)}`);
    const retained = selected.filter(unknownRoot).map(path => `${path}: ${rootReason(path)}`);
    return { full: false, reason: retained.length ? `unresolved root closures retained: ${retained.join('; ')}` : '', files: selected,
      reasons: Object.fromEntries(selected.map(path => [path, selectionReason(path, via, changed, reached.has(path), unresolved)])) };
  } catch (error) {
    if (error?.code === 'MAIN_FACTS_BUSY') throw error;
    return { full: true, reason: `import selection could not be computed: ${error.message}`, files };
  }
}
