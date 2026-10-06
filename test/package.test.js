/**
 * The package stays dependency-free (P3): nothing to install but Node, nothing in node_modules to
 * trust, and every import is a Node built-in or a file of its own.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** A child Node that reports which of the sources on its stdin compile as ES modules. */
const PARSER = [
  "import vm from 'node:vm';",
  "import { readFileSync } from 'node:fs';",
  "const sources = JSON.parse(readFileSync(0, 'utf8'));",
  'const compiles = (source) => { try { new vm.SourceTextModule(source); return true; } catch { return false; } };',
  'process.stdout.write(JSON.stringify(sources.map(compiles)));',
].join('\n');

/**
 * Which sources compile as ES modules, as V8 itself decides, all in one child process.
 *
 * @param {string[]} sources
 * @returns {boolean[]}
 */
function compiles(sources) {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', PARSER], {
    input: JSON.stringify(sources),
    encoding: 'utf8',
    maxBuffer: 2 ** 26,
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

/** Every place the word import or export appears, in code or not. */
const KEYWORD = /(?<![\w$.#])(import|export)(?![\w$])/g;

/**
 * The tokens of a source from one place on: words, strings, templates and single punctuation, with
 * whitespace and comments skipped. Enough to read an import or export declaration.
 *
 * @param {string} source
 * @param {number} at
 * @returns {Generator<{ type: 'word' | 'string' | 'template' | 'punct', text: string }>}
 */
function* tokensFrom(source, at) {
  while (at < source.length) {
    const rest = source.slice(at, at + 4096);
    const space = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(rest);
    if (space) {
      at += space[0].length;
      continue;
    }
    const token = /^(?:(['"])(?:\\[\s\S]|(?!\1)[^\\\n])*\1|`(?:\\[\s\S]|[^\\`])*`|[\p{ID_Continue}$]+)/u.exec(rest);
    if (token) {
      at += token[0].length;
      const type = token[1] ? 'string' : token[0][0] === '`' ? 'template' : 'word';
      yield { type, text: type === 'string' ? token[0].slice(1, -1) : token[0] };
    } else {
      at += 1;
      yield { type: 'punct', text: rest[0] };
    }
  }
}

/**
 * The module an import or export written in code names: import 'x', import('x'), import ... from
 * 'x', or export ... from 'x'. Null when it names none: import.meta, export const, export default,
 * or a dynamic import of a computed name.
 *
 * @param {string} source
 * @param {number} at - Where the keyword starts.
 * @param {'import' | 'export'} keyword
 * @returns {string | null}
 */
function specifierAt(source, at, keyword) {
  const tokens = tokensFrom(source, at + keyword.length);
  const first = tokens.next().value;
  if (!first) return null;
  if (keyword === 'import' && first.type === 'string') return first.text;
  if (keyword === 'import' && first.text === '(') {
    const argument = tokens.next().value;
    return argument?.type === 'string' ? argument.text : null;
  }
  if (keyword === 'export' && first.text !== '*' && first.text !== '{') return null;
  let depth = 0;
  for (let token = first; token; token = tokens.next().value) {
    if (token.text === '{') depth += 1;
    else if (token.text === '}') depth -= 1;
    else if (depth > 0) continue;
    else if (token.type === 'word' && token.text === 'from') {
      const name = tokens.next().value;
      return name?.type === 'string' ? name.text : null;
    } else if (token.type === 'word' ? ['import', 'export'].includes(token.text) : !['*', ','].includes(token.text)) {
      return null;
    }
  }
  return null;
}

/**
 * Every module each source imports, in source order: import and export-from statements, side-effect
 * imports, and dynamic import() with either quote. V8 decides what is code: a NUL put before an
 * import or export keeps a module compiling when the word sits in a string, template, comment or
 * regular expression, and breaks it when the word is code.
 *
 * @param {string[]} sources - Each one a module that compiles.
 * @returns {string[][]}
 */
function importsIn(sources) {
  const found = sources.map((source) => [...source.matchAll(KEYWORD)].map((match) => ({ at: match.index, keyword: match[1] })));
  const marked = sources.flatMap((source, index) => found[index].map(({ at }) => `${source.slice(0, at)}\u0000${source.slice(at)}`));
  const results = compiles([...sources, ...marked]);
  let next = sources.length;
  return sources.map((source, index) => {
    assert.ok(results[index], `does not compile as a module: ${source.slice(0, 80)}`);
    const inCode = found[index].filter(() => !results[next++]);
    return inCode.map(({ at, keyword }) => specifierAt(source, at, keyword)).filter((name) => name !== null);
  });
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
    "const x = {a:1} / await import('left-pad') / 2;": ['left-pad'],
    'if (false) /import("left-pad")/.test("x");': [],
    "for (const key of keys) /'/.test(key); const text = \"import('left-pad')\";": [],
    "const half = count++ / 2; const pad = await import('left-pad');": ['left-pad'],
    "function f() {} /'/.test(x); const pad = await import('left-pad');": ['left-pad'],
    "const wrap = (a) => ({ b: a }) / 2; const pad = await import('left-pad');": ['left-pad'],
    'import "node:fs"; import "left-pad";': ['node:fs', 'left-pad'],
    'import fs from "node:fs"; import pad from "left-pad";': ['node:fs', 'left-pad'],
    'const f = function () {} / await import("left-pad");': ['left-pad'],
    'const C = class {} / await import("left-pad");': ['left-pad'],
    "import { \"a-b\" as ab } from 'left-pad';": ['left-pad'],
    "import data from './data.json' with { type: 'json' };": ['./data.json'],
    'const pad = await import /* why */ ("left-pad");': ['left-pad'],
    'const where = import.meta.url;': [],
    "const pattern = /import('left-pad')/u;": [],
    'export const b = 1;\nexport * from "left-pad";': ['left-pad'],
    'export { a } from "left-pad"; export const b = 1;': ['left-pad'],
    'function later() { return import("left-pad"); }': ['left-pad'],
    "function later() { return \"import('left-pad')\"; }": [],
  };
  const found = importsIn(Object.keys(forms));
  Object.entries(forms).forEach(([source, expected], index) => assert.deepEqual(found[index], expected, source));
});

test('every import is a node: built-in or a relative file [P3]', () => {
  const files = [
    ...readdirSync(join(ROOT, 'src')).map((name) => join(ROOT, 'src', name)),
    join(ROOT, 'bin', 'pullboard.js'),
  ];
  const found = importsIn(files.map((file) => readFileSync(file, 'utf8')));
  files.forEach((file, index) => {
    for (const target of found[index]) assert.ok(target.startsWith('node:') || target.startsWith('.'), `${file} imports ${target}`);
  });
  const seen = found.flat().length;
  assert.ok(seen > 50, `the scan found ${seen} imports in src/ and bin/; expected every file's`);
});
