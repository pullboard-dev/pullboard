#!/usr/bin/env node
/**
 * Rigor check: a test that reads source files declares it [D1,C7,V4].
 *
 * Submit selects the tests a change affects through import edges (src/affected-tests.js). A test
 * that reaches source by path, rather than importing it, is invisible to that graph unless its
 * file opens with the header line the selection reads: `/** @pullboard-test-input source-tree *\/`,
 * among the declaration lines at the very top of the file; a header naming the exact files the test
 * reads instead of the whole tree declares it too, and selects it for those files alone. `/** @pullboard-test-input source-cell <cell> *\/` names the cells read instead.
 *
 * The rule is per file, because a path is often built on one line and read on another (a variable,
 * a queue of files to walk). A test file reads source files when its code (outside strings and
 * comments) has both of these anywhere:
 * - a node:fs read or copy call: readFileSync, readFile, readdirSync, readdir, opendirSync,
 *   opendir, createReadStream, cpSync, cp, copyFileSync or copyFile;
 * - an anchored source path: a string or template literal naming the source tree (`src` as a whole
 *   path segment; for a template, in its text before the first `${`) that is a direct argument of
 *   a call whose own arguments include `import.meta.url`, `import.meta.dirname`,
 *   `import.meta.filename` or a `ROOT` constant, as in new URL('../src/x.js', import.meta.url),
 *   resolve(import.meta.dirname, '../src') or join(ROOT, 'src/cockpit.js').
 *
 * Two kinds of path do not count. A fixture path, such as join(lane, 'src/board.js'), has no
 * anchor: it names a copy inside a temporary repo, not this checkout. A module URL, which the
 * code turns into `.href`, wraps in pathToFileURL(...) or passes to import(...), names a module to
 * import, not a file to read. A test file is `*.test.js` or `*.spec.js`, also .mjs and .cjs. One
 * problem per undeclared test file, at the line of its first anchored source path.
 *
 * @file-local Reads only the files walk() returns, so submit may narrow it to the changed files.
 */
import { posix } from 'node:path';
import { DECLARED_READ_PATH } from '../../logic/input-declaration.js';
import { declaredReadPatterns } from '../../logic/input-declaration.js';
import { declaresSource } from '../../logic/input-declaration.js';
import { readIsDeclared } from '../../logic/input-declaration.js';
import { READ } from '../../logic/input-declaration.js';
import { SOURCE_TREE_INPUT } from '../../logic/input-declaration.js';
import {
  lex,
  lineAt,
  readText,
  runCheck,
  TEST_FILE,
  walk,
} from '../scan.js';

export { declaresSource, READ };

const ANCHOR = /(?<![\w$])import\s*\.\s*meta\s*\.\s*(?:url|dirname|filename)\b|(?<![\w$.])ROOT\b/u;
const SOURCE_PATH = /(?:^|\/)src(?:\/|$)/u;
// With tests.requireDeclaredInputs on, a read path under tests/fixtures, data or docs is an input too, held to a header naming it [C7,#9801,#12055].
const OUTSIDE_SRC_PATH = /(?:^|\/)(?:tests\/fixtures|data|docs)(?:\/|$)/u;
const OPENERS = '([{';
const CLOSERS = ')]}';

