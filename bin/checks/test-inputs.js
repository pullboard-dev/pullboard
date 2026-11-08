#!/usr/bin/env node
/**
 * Rigor check: a test that reads source files declares it [D1,C7,V4].
 *
 * Submit selects the tests a change affects through import edges (src/affected-tests.js). A test
 * that reaches source by path, rather than importing it, is invisible to that graph unless its
 * file opens with the header line the selection reads: `/** @pullboard-test-input source-tree *\/`,
 * among the declaration lines at the very top of the file.
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
 *   resolve(import.meta.dirname, '../src') or join(ROOT, 'src', 'cockpit.js').
 *
 * Two kinds of path do not count. A fixture path, such as join(lane, 'src/board.js'), has no
 * anchor: it names a copy inside a temporary repo, not this checkout. A module URL, which the
 * code turns into `.href`, wraps in pathToFileURL(...) or passes to import(...), names a module to
 * import, not a file to read. A test file is `*.test.js` or `*.spec.js`, also .mjs and .cjs. One
 * problem per undeclared test file, at the line of its first anchored source path.
 *
 * @file-local Reads only the files walk() returns, so submit may narrow it to the changed files.
 */
import { lex, lineAt, readText, runCheck, TEST_FILE, walk } from './scan.js';

const SOURCE_TREE_INPUT = '/** @pullboard-test-input source-tree */';
// The browser declaration (// pullboard: browser) is the first line of a file that launches Chrome [C7].
const DECLARATIONS = new Set([SOURCE_TREE_INPUT, '/** @pullboard-test-input test-tree */', '/** @pullboard-test-input docs-tree */', '// pullboard: browser']);
const READ = /(?<![\w$])(?:readFileSync|readFile|readdirSync|readdir|opendirSync|opendir|createReadStream|cpSync|cp|copyFileSync|copyFile)\s*\(/u;
const ANCHOR = /(?<![\w$])import\s*\.\s*meta\s*\.\s*(?:url|dirname|filename)\b|(?<![\w$.])ROOT\b/u;
const SOURCE_PATH = /(?:^|\/)src(?:\/|$)/u;
const OPENERS = '([{';
const CLOSERS = ')]}';

/**
 * True when the file's leading declaration lines include the source-tree input, read as the
 * affected-test selection reads them.
 *
 * @param {string} source
 * @returns {boolean}
 */
export function declaresSource(source) {
  for (const line of source.split(/\r?\n/u)) {
    if (line === SOURCE_TREE_INPUT) return true;
    if (!DECLARATIONS.has(line)) return false;
  }
  return false;
}

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
 * One problem per test file that reads source files without the declaration.
 *
 * @param {string} root
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function testInputProblems(root, files = walk(root, TEST_FILE), read = path => readText(root, path)) {
  const problems = [];
  for (const path of files.filter(path => TEST_FILE.test(path))) {
    const source = read(path);
    if (declaresSource(source)) continue;
    const lexed = lex(source);
    if (!READ.test(lexed.code)) continue;
    const at = firstAnchoredSourcePath(source, lexed);
    if (at !== -1) problems.push({ path, line: lineAt(source, at), text: `reads source files without ${SOURCE_TREE_INPUT} at the top` });
  }
  return problems;
}

runCheck(import.meta, testInputProblems);
