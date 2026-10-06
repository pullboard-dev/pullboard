/**
 * The package stays dependency-free (P3): nothing to install but Node, nothing in node_modules to
 * trust, and every import is a Node built-in or a file of its own.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** Words after which a slash starts a regular expression rather than a division. */
const BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * The source with every comment, and the inside of every string, template and regular expression,
 * blanked character for character: line breaks and quotes stay, and a string's inside becomes x's.
 * So an import found in the masked text is code, and sits where the source has it.
 *
 * @param {string} source
 * @returns {string}
 */
function maskLiterals(source) {
  const out = source.split('');
  const fill = (from, to, char) => {
    for (let index = from; index < to; index += 1) if (out[index] !== '\n') out[index] = char;
  };
  const templates = [];
  let depth = 0;
  let previous = '';
  let at = source.startsWith('#!') ? source.indexOf('\n') : 0;
  if (at === -1) at = source.length;
  fill(0, at, ' ');
  const readTemplate = () => {
    const start = at;
    while (at < source.length) {
      if (source[at] === '\\') at += 2;
      else if (source[at] === '`') break;
      else if (source[at] === '$' && source[at + 1] === '{') break;
      else at += 1;
    }
    fill(start, at, ' ');
    if (source[at] === '$') {
      templates.push(depth);
      depth += 1;
      previous = '{';
      at += 2;
    } else {
      previous = 'x';
      at += 1;
    }
  };
  while (at < source.length) {
    const char = source[at];
    const next = source[at + 1];
    if (char === '/' && (next === '/' || next === '*')) {
      const end = next === '/' ? source.indexOf('\n', at) : source.indexOf('*/', at + 2) + 2;
      const stop = end < at ? source.length : end;
      fill(at, stop, ' ');
      at = stop;
    } else if (char === "'" || char === '"') {
      let end = at + 1;
      while (end < source.length && source[end] !== char && source[end] !== '\n') end += source[end] === '\\' ? 2 : 1;
      fill(at + 1, end, 'x');
      at = end + 1;
      previous = 'x';
    } else if (char === '`') {
      at += 1;
      readTemplate();
    } else if (char === '/' && (previous === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(previous) || BEFORE_REGEX.has(previous))) {
      let end = at + 1;
      let inClass = false;
      while (end < source.length && source[end] !== '\n' && (inClass || source[end] !== '/')) {
        if (source[end] === '[') inClass = true;
        if (source[end] === ']') inClass = false;
        end += source[end] === '\\' ? 2 : 1;
      }
      fill(at + 1, end, ' ');
      at = end + 1;
      previous = 'x';
    } else if (char === '}' && templates.at(-1) === depth - 1) {
      templates.pop();
      depth -= 1;
      at += 1;
      readTemplate();
    } else if (/[\w$]/.test(char)) {
      const word = /^[\w$]+/.exec(source.slice(at, at + 64))[0];
      previous = word;
      at += word.length;
    } else {
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      if (!/\s/.test(char)) previous = char;
      at += 1;
    }
  }
  return out.join('');
}

/**
 * Every module a source file imports: import and export-from statements, braces and line breaks
 * included, side-effect imports, and dynamic import(), with either quote. Text inside a comment, a
 * string, a template or a regular expression is not code, so it is never read as an import.
 *
 * @param {string} source
 * @returns {string[]}
 */
function importsIn(source) {
  const masked = maskLiterals(source);
  const patterns = [
    /^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom\s*(['"])([^'"]*)\1/dgm,
    /^[ \t]*import\s*(['"])([^'"]*)\1/dgm,
    /\bimport\s*\(\s*(['"])([^'"]*)\1\s*\)/dg,
  ];
  return patterns
    .flatMap((pattern) => [...masked.matchAll(pattern)])
    .sort((a, b) => a.index - b.index)
    .map((match) => source.slice(...match.indices[2]));
}

test('no dependencies of any kind, and Node 22.13 or newer [P3]', () => {
  assert.equal(PACKAGE.dependencies, undefined);
  assert.equal(PACKAGE.devDependencies, undefined);
  assert.equal(PACKAGE.engines.node, '>=22.13');
});

test('the import scan finds a package however it is imported, and nothing that is not an import [P3]', () => {
  const forms = {
    "import pad from 'left-pad';": ['left-pad'],
    'import pad from "left-pad";': ['left-pad'],
    'import {\n  a,\n  b,\n} from "left-pad";': ['left-pad'],
    "export { a } from 'left-pad';": ['left-pad'],
    'export * from "left-pad";': ['left-pad'],
    "import 'left-pad';": ['left-pad'],
    'import "left-pad";': ['left-pad'],
    "const pad = await import('left-pad');": ['left-pad'],
    'const pad = await import( "left-pad" );': ['left-pad'],
    'import pad\n  from "left-pad";': ['left-pad'],
    "const pad = await import ('left-pad');": ['left-pad'],
    "const half = total / 2; const pad = await import('left-pad');": ['left-pad'],
    "const page = `${'a'} b`; const pad = await import('left-pad');": ['left-pad'],
    "const rule = 'the move starts from'; const next = 'x';": [],
    "// this rule comes from 'left-pad'": [],
    "/*\nimport fake from 'left-pad';\n*/": [],
    "const page = `\nimport fake from 'left-pad';\n`;": [],
    "const code = \"await import('left-pad')\";": [],
    "const quote = /'/g; const text = \"import fake from 'left-pad'\";": [],
    "export const FROM = 'from';": [],
  };
  for (const [source, expected] of Object.entries(forms)) assert.deepEqual(importsIn(source), expected, source);
});

test('every import is a node: built-in or a relative file [P3]', () => {
  const files = [
    ...readdirSync(join(ROOT, 'src')).map((name) => join(ROOT, 'src', name)),
    join(ROOT, 'bin', 'pullboard.js'),
  ];
  let seen = 0;
  for (const file of files) {
    for (const target of importsIn(readFileSync(file, 'utf8'))) {
      seen += 1;
      assert.ok(target.startsWith('node:') || target.startsWith('.'), `${file} imports ${target}`);
    }
  }
  assert.ok(seen > 50, `the scan found ${seen} imports in src/ and bin/; expected every file's`);
});
