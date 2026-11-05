/** Select committed Node test files through import edges; uncertainty requires the full gate [V4,C7]. */
import { spawnSync } from './windows-child-process.js';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { cleanGitEnvironment } from './git.js';
import {
  COMMAND_CANDIDATE,
  ENGINE_CANDIDATE,
} from './discovery.js';
import {
  commonJsIn,
  importsIn,
} from './module-imports.js';

const MODULE = /\.[cm]?js$/u;
const TEST = /\.(?:test|spec)\.[cm]?js$/u;
const DOC = /^docs\/.+\.md$/u;
// A scanner declares this header rather than executing code while the graph is read.
const TEST_TREE_INPUT = '/** @pullboard-test-input test-tree */';
const SOURCE_TREE_INPUT = '/** @pullboard-test-input source-tree */';
const DOCS_TREE_INPUT = '/** @pullboard-test-input docs-tree */';
// A computed-import test may declare the repository modules it can load, in its leading comment header only.
const LOADS = /^\/\*\* @pullboard-test-loads (.+?) \*\/$/u;
const SOURCE_LOADS = /^\/\*\* @pullboard-module-loads (.+?) \*\/$/u;
const COMMAND_REGISTRY = 'src/commands/index.js';
const GLOBAL = new Set(['bin/run-tests.js', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'src/gate.js', 'src/cli.js', 'src/hooks.js', 'src/trusted-policy.js', 'src/affected-tests.js', 'src/module-imports.js']);

/**
 * The file's leading comment header: its lines before the first line of code. A declaration counts only here, so
 * declaration-looking text inside a string or template later in the file is never read as one (#803).
 */
function headerLines(source) {
  const lines = [];
  let inBlock = false;
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const text = line.trim();
    if (inBlock) { lines.push(line); if (text.includes('*/')) inBlock = false; continue; }
    if (!text || (index === 0 && text.startsWith('#!')) || text.startsWith('//')) { lines.push(line); continue; }
    if (!text.startsWith('/*')) break;
    lines.push(line);
    inBlock = !text.slice(2).includes('*/');
  }
  return lines;
}

/** Match a declared path glob: * and ? stay within one folder, ** crosses folders; null for other glob syntax. */
function globPattern(glob) {
  if (/[[\]{}]/u.test(glob)) return null;
  const source = glob.split(/(\*\*\/|\*\*|\*|\?)/u).map(part => part === '**/' ? '(?:.*/)?' : part === '**' ? '.*'
    : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^$()|\\]/gu, '\\$&')).join('');
  return new RegExp(`^${source}$`, 'u');
}

/**
 * The repository modules a computed loader declares in its leading header, with globs expanded over committed
 * modules. Tests retain legacy outside-path filtering; strict source declarations require every target to exist
 * and every glob to match. Invalid declarations return null so unknown imports still require the full suite.
 *
 * @returns {string[] | null}
 */
