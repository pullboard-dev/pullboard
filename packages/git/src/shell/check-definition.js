import { tryGit } from './git.js';
/** Fingerprint literal checker programs and their local module dependencies without executing them [V4,C7]. */
import { createHash } from 'node:crypto';
import { accessSync } from 'node:fs';
import { constants } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { delimiter } from 'node:path';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { lex } from '../../../kernel/index.js';
import { literalShellWords } from '../../../kernel/index.js';

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

/** Collect tracked project code plus literal external dependencies; opaque external loading misses the cache. */
export function checkCommandDefinition(root, commands) {
  const files = new Map();
  const listed = tryGit(root, ['ls-files', '-z']);
  if (listed.status !== 0) return null;
  const tracked = new Set(listed.stdout.split('\0'));
  const project = realpathSync(root);
  /** Include actual bytes even for symlinks or files outside the checked Git tree. */
  function visit(input) {
    const file = realpathSync(input);
    if (files.has(file)) return;
    if (files.size >= 8192) throw new Error('checker dependency closure is unbounded');
    const stat = statSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error('checker input is not a regular file');
    const path = relative(project, file);
    const projectCode = tracked.has(path);
    files.set(file, { path: path.startsWith('..') || isAbsolute(path) ? file : `project:${path}`, mode: String(stat.mode), digest: fileDigest(file, stat) });
    if (!/\.[cm]?js$/u.test(file)) return;
    const { code, strings } = lex(readFileSync(file, 'utf8'));
    let calls = 0;
    let requires = 0;
    for (const value of strings) {
      const prefix = code.slice(0, value.start);
      const call = /\b(?:require|import)\s*\(\s*$/u.test(prefix);
      if (!call && !/\b(?:from|import)\s*$/u.test(prefix)) continue;
      if (call) { calls++; if (/\brequire\s*\(\s*$/u.test(prefix)) requires++; }
      if (value.text.includes('\\') || value.text.includes('${')) throw new Error('computed checker import');
      if (isBuiltin(value.text)) {
        if (!projectCode && /^(?:node:)?(?:module|vm|child_process)$/u.test(value.text)) throw new Error('opaque external loader');
        continue;
      }
      if (!value.text.startsWith('.') && !isAbsolute(value.text)) throw new Error('conditional package resolution is not pinned');
      visit(localModule(file, value.text));
    }
    if (!projectCode && ([...code.matchAll(/\b(?:require|import)\s*\(/gu)].length !== calls || [...code.matchAll(/\brequire\b/gu)].length !== requires || /\b(?:eval|Function)\s*\(/u.test(code))) throw new Error('opaque checker loading');
  }
  try {
    for (const command of commands) {
      const words = literalShellWords(command);
      if (!words || words.some(word => ['-e', '--eval', '-p', '--print', '-c', '--command'].includes(word))) return null;
      const program = executable(root, words[0]);
      if (!program) return null;
      visit(process.platform === 'win32' ? process.env.ComSpec : '/bin/sh');
      visit(program);
      for (const word of words.slice(1)) {
        const operand = word.startsWith('-') ? word.includes('=') ? word.slice(word.indexOf('=') + 1) : '' : word;
        if (!operand) continue;
        const path = resolve(root, operand);
        try { if (statSync(path).isFile()) visit(path); }
        catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
      }
    }
    return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
  } catch { return null; }
}