/** The offset of the innermost bracket that encloses `at` in blanked code, or -1. */
function enclosing(code, at) {
  let depth = 0;
  for (let index = at - 1; index >= 0; index -= 1) {
    if (CLOSERS.includes(code[index])) depth += 1;
    else if (OPENERS.includes(code[index])) {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

/** The offset of the bracket that closes the one at `open`, or the end of the code. */
function closing(code, open) {
  let depth = 0;
  for (let index = open + 1; index < code.length; index += 1) {
    if (OPENERS.includes(code[index])) depth += 1;
    else if (CLOSERS.includes(code[index])) {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return code.length;
}

/** The code between two brackets at their own depth, with anything nested deeper blanked. */
function ownArguments(code, open, close) {
  let text = '';
  let depth = 0;
  for (let index = open + 1; index < close; index += 1) {
    const char = code[index];
    if (OPENERS.includes(char)) depth += 1;
    else if (CLOSERS.includes(char)) depth -= 1;
    else text += depth === 0 ? char : ' ';
  }
  return text;
}

/**
 * True when the call that opens at `open` names a module to import: it, or the call wrapping it,
 * is followed by `.href`, is wrapped in pathToFileURL(...), or is the argument of import(...).
 */
function moduleUrl(code, open, close) {
  const callee = code.slice(0, open).trimEnd();
  if (/(?<![\w$.])import$/u.test(callee)) return true;
  if (/^\s*\.\s*href\b/u.test(code.slice(close + 1))) return true;
  const outer = enclosing(code, open);
  if (outer === -1 || code[outer] !== '(') return false;
  const wrapper = code.slice(0, outer).trimEnd();
  return /(?<![\w$.])(?:pathToFileURL|import)$/u.test(wrapper) || /^\s*\.\s*href\b/u.test(code.slice(closing(code, outer) + 1));
}

/**
 * The offset of the first anchored source path in a file's code, or -1.
 *
 * @param {string} source
 * @param {ReturnType<typeof lex>} lexed
 * @returns {number}
 */
function firstAnchoredSourcePath(source, { code, strings }) {
  for (const literal of strings) {
    const text = source[literal.start] === '`' ? literal.text.split('${')[0] : literal.text;
    if (!SOURCE_PATH.test(text)) continue;
    const open = enclosing(code, literal.start);
    if (open === -1 || code[open] !== '(') continue;
    const close = closing(code, open);
    if (!ANCHOR.test(ownArguments(code, open, close)) || moduleUrl(code, open, close)) continue;
    return literal.start;
  }
  return -1;
}

/**
 * One problem per test file that reads source files without the declaration. With
 * tests.requireDeclaredInputs on (`outsideSrc`, passed in by the static registry so this file reads no setting), reads of
 * a cell's data, tests (the folder itself included) or journeys folder, or docs, count too and each must be named by a
 * header line or a glob over it, never by a source-cell, source-tree or bare ** line (#12055); off keeps the source-tree rule alone.
 *
 * @param {string} root
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function testInputProblems(root, files = walk(root, TEST_FILE), read = path => readText(root, path), outsideSrc = false) {
  const problems = [];
  for (const path of files.filter(path => TEST_FILE.test(path))) {
    const source = read(path);
    const declared = declaresSource(source);
    if (declared && !outsideSrc) continue;
    const lexed = lex(source);
    if (!READ.test(lexed.code)) continue;
    const at = declared ? -1 : firstAnchoredSourcePath(source, lexed);
    // With the setting on, a data, tests or journeys read needs a header naming it, whatever other header the file has [C7,#12055].
    const exact = outsideSrc ? firstUndeclaredRead(path, source, lexed) : null;
    if (at !== -1 && (!exact || at <= exact.offset)) problems.push({ path, line: lineAt(source, at), text: `reads source files without ${SOURCE_TREE_INPUT} at the top` });
    else if (exact) problems.push({ path, line: lineAt(source, exact.offset), text: `reads ${exact.read} without a header naming it` });
  }
  return problems;
}

const BINDING = /(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gu;
const WORD = /[A-Za-z_$][\w$]*/gu;
/** A call that builds or reads a path; only these carry a read's path parts. */
const PATH_CALL = /(?<![\w$])(?:join|resolve|URL|fileURLToPath|existsSync|statSync|readFileSync|readFile|readdirSync|readdir|opendirSync|opendir|createReadStream|cpSync|cp|copyFileSync|copyFile)\s*$/u;
/** An argument that is no path part: an encoding name, or text with spaces or a heading mark. */
const NOT_PATH = /^(?:utf-?8|ascii|latin1|base64|hex|binary)$|[\s#]/iu;

/** The literal text a string contributes to a path: a template's text before its first `${`. */
function literalText(source, literal) {
  return source[literal.start] === '`' ? literal.text.split('${')[0] : literal.text;
}

/** The string literals that are direct arguments of the call opening at `open`. */
function ownStrings(code, strings, open, close, source) {
  return strings.filter(literal => literal.start > open && literal.start < close && enclosing(code, literal.start) === open
    && !(source && NOT_PATH.test(literalText(source, literal))));
}

/**
 * The repo folder a top-level binding names when it is built from import.meta, ROOT or another such binding, such as
 * `const DIR = import.meta.dirname` or `const FIXTURES = join(DIR, 'fixtures')`; by name, in order of appearance [C7,#12055].
 */
function anchoredBindings(path, source, { code, strings }) {
  const bindings = new Map();
  for (const match of code.matchAll(BINDING)) {
    const from = match.index + match[0].length;
    const end = code.indexOf('\n', from) === -1 ? code.length : code.indexOf('\n', from);
    const rhs = code.slice(from, end);
    if (rhs.includes('[') || rhs.includes('=>') || READ.test(rhs) || /\bJSON\b/u.test(rhs)) continue;
    let base = null;
    if (/(?<![\w$])import\s*\.\s*meta\s*\.\s*(?:url|dirname|filename)\b/u.test(rhs)) base = posix.dirname(path);
    else {
      const named = [...rhs.matchAll(WORD)].map(word => word[0]).find(word => bindings.has(word));
      if (named !== undefined) base = bindings.get(named);
      else if (/(?<![\w$.])ROOT\b/u.test(rhs)) base = '.';
    }
    if (base === null) continue;
    const parts = strings.filter(literal => literal.start >= from && literal.start < end).map(literal => literalText(source, literal)).filter(part => !NOT_PATH.test(part));
    bindings.set(match[1], posix.normalize(posix.join(base, ...parts)));
  }
  return bindings;
}

/** The base folder an anchored call's own arguments start from, or null: import.meta is the file's folder, ROOT the repo. */
function callBase(path, args, bindings) {
  if (/(?<![\w$])import\s*\.\s*meta\s*\.\s*(?:url|dirname|filename)\b/u.test(args)) return posix.dirname(path);
  for (const word of args.matchAll(WORD)) if (bindings.has(word[0])) return bindings.get(word[0]);
  return /(?<![\w$.])ROOT\b/u.test(args) ? '.' : null;
}

/** True when a resolved read path is one the exact rule holds to a header. */
function heldPath(read) {
  return read.startsWith('../') ? OUTSIDE_SRC_PATH.test(read) : DECLARED_READ_PATH.test(read);
}

/**
 * The first read of a data, tests or journeys path (or docs) that no header line names, or null. A read is an anchored call
 * or a binding to one: the call's own string arguments joined onto its base (`join(DIR, 'fixtures', 'registry.json')`), a
 * bare anchored folder (`readdirSync(DIR)`), or, when an anchored call also takes a computed name, any repo path literal
 * under that call's base (a constant list of journey files the test reads by name) [C7,#12055].
 *
 * @param {string} path the test file, relative to the repository root
 * @param {string} source
 * @param {ReturnType<typeof lex>} lexed
 * @returns {{ offset: number, read: string } | null}
 */
export function firstUndeclaredRead(path, source, lexed) {
  const { code, strings } = lexed;
  const patterns = declaredReadPatterns(source);
  const bindings = anchoredBindings(path, source, lexed);
  const reads = [];
  const computed = [];
  const seen = new Set();
  const consider = (offset, base, parts, args) => {
    const read = posix.normalize(posix.join(base, ...parts));
    reads.push({ offset, read });
    const names = [...args.matchAll(WORD)].map(word => word[0]).filter(word => !bindings.has(word) && !['import', 'meta', 'url', 'dirname', 'filename', 'ROOT', 'new', 'URL'].includes(word));
    if (names.length) computed.push(read);
  };
  for (const literal of strings) {
    const open = enclosing(code, literal.start);
    if (open === -1 || code[open] !== '(' || seen.has(open) || !PATH_CALL.test(code.slice(Math.max(0, open - 40), open))) continue;
    const close = closing(code, open);
    const args = ownArguments(code, open, close);
    const base = callBase(path, args, bindings);
    if (base === null || moduleUrl(code, open, close)) continue;
    seen.add(open);
    consider(literal.start, base, ownStrings(code, strings, open, close, source).map(own => literalText(source, own)), args);
  }
  for (const match of code.matchAll(new RegExp(READ.source, 'gu'))) {
    const open = match.index + match[0].length - 1;
    const close = closing(code, open);
    const args = ownArguments(code, open, close);
    if (seen.has(open) || ownStrings(code, strings, open, close).length) continue;
    const first = /^\s*([A-Za-z_$][\w$]*)\s*(?:[,)]|$)/u.exec(args);
    if (first && bindings.has(first[1])) reads.push({ offset: open, read: bindings.get(first[1]) });
  }
  for (const literal of strings) {
    const text = literalText(source, literal);
    if (!DECLARED_READ_PATH.test(text) || text.includes('*')) continue;
    const read = posix.normalize(text);
    if (computed.some(base => base === '.' || read.startsWith(`${base}/`))) reads.push({ offset: literal.start, read });
  }
  const missing = reads.filter(({ read }) => heldPath(read) && !readIsDeclared(patterns, read)).sort((a, b) => a.offset - b.offset);
  return missing[0] ?? null;
}

runCheck(import.meta, testInputProblems);