function declaredLoads(source, modulePaths, declaration = LOADS, strict = false) {
  const header = headerLines(source);
  if (strict && header.some(line => line.includes('@pullboard-module-loads') && !declaration.test(line))) return null;
  const declared = header.map(line => declaration.exec(line)).filter(Boolean)
    .flatMap(match => match[1].trim().split(/\s+/u)).map(path => posix.normalize(path));
  if (strict && declared.some(path => path.startsWith('../') || path.startsWith('/'))) return null;
  const inRepo = declared.filter(path => !path.startsWith('../') && !path.startsWith('/'));
  const loads = [];
  for (const path of inRepo) {
    if (!/[*?[\]{}]/u.test(path)) {
      if (strict && (!MODULE.test(path) || !modulePaths.includes(path))) return null;
      if (MODULE.test(path)) loads.push(path);
      continue;
    }
    const pattern = globPattern(path);
    if (!pattern) return null;
    const matches = modulePaths.filter(module => pattern.test(module));
    if (strict && !matches.length) return null;
    loads.push(...matches);
  }
  return loads;
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

/** Read all committed module blobs in one Git batch, preserving exact names and source bytes; `blobs` maps every tracked path to its object id. */
function modulesAt(root, commit) {
  const tracked = selectionGit(root, ['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t');
    const [mode, type, hash] = record.slice(0, tab).split(' ');
    return { mode, type, hash, path: record.slice(tab + 1) };
  });
  const entries = tracked.filter(entry => MODULE.test(entry.path));
  // V8 compiles a require() expression as ESM too, but cannot supply its CommonJS edges.
  if (entries.some(entry => entry.path.endsWith('.js'))) {
    const policy = JSON.parse(selectionGit(root, ['show', `${commit}:package.json`]));
    if (policy.type !== 'module' || tracked.some(entry => entry.path.endsWith('/package.json'))) {
      throw new Error('CommonJS or nested package scopes cannot supply a complete ES-module import graph');
    }
  }
  if (entries.some(entry => entry.type !== 'blob' || entry.mode === '120000' || entry.path.endsWith('.cjs'))) {
    throw new Error('a tracked module uses an unsupported file mode or CommonJS');
  }
  const blobs = new Map(tracked.map(entry => [entry.path, entry.hash]));
  if (!entries.length) return { modules: new Map(), blobs };
  const hashes = [...new Set(entries.map(entry => entry.hash))];
  const result = spawnSync('git', ['--no-replace-objects', 'cat-file', '--batch'], {
    cwd: root, env: cleanGitEnvironment(), input: hashes.join('\n') + '\n', maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('committed module blobs could not be read');
  const sources = new Map();
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
  return { modules: new Map(entries.map(entry => [entry.path, sources.get(entry.hash)])), blobs };
}

/**
 * Find literal documentation inputs without executing repository code. File references are resolved
 * both from the repository and from the reader; directory references deliberately overselect their
 * subtree. Split path arguments and template prefixes count as directory reads. Comments may add
 * readers, which is safe: this is conservative input discovery, not JavaScript data-flow analysis.
 * Computed Markdown names select the docs tree; opaque helpers declare DOCS_TREE_INPUT. The
 * landing gate remains complete and never uses this submit-only optimization.
 */
function documentationInputs(path, source, imports, changedDocs = []) {
  const inputs = new Set();
  if (source.split(/\r?\n/u).includes(DOCS_TREE_INPUT)) inputs.add('docs');
  // Plain text is the required conservative rule: syntax, comments, and escapes do not matter.
  // Keep the older literal-reader scan below as an additional conservative signal.
  if (source.includes('docs') && source.includes('.md')) {
    for (const doc of changedDocs) inputs.add(doc);
  }
  for (const doc of changedDocs) {
    const basename = posix.basename(doc).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const wholeWord = new RegExp(`(?:^|[^\\p{L}\\p{M}\\p{N}_])${basename}(?:$|[^\\p{L}\\p{M}\\p{N}_])`, 'u');
    if (wholeWord.test(source)) inputs.add(doc);
  }
  const markdownReader = imports.some(target => target === 'node:fs' || target === 'node:fs/promises');
  const literals = /(['"])(?:\\[\s\S]|(?!\1)[^\\\r\n])*\1|`(?:\\[\s\S]|[^`\\])*`/uy;
  // Try every quote start: a quote in a comment or regular expression must not hide a later real path.
  for (const quote of source.matchAll(/['"`]/gu)) {
    literals.lastIndex = quote.index;
    const match = literals.exec(source);
    if (!match) continue;
    let values;
    if (match[0][0] === '`') {
      const raw = match[0].slice(1,-1);
      // Cook escape sequences only; never evaluate an interpolation. Keep raw text too for tags.
      const cooked = raw.replace(/\\(u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|\r\n|[\s\S])/gu, (_, escape) => {
        if (/^u\{[\da-fA-F]+\}$/u.test(escape)) return String.fromCodePoint(parseInt(escape.slice(2,-1),16));
        if (/^(?:u[\da-fA-F]{4}|x[\da-fA-F]{2})$/u.test(escape)) return String.fromCharCode(parseInt(escape.slice(1),16));
        return ({ n:'\n', r:'\r', t:'\t', b:'\b', f:'\f', v:'\v', 0:'\0', '\n':'', '\r':'', '\r\n':'' })[escape] ?? escape;
      });
      values = [...new Set([raw,cooked])].map(text => {
        const rootDoc = /(?:^|\/)docs(?:\/|$)/u.exec(text);
        if (!rootDoc && text.includes('${') && text.endsWith('.md') && markdownReader) inputs.add('docs');
        return (rootDoc ? text.slice(rootDoc.index + (rootDoc[0].startsWith('/') ? 1 : 0)) : text).split('${',1)[0];
      });
    }
    else {
      // Only a complete quoted string matched above is evaluated, never a template or expression.
      try { values = [match[0].includes('\\') ? new Function(`return ${match[0]};`)() : match[0].slice(1,-1)]; }
      catch { continue; }
    }
    for (let value of values) {
      if (typeof value !== 'string') continue;
      value = value.split(/[?#]/u)[0].replace(/\/$/u,'');
      const embeddedRoot = /\/docs(?:\/|$)/u.exec(value);
      if (embeddedRoot) value = value.slice(embeddedRoot.index + 1);
      const wildcard = value.search(/[\*\[\{]/u);
      if (wildcard !== -1) value = value.slice(0,value.lastIndexOf('/',wildcard) + 1);
      if (value === '.md' && markdownReader) { inputs.add('docs'); continue; }
      if (!value) continue;
      const directoryReader = /\b(?:readdir|glob|opendir)/u.test(source);
      if (!value.includes('/') && !value.endsWith('.md') && value !== 'docs' && !directoryReader) continue;
      const prefix = value === 'docs' || value.endsWith('.md') ? source.slice(0,match.index).trimEnd() : '';
      if (/\.(?:startsWith|endsWith|includes|indexOf)\($/u.test(prefix)) continue;
      if (markdownReader && value.endsWith('.md') && !value.includes('docs/')
        && (/\+$/u.test(prefix) || /^\s*\+/u.test(source.slice(match.index + match[0].length)))) inputs.add('docs');
      // Bare "docs" is also a commit type or lane. In a call/path assignment, or a directory
      // scanner, it can name an input; a declaration of commit types alone is not a reader.
      const callArgument = /[,(]$/u.test(prefix) && prefix.lastIndexOf('(') > prefix.lastIndexOf('[');
      const joinedArray = prefix.lastIndexOf('[') > prefix.lastIndexOf(']')
        && /^[^\]]*\]\s*\.join\s*\(/u.test(source.slice(match.index + match[0].length));
      if (value === 'docs' && !callArgument && !joinedArray && !/(?<![=!<>])=$/u.test(prefix) && !directoryReader) continue;
      for (const candidate of [posix.normalize(value), posix.normalize(posix.join(posix.dirname(path),value))]) {
        if (candidate === 'docs' || candidate.startsWith('docs/')) inputs.add(candidate.replace(/\/$/u,''));
      }
    }
  }
  return inputs;
}

/**
 * Admit only the named builtin-export synchronizer, which cannot create module-loader edges.
 * Rewrite that exact import and ask V8 whether another node:module edge remains. Text in comments
 * or strings cannot hide a real unknown import. Keep dynamic builtin loaders and CommonJS unknown.
 */
function knownBuiltinSynchronizers(sources, imports) {
  const indices = sources.flatMap((_source, index) => imports[index].includes('node:module') ? [index] : []);
  if (!indices.length) return new Set();
  const synchronizer = /\bimport\s*\{\s*syncBuiltinESMExports\s*,?\s*\}\s*from\s*(['"])node:module\1/gu;
  const rewritten = indices.map(index => sources[index].replace(synchronizer,
    (_match, quote) => `import { syncBuiltinESMExports } from ${quote}node:fs${quote}`));
  const remaining = importsIn(rewritten);
  // Reuse V8's code-versus-text probe for the dynamic builtin loader as well as CommonJS words.
  const loaders = commonJsIn(indices.map(index => sources[index].replace(/\bgetBuiltinModule\b/gu, 'createRequire')));
  return new Set(indices.filter((_index, offset) => !remaining[offset].includes('node:module') && !loaders[offset]));
}

/** Compile this tree's import edges, plus the literal child-CLI dependency used by fixture modules. */
function graphAt(root, commit, changedDocs = []) {
  const { modules, blobs } = modulesAt(root, commit);
  const paths = [...modules.keys()];
  const sources = [...modules.values()];
  const imports = importsIn(sources);
  const synchronizers = knownBuiltinSynchronizers(sources, imports);
  const reverse = new Map();
  const unknown = new Map();
  const undeclared = new Map();
  const testTreeReaders = new Set();
  const sourceTreeReaders = new Set();
  const docInputs = new Map();
  paths.forEach((path, index) => {
    if (changedDocs.length) docInputs.set(path, documentationInputs(path, modules.get(path), imports[index], changedDocs));
    if (TEST.test(path)) {
      for (const line of modules.get(path).split(/\r?\n/u)) {
        if (line === TEST_TREE_INPUT) testTreeReaders.add(path);
        else if (line === SOURCE_TREE_INPUT) sourceTreeReaders.add(path);
        else if (line === DOCS_TREE_INPUT) continue;
        else break;
      }
    }
    for (const target of imports[index]) {
      if (target === 'node:module') {
        if (!synchronizers.has(index)) unknown.set(path, 'a reached module may create CommonJS imports');
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
        const loads = declaredLoads(modules.get(path), paths, SOURCE_LOADS, true);
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
      if (!target.startsWith('.')) {
        unknown.set(path, target === '(computed)' ? 'non-literal dynamic import' : 'unresolved package import');
        continue;
      }
      const dependency = posix.normalize(posix.join(posix.dirname(path), target.split(/[?#]/u)[0]));
      if (dependency.startsWith('../')) { unknown.set(path, 'import outside the repository'); continue; }
      if (!reverse.has(dependency)) reverse.set(dependency, new Set());
      reverse.get(dependency).add(path);
    }
    // A child process is not an import edge, but tests and helpers that name the CLI entry depend on
    // every module it imports. Keep this literal path edge narrow and build it for each committed tree.
    if (modules.get(path).includes('bin/pullboard.js')) {
      if (!reverse.has('bin/pullboard.js')) reverse.set('bin/pullboard.js', new Set());
      reverse.get('bin/pullboard.js').add(path);
    }
  });
  // Discovery is not an import: the command registry loads each src/commands module, and machine.js reads each
  // src/*-engine.js leaf as text. A change to one reaches the reader, so everything that imports the reader is selected.
  for (const module of paths) {
    const reader = module.startsWith('src/commands/') && COMMAND_CANDIDATE.test(module.slice('src/commands/'.length)) ? COMMAND_REGISTRY
      : module.startsWith('src/') && ENGINE_CANDIDATE.test(module.slice('src/'.length)) ? 'src/machine.js' : null;
    if (!reader) continue;
    if (!reverse.has(module)) reverse.set(module, new Set());
    reverse.get(module).add(reader);
  }
  return { paths, reverse, unknown, undeclared, testTreeReaders, sourceTreeReaders, docInputs, modules, blobs };
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
  const graph = graphAt(root, commit);
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
      for (const dependency of forward.get(path) ?? []) {
        if (!reached.has(dependency)) { reached.add(dependency); queue.push(dependency); }
      }
    }
    // The test and the test/ helpers it reaches without passing through product code: its own test-side reads.
    const helpers = new Set([test]);
    for (const path of helpers) {
      for (const dependency of forward.get(path) ?? []) if (dependency.startsWith('test/')) helpers.add(dependency);
    }
    closures.set(test, reason ? { files: null, reason } : { files: [...reached].sort(), helpers: [...helpers].sort(), reason: '' });
  }
  return { closures, modules: graph.modules, blobs: graph.blobs };
}

/**
 * Select changed tests and every transitive importer in the old and new trees. Old edges cover
 * deletions and renames; declared tree readers also cover changed test or source inputs. Other filesystem
 * reads and process launches are not import edges, except literal documentation inputs and modules that
 * mention the Pullboard CLI entry (`bin/pullboard.js`), whose imported modules they exercise as subprocesses.
 *
 * @param {string} root
 * @param {{base:string|null, trunk?:string, commit?:string, changed?:string[]}} options
 * @returns {{full:boolean, reason:string, files:string[]}}
 */
export function selectAffectedTests(root, { base, trunk, commit = 'HEAD', changed }) {
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
    const after = graphAt(root, commit, changedDocs);
    files = after.paths.filter(path => TEST.test(path)).sort();
    const fallback = changed.find(path => GLOBAL.has(path) || path.startsWith('.githooks/'));
    if (fallback) return { full: true, reason: `${fallback} controls the gate or dependency selection`, files };
    if (!files.length) return { full: true, reason: 'no committed Node test files can be selected', files };
    const unsupported = changed.find(path => !MODULE.test(path) && !DOC.test(path));
    if (unsupported) return { full: true, reason: `import selection cannot compute the effect of ${unsupported}`, files };
    const before = graphAt(root, base, changedDocs);
    const [unreadable] = [...before.undeclared, ...after.undeclared];
    if (unreadable) return { full: true, reason: `${unreadable[0]}: ${unreadable[1]}`, files };
    const reached = new Set(changed);
    const queue = [...changed];
    for (const doc of changed.filter(path => DOC.test(path))) {
      for (const graph of [before, after]) {
        for (const [reader, inputs] of graph.docInputs) {
          if ([...inputs].some(input => input === doc || doc.startsWith(input + '/'))) {
            if (!reached.has(reader)) { reached.add(reader); queue.push(reader); }
          }
        }
      }
    }
    for (let at = 0; at < queue.length; at += 1) {
      const path = queue[at];
      for (const graph of [before, after]) {
        if (graph.unknown.has(path)) return { full: true, reason: `${graph.unknown.get(path)} in reached file ${path}`, files };
        for (const importer of graph.reverse.get(path) ?? []) {
          if (!reached.has(importer)) { reached.add(importer); queue.push(importer); }
        }
      }
    }
    const changedTestInput = changed.some(path => path.startsWith('test/') || TEST.test(path) || /^test\.[cm]?js$/u.test(path));
    const changedSourceInput = changed.some(path => path.startsWith('src/') || path.startsWith('bin/'));
    const selected = files.filter(path => reached.has(path)
      || (changedTestInput && (before.testTreeReaders.has(path) || after.testTreeReaders.has(path)))
      || (changedSourceInput && (before.sourceTreeReaders.has(path) || after.sourceTreeReaders.has(path))));
    if (selected.length === files.length) return { full: true, reason: 'the change reaches every test file', files };
    return { full: false, reason: '', files: selected };
  } catch (error) {
    return { full: true, reason: `import selection could not be computed: ${error.message}`, files };
  }
}
