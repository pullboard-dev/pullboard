/** Fingerprint literal checker programs and their local module dependencies without executing them [V4,C7]. */
import { createHash } from 'node:crypto';
import { accessSync } from 'node:fs';
import { closeSync } from 'node:fs';
import { constants } from 'node:fs';
import { openSync } from 'node:fs';
import { readSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { basename } from 'node:path';
import { delimiter } from 'node:path';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lex } from '../../../../kernel/light.js';
import { literalShellWords } from '../../../../kernel/light.js';
import { blobOid } from './project-files.js';
import { indexedFiles } from './project-files.js';
import { repoInfo } from '../main.js';
import { storeName } from '../store-names.js';

const binaries = new Map();

/** Hash every script read; large executable digests may be reused only under the same full filesystem identity. */
function fileDigest(file, stat) {
  const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mode}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const prior = binaries.get(file);
  if (stat.size > 1024n * 1024n && prior?.identity === identity) return prior.digest;
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (stat.size > 1024n * 1024n) binaries.set(file, { identity, digest });
  return digest;
}

/** Resolve a literal executable using the same checkout and PATH as its shell. */
function executable(root, word) {
  const paths = isAbsolute(word) || word.includes('/') ? [resolve(root, word)]
    : String(process.env.PATH ?? '').split(delimiter).map(directory => resolve(root, directory || '.', word));
  return paths.find(file => { try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; } });
}

/** Resolve only literal local module files; directory/package loaders remain uncached rather than guessed. */
function localModule(file, specifier) {
  const target = resolve(dirname(file), specifier);
  const found = [target, `${target}.js`, `${storeName(target)}`, `${target}.node`].find(candidate => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  });
  if (!found) throw new Error('checker module cannot be resolved literally');
  return found;
}

/** Longest stretch before a string literal that any context regex below needs to see. */
const contextWindow = 160;

/** The code just before a literal; scanning the whole prefix per literal is quadratic in file length. */
function literalContext(code, start, size) {
  const window = code.slice(Math.max(0, start - size), start);
  // A cut can leave half an identifier whose word boundary is false; the real match is never that long.
  return start > size ? window.replace(/^[\w$]+/u, '') : window;
}

