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

/**
 * Every module a source file imports: import and export-from statements, braces across lines
 * included, side-effect imports, and dynamic import(), with either quote. A string or comment that
 * merely contains the word from is not an import.
 *
 * @param {string} source
 * @returns {string[]}
 */
function importsIn(source) {
  const statements = /^[ \t]*(?:import|export)\b[^'"`;]*?\bfrom[ \t]*(['"])([^'"]+)\1/gm;
  const sideEffects = /^[ \t]*import[ \t]*(['"])([^'"]+)\1/gm;
  const dynamic = /\bimport\(\s*(['"])([^'"]+)\1\s*\)/g;
  return [statements, sideEffects, dynamic].flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[2]));
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
    "const rule = 'the move starts from'; const next = 'x';": [],
    "// this rule comes from 'left-pad'": [],
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
