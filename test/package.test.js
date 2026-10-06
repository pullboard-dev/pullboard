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

/**
 * A child Node that compiles each source on its stdin as an ES module and reports, for each, whether
 * it compiles and the modules it imports statically, as V8 lists them.
 */
const PARSER = [
  "import vm from 'node:vm';",
  "import { readFileSync } from 'node:fs';",
  "const sources = JSON.parse(readFileSync(0, 'utf8'));",
  'const look = (source) => {',
  '  try {',
  '    const module = new vm.SourceTextModule(source);',
  '    return { compiles: true, imports: module.moduleRequests ? module.moduleRequests.map((request) => request.specifier) : module.dependencySpecifiers };',
  '  } catch {',
  '    return { compiles: false, imports: [] };',
  '  }',
  '};',
  'process.stdout.write(JSON.stringify(sources.map(look)));',
].join('\n');

/**
 * What V8 makes of each source, all in one child process.
 *
 * @param {string[]} sources
 * @returns {{ compiles: boolean, imports: string[] }[]}
 */
function look(sources) {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', PARSER], {
    input: JSON.stringify(sources),
    encoding: 'utf8',
    maxBuffer: 2 ** 26,
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

/** Every place the word import appears, in code or not. */
const IMPORT = /(?<![\w$.#])import(?![\w$])/g;

/** Whitespace and comments, which may sit between import, its parenthesis and its argument. A line comment ends at any line terminator. */
const GAP = /^(?:\s|\/\/[^\n\r\u2028\u2029]*|\/\*[\s\S]*?\*\/)*/;

/** What a dynamic import of anything but a plain string loads: unknown, so never node: or relative. */
const COMPUTED = '(computed)';

/**
 * What an import(...) call at `at` loads: its argument when that is one plain string,
 * decoded, or COMPUTED for anything else. Null when the word is not followed by a parenthesis: a
 * declaration, which V8 lists, or import.meta.
 *
 * @param {string} source
 * @param {number} at
 * @returns {string | null}
 */
function dynamicAt(source, at) {
  const skip = (text) => text.slice(GAP.exec(text)[0].length);
  const call = skip(source.slice(at + 'import'.length));
  if (call[0] !== '(') return null;
  const argument = skip(call.slice(1));
  const literal = /^(['"])(?:\\[\s\S]|(?!\1)[^\\\n\r])*\1/.exec(argument);
  if (!literal) return COMPUTED;
  const after = skip(argument.slice(literal[0].length))[0];
  return after === ')' || after === ',' ? new Function(`return ${literal[0]};`)() : COMPUTED;
}

/**
 * Every module each source imports. V8 lists the static ones: import and export-from statements and
 * side-effect imports. For import() calls V8 decides what is code: a NUL put before the word keeps
 * the module compiling when the word sits in a string, template, comment or regular expression,
 * and breaks it when the word is code. A call's argument must be one plain string, or the scan
 * reports it as COMPUTED, which no rule allows.
 *
 * @param {string[]} sources - Each one a module that compiles.
 * @returns {string[][]}
 */
function importsIn(sources) {
  const calls = sources.map((source) => [...source.matchAll(IMPORT)].map((match) => match.index).filter((at) => dynamicAt(source, at) !== null));
  const marked = sources.flatMap((source, index) => calls[index].map((at) => `${source.slice(0, at)}\u0000${source.slice(at)}`));
  const looks = look([...sources, ...marked]);
  let next = sources.length;
  return sources.map((source, index) => {
    assert.ok(looks[index].compiles, `does not compile as a module: ${source.slice(0, 80)}`);
    const dynamic = calls[index].filter(() => !looks[next++].compiles).map((at) => dynamicAt(source, at));
    return [...looks[index].imports, ...dynamic];
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
    'import { "{" as brace } from "left-pad";': ['left-pad'],
    'import pad // note\u2028from "left-pad";': ['left-pad'],
    'import "node:fs"; import "node:fs";': ['node:fs'],
    'const pad = await import(("left-pad"));': ['(computed)'],
    'const pad = await import("left" + "-pad");': ['(computed)'],
    'const pad = await import("left\\u002dpad");': ['left-pad'],
    "const pad = await import(/* why */ 'left-pad' /* still */, { with: {} });": ['left-pad'],
    'function later() { return import("left-pad"); }': ['left-pad'],
    "function later() { return \"import('left-pad')\"; }": [],
  };
  const found = importsIn(Object.keys(forms));
  const set = (names) => [...new Set(names)].sort();
  Object.entries(forms).forEach(([source, expected], index) => assert.deepEqual(set(found[index]), set(expected), source));
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