/** What a JavaScript source loads: null when it loads opaquely, else the local specifiers to follow in order. */
export function scanImports(source, strict, size = contextWindow) {
  const { code, strings } = lex(source);
  const bindings = new Map();
  for (const value of strings) {
    const binding = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*$/u.exec(literalContext(code, value.start, size));
    if (binding && !value.text.includes('\\') && !value.text.includes('${')) bindings.set(binding[1], value.text);
  }
  const local = [];
  let calls = 0;
  let requires = 0;
  for (const value of strings) {
    const prefix = literalContext(code, value.start, size);
    const call = /\b(?:require|import)\s*\(\s*$/u.test(prefix);
    if (!call && !/\b(?:from|import)\s*$/u.test(prefix)) continue;
    if (call) { calls++; if (/\brequire\s*\(\s*$/u.test(prefix)) requires++; }
    // A literal that is only the head of a concatenated specifier names no file; a runner closure leaves that load out, a strict scan cannot vouch for it.
    if (call && /^\s*\+/u.test(code.slice(value.end))) { if (strict) return null; continue; }
    if (value.text.includes('\\') || value.text.includes('${')) return null;
    if (isBuiltin(value.text)) {
      if (strict && /^(?:node:)?(?:module|vm|child_process)$/u.test(value.text)) return null;
      continue;
    }
    if (!value.text.startsWith('.') && !isAbsolute(value.text)) return null;
    local.push(value.text);
  }
  for (const match of (strict ? code : '').matchAll(/\b(require|import)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/gu)) {
    const specifier = bindings.get(match[2]);
    // Only an immutable literal binding with no shadowing can describe a computed loader.
    if (!specifier || [...code.matchAll(new RegExp(`\\b${match[2]}\\b`, 'gu'))].length !== 2) return null;
    calls++;
    if (match[1] === 'require') requires++;
    if (!isBuiltin(specifier)) local.push(specifier);
    else if (/^(?:node:)?(?:module|vm|child_process)$/u.test(specifier)) return null;
  }
  if (strict && ([...code.matchAll(/\b(?:require|import)\s*\(/gu)].length !== calls || [...code.matchAll(/\brequire\b/gu)].length !== requires || /\b(?:eval|Function|getBuiltinModule|createRequire)\s*\(/u.test(code))) return null;
  return local;
}

/** The first line of a file, read without loading the rest: executables and binaries are never read whole. */
function firstLine(file) {
  const descriptor = openSync(file, 'r');
  try {
    const head = Buffer.alloc(65536);
    return head.toString('utf8', 0, readSync(descriptor, head, 0, head.length, 0)).split('\n', 1)[0];
  } finally { closeSync(descriptor); }
}

// Import edges by blob id: what a file loads depends only on its bytes, its name and how it is read, never on the checkout.
// Saved in the git directory, so the next command reads no unchanged file; `used` is what a save past the cap keeps.
const edges = new Map();
const used = new Set();
const loaded = new Set();
let added = 0;

/** Pullboard's own checkout, whose git index vouches for its source as the project's does. */
const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** This repository's edge file, named by the scanner's bytes and Node (which decides builtins); merged once. */
function loadEdges(project) {
  try {
    const name = createHash('sha256').update(process.version).update(readFileSync(fileURLToPath(import.meta.url)))
      .update(readFileSync(fileURLToPath(new URL('../../../../kernel/src/logic/lex.js', import.meta.url)))).digest('hex');
    const file = `${repoInfo(project).commonDir}/pullboard/import-edges-${name.slice(0, 16)}.json`;
    if (!loaded.has(file)) {
      loaded.add(file);
      try {
        for (const [key, value] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) {
          if (value?.k === 'js' ? Array.isArray(value.local) && value.local.every(item => typeof item === 'string') : /^(?:sh|none|bad)$/u.test(value?.k)) edges.set(key, value);
        }
      } catch { added++; /* None yet, or unreadable: the save replaces it. */ }
    }
    return file;
  } catch { return null; }
}

/** Save after a walk that scanned something new; a failed save only means the next command scans again. */
function saveEdges(file) {
  if (!file || !added) return;
  added = 0;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.${process.pid}`, JSON.stringify(Object.fromEntries([...edges].filter(([key]) => edges.size < 16384 || used.has(key)))));
    renameSync(`${file}.${process.pid}`, file);
  } catch { /* As above. */ }
}

// For each result, the files a clean project tree cannot vouch for: those read from disk, and Pullboard's own by blob id.
const unvouched = new WeakMap();

/** The digest of one file the way the fingerprint takes it: project files by git blob id, others by content. */
function entryDigest(file, stat, inside, length) {
  return inside ? `git:${blobOid(readFileSync(file), length)}` : fileDigest(file, stat);
}

/**
 * Whether a definition computed earlier still describes the files on disk. Files git vouched for are covered by the
 * caller's clean-tree check; only the rest are read again. A result this module did not return is computed afresh.
 */
export function definitionUnchanged(root, previous, commands, code) {
  const saved = unvouched.get(previous);
  if (!saved) {
    const fresh = checkCommandDefinition(root, commands, code);
    return Boolean(fresh) && JSON.stringify(fresh) === JSON.stringify(previous);
  }
  try {
    const index = saved.tool.entries.length ? indexedFiles(saved.tool.root, [], { untracked: false }) : null;
    return saved.tool.entries.every(({ path, oid }) => index?.clean.get(path)?.oid === oid)
      && saved.rest.every(({ file, inside, length, digest }) => entryDigest(file, statSync(file, { bigint: true }), inside, length) === digest);
  } catch { return false; }
}

/** The path of `file` under `base`, or undefined when it lies outside. */
function under(base, file) {
  const path = relative(base, file);
  return path && !path.startsWith('..') && !isAbsolute(path) ? path : undefined;
}

/** Collect tracked project code plus literal external dependencies; opaque external loading misses the cache. */
export function checkCommandDefinition(root, commands, codeFiles = [], { tool: toolRoot = TOOL_ROOT } = {}) {
  const files = new Map();
  const rest = [];
  const project = realpathSync.native(root);
  const indexes = new Map();
  /** The git index answer, asked once and only when a file there needs it. */
  function tracked(base) {
    if (!indexes.has(base)) indexes.set(base, indexedFiles(base, [], { untracked: false }));
    return indexes.get(base);
  }
  let tool = null;
  try { tool = realpathSync.native(toolRoot); } catch { /* Read like any other files. */ }
  // Inside the project, Pullboard is the project's own code.
  if (tool === project || under(project, tool ?? '/') !== undefined) tool = null;
  const toolEntries = [];
  const store = loadEdges(project);
  /** Include actual bytes even for symlinks or files outside the checked Git tree. */
  function visit(input, strict = true, language = '') {
    const named = resolve(input);
    const given = under(project, named);
    const own = tool && given === undefined ? under(tool, named) : undefined;
    // A clean tracked regular file has no symlink above it, so its name is already its real path.
    const file = given !== undefined && tracked(project)?.clean.has(given) ? resolve(project, given)
      : own !== undefined && tracked(tool)?.clean.has(own) ? resolve(tool, own) : realpathSync.native(input);
    if (files.has(file)) return;
    if (files.size >= 8192) throw new Error('checker dependency closure is unbounded');
    const stat = statSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error('checker input is not a regular file');
    const path = relative(project, file);
    const inside = !(path.startsWith('..') || isAbsolute(path));
    const toolPath = !inside && tool ? under(tool, file) : undefined;
    const known = inside ? tracked(project)?.clean.get(path) : toolPath !== undefined ? tracked(tool)?.clean.get(toolPath) : undefined;
    const length = indexes.get(project)?.length ?? 40;
    let bytes;
    let digest;
    if (known) {
      digest = `git:${known.oid}`;
      if (!inside) toolEntries.push({ path: toolPath, oid: known.oid });
    } else {
      if (inside) { bytes = readFileSync(file); digest = `git:${blobOid(bytes, length)}`; }
      else digest = fileDigest(file, stat);
      rest.push({ file, inside, length, digest });
    }
    files.set(file, { path: inside ? `project:${path}` : file, mode: String(stat.mode), digest });
    let text;
    const source = () => text ??= bytes ? bytes.toString('utf8') : readFileSync(file, 'utf8');
    const flags = [/\.sh$/u.test(file), /\.[cm]?js$/u.test(file), /\.(?:py|rb|pl|php|ts|mjscript)$/u.test(file)].map(Number).join('');
    const key = digest.startsWith('git:') ? `${digest}:${strict ? 1 : 0}:${language}:${flags}` : null;
    let record = key ? edges.get(key) : undefined;
    if (record) used.add(key);
    if (!record) {
      const line = text === undefined && !bytes && flags[1] !== '1' ? firstLine(file) : source().split('\n', 1)[0];
      if (language === 'sh' || flags[0] === '1' || /^#![^\n]*\b(?:ba|da|z)?sh\b/u.test(line)) record = { k: 'sh' };
      else if (language !== 'js' && flags[1] !== '1' && !/^#![^\n]*\bnode\b/u.test(line)) record = /^#!/u.test(line) || flags[2] === '1' ? { k: 'bad' } : { k: 'none' };
      else {
        const local = scanImports(source(), strict);
        record = local ? { k: 'js', local } : { k: 'bad' };
      }
      if (key) { edges.set(key, record); used.add(key); added++; }
    }
    if (record.k === 'bad') throw new Error('checker uses an opaque or unsupported loader');
    if (record.k === 'sh') {
      for (const line of source().split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const words = literalShellWords(trimmed);
        if (!words) throw new Error('opaque shell wrapper');
        if (['exit', 'printf', 'echo', ':', 'true', 'false'].includes(words[0])) continue;
        commandFiles(words[0] === 'exec' ? words.slice(1) : words);
      }
      return;
    }
    if (record.k === 'js') for (const specifier of record.local) visit(localModule(file, specifier), strict, 'js');
  }
  /** Follow the program, its interpreter, and every literal file operand of a wrapper command. */
  function commandFiles(words) {
    if (!words?.length || words.some(word => ['-e', '--eval', '-p', '--print', '-c', '--command', '--require', '-r', '--import', '--loader', '--preserve-symlinks', '--preserve-symlinks-main'].includes(word))) throw new Error('opaque checker command');
    const program = executable(root, words[0]);
    if (!program) throw new Error('checker executable not found');
    visit(program);
    const interpreter = basename(program);
    const language = /^(?:ba|da|z)?sh$/u.test(interpreter) ? 'sh' : /^node(?:\.exe)?$/u.test(interpreter) ? 'js' : '';
    let script = true;
    for (const word of words.slice(1)) {
      const operand = word.startsWith('-') ? word.includes('=') ? word.slice(word.indexOf('=') + 1) : '' : word;
      if (!operand) continue;
      const path = resolve(root, operand);
      try { if (statSync(path).isFile()) { visit(path, true, script ? language : ''); if (!word.startsWith('-')) script = false; } }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
  }
  try {
    visit(process.platform === 'win32' ? process.env.ComSpec : '/bin/sh');
    for (const command of commands) commandFiles(literalShellWords(command));
    for (const file of codeFiles) visit(file, false);
    const result = [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
    unvouched.set(result, { rest, tool: { root: tool, entries: toolEntries } });
    return result;
  } catch { return null; } finally { saveEdges(store); }
}
