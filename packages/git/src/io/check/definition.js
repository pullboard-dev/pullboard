/** Fingerprint literal checker programs and their local module dependencies without executing them [V4,C7]. */
import { createHash } from 'node:crypto';
import { accessSync } from 'node:fs';
import { constants } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { basename } from 'node:path';
import { delimiter } from 'node:path';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { lex } from '../../../../kernel/light.js';
import { literalShellWords } from '../../../../kernel/light.js';

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
  const found = [target, `${target}.js`, `${target}.json`, `${target}.node`].find(candidate => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  });
  if (!found) throw new Error('checker module cannot be resolved literally');
  return found;
}

/** Longest stretch before a string literal that any context regex below needs to see. */
const contextWindow = 160;

/** The code just before a literal; scanning the whole prefix per literal is quadratic in file length. */
function literalContext(code, start) {
  const window = code.slice(Math.max(0, start - contextWindow), start);
  // A cut can leave half an identifier whose word boundary is false; the real match is never that long.
  return start > contextWindow ? window.replace(/^[\w$]+/u, '') : window;
}

/** Collect tracked project code plus literal external dependencies; opaque external loading misses the cache. */
export function checkCommandDefinition(root, commands, codeFiles = []) {
  const files = new Map();
  const project = realpathSync(root);
  /** Include actual bytes even for symlinks or files outside the checked Git tree. */
  function visit(input, strict = true, language = '') {
    const file = realpathSync(input);
    if (files.has(file)) return;
    if (files.size >= 8192) throw new Error('checker dependency closure is unbounded');
    const stat = statSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error('checker input is not a regular file');
    const path = relative(project, file);
    files.set(file, { path: path.startsWith('..') || isAbsolute(path) ? file : `project:${path}`, mode: String(stat.mode), digest: fileDigest(file, stat) });
    const source = readFileSync(file, 'utf8');
    if (language === 'sh' || /\.sh$/u.test(file) || /^#![^\n]*\b(?:ba|da|z)?sh\b/u.test(source)) {
      for (const line of source.split(/\r?\n/u)) {
        const text = line.trim();
        if (!text || text.startsWith('#')) continue;
        const words = literalShellWords(text);
        if (!words) throw new Error('opaque shell wrapper');
        if (['exit', 'printf', 'echo', ':', 'true', 'false'].includes(words[0])) continue;
        commandFiles(words[0] === 'exec' ? words.slice(1) : words);
      }
      return;
    }
    if (language !== 'js' && !/\.[cm]?js$/u.test(file) && !/^#![^\n]*\bnode\b/u.test(source)) {
      if (/^#!/u.test(source) || /\.(?:py|rb|pl|php|ts|mjscript)$/u.test(file)) throw new Error('unsupported checker loader');
      return;
    }
    const { code, strings } = lex(source);
    const constants = new Map();
    for (const value of strings) {
      const binding = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*$/u.exec(literalContext(code, value.start));
      if (binding && !value.text.includes('\\') && !value.text.includes('${')) constants.set(binding[1], value.text);
    }
    let calls = 0;
    let requires = 0;
    for (const value of strings) {
      const prefix = literalContext(code, value.start);
      const call = /\b(?:require|import)\s*\(\s*$/u.test(prefix);
      if (!call && !/\b(?:from|import)\s*$/u.test(prefix)) continue;
      if (call) { calls++; if (/\brequire\s*\(\s*$/u.test(prefix)) requires++; }
      if (value.text.includes('\\') || value.text.includes('${')) throw new Error('computed checker import');
      if (isBuiltin(value.text)) {
        if (strict && /^(?:node:)?(?:module|vm|child_process)$/u.test(value.text)) throw new Error('opaque checker loader');
        continue;
      }
      if (!value.text.startsWith('.') && !isAbsolute(value.text)) throw new Error('conditional package resolution is not pinned');
      visit(localModule(file, value.text), strict, 'js');
    }
    for (const match of (strict ? code : '').matchAll(/\b(require|import)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/gu)) {
      const specifier = constants.get(match[2]);
      // Only an immutable literal binding with no shadowing can describe a computed loader.
      if (!specifier || [...code.matchAll(new RegExp(`\\b${match[2]}\\b`, 'gu'))].length !== 2) throw new Error('opaque checker loading');
      calls++;
      if (match[1] === 'require') requires++;
      if (!isBuiltin(specifier)) visit(localModule(file, specifier), strict, 'js');
      else if (/^(?:node:)?(?:module|vm|child_process)$/u.test(specifier)) throw new Error('opaque checker loader');
    }
    if (strict && ([...code.matchAll(/\b(?:require|import)\s*\(/gu)].length !== calls || [...code.matchAll(/\brequire\b/gu)].length !== requires || /\b(?:eval|Function|getBuiltinModule|createRequire)\s*\(/u.test(code))) throw new Error('opaque checker loading');
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
    return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
  } catch { return null; }
}
