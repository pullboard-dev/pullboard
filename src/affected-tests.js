/** Select committed Node test files through import edges; uncertainty requires the full gate [V4,C7]. */
import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';
import { cleanGitEnvironment } from './git.js';
import { importsIn } from './module-imports.js';

const MODULE = /\.[cm]?js$/u;
const TEST = /\.(?:test|spec)\.[cm]?js$/u;
const GLOBAL = new Set(['bin/run-tests.js', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'src/gate.js', 'src/cli.js', 'src/hooks.js', 'src/trusted-policy.js', 'src/affected-tests.js', 'src/module-imports.js']);

/** Read exact objects from this checkout, ignoring ambient Git selectors and replacement refs. */
function selectionGit(root, args) {
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.quotepath=false', ...args], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('the committed import graph could not be read');
  return result.stdout;
}

/** Read all committed module blobs in one Git batch, preserving exact names and source bytes. */
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
  if (!entries.length) return new Map();
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
  return new Map(entries.map(entry => [entry.path, sources.get(entry.hash)]));
}

/** Compile import edges for one tree; computed imports stay attached to their importing file. */
function graphAt(root, commit) {
  const modules = modulesAt(root, commit);
  const paths = [...modules.keys()];
  const imports = importsIn([...modules.values()]);
  const reverse = new Map();
  const unknown = new Map();
  paths.forEach((path, index) => {
    for (const target of imports[index]) {
      if (target === 'node:module') { unknown.set(path, 'a reached module may create CommonJS imports'); continue; }
      if (target.startsWith('node:')) continue;
      if (!target.startsWith('.')) {
        unknown.set(path, target === '(computed)' ? 'non-literal dynamic import' : 'unresolved package import');
        continue;
      }
      const dependency = posix.normalize(posix.join(posix.dirname(path), target.split(/[?#]/u)[0]));
      if (dependency.startsWith('../')) { unknown.set(path, 'import outside the repository'); continue; }
      if (!reverse.has(dependency)) reverse.set(dependency, new Set());
      reverse.get(dependency).add(path);
    }
  });
  return { paths, reverse, unknown };
}

/**
 * Select changed tests and every transitive importer in the old and new trees. Old edges cover
 * deletions and renames; process launches and filesystem reads are deliberately not import edges.
 *
 * @param {string} root
 * @param {{base:string, commit?:string, changed?:string[]}} options
 * @returns {{full:boolean, reason:string, files:string[]}}
 */
export function selectAffectedTests(root, { base, commit = 'HEAD', changed }) {
  let files = [];
  try {
    changed ??= selectionGit(root, ['diff', '--no-renames', '--name-only', '-z', base, commit]).split('\0').filter(Boolean);
    const after = graphAt(root, commit);
    files = after.paths.filter(path => TEST.test(path)).sort();
    const fallback = changed.find(path => GLOBAL.has(path) || path.startsWith('.githooks/'));
    if (fallback) return { full: true, reason: `${fallback} controls the gate or dependency selection`, files };
    if (!files.length) return { full: true, reason: 'no committed Node test files can be selected', files };
    const unsupported = changed.find(path => !MODULE.test(path));
    if (unsupported) return { full: true, reason: `import selection cannot compute the effect of ${unsupported}`, files };
    const before = graphAt(root, base);
    const reached = new Set(changed);
    const queue = [...changed];
    for (let at = 0; at < queue.length; at += 1) {
      const path = queue[at];
      for (const graph of [before, after]) {
        if (graph.unknown.has(path)) return { full: true, reason: `${graph.unknown.get(path)} in reached file ${path}`, files };
        for (const importer of graph.reverse.get(path) ?? []) {
          if (!reached.has(importer)) { reached.add(importer); queue.push(importer); }
        }
      }
    }
    const selected = files.filter(path => reached.has(path));
    if (selected.length === files.length) return { full: true, reason: 'the change reaches every test file', files };
    return { full: false, reason: '', files: selected };
  } catch (error) {
    return { full: true, reason: `import selection could not be computed: ${error.message}`, files };
  }
}
