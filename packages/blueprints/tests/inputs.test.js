/** @pullboard-test-input source-cell packages/blueprints */
/** The blueprints cell's tests declare the inputs they read, so affected-test selection can see them [C7,U149,#9902]. */
/** @pullboard-world-pin: the clauses read the blueprints cell's own test files, which are the subject of the declared-inputs rule. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';

const DIR = import.meta.dirname;
const ROOT = join(DIR, '..', '..', '..');
const SELF = 'packages/blueprints/tests/inputs.test.js';
// A node:fs read or copy call, as the reader rule counts one.
const READ = /(?<![\w$])(?:readFileSync|readFile|readdirSync|readdir|opendirSync|opendir|createReadStream|cpSync|cp|copyFileSync|copyFile)\s*\(/u;
const CELL_HEADER = /^\/\*\* @pullboard-test-input source-cell((?:\s+[\w.-]+(?:\/[\w.-]+)?)+)\s*\*\/$/u;
// The cells a header may name: the blueprints cell alone, as `blueprints` or `packages/blueprints`.
const ALLOWED = new Set(['blueprints', 'packages/blueprints']);

/** Every test file under the blueprints cell's tests folder, as repo-relative paths. */
function blueprintTests(dir = DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return blueprintTests(path);
    return /\.test\.js$/u.test(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const read = path => readFileSync(join(ROOT, path), 'utf8');

/** The source with comments blanked, so a commented call is not a read; strings stay, which only over-reports. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

/** The cells named by the leading source-cell header, or null when the file has none. */
function declaredCells(source) {
  for (const line of source.split(/\r?\n/u)) {
    const match = CELL_HEADER.exec(line.trim());
    if (match) return match[1].trim().split(/\s+/u);
    if (!/^(?:\/\*\* @pullboard-|\/\/ pullboard:)/u.test(line) && !/^\/\*\*.*\*\/$/u.test(line)) return null;
  }
  return null;
}

test('blueprints.inputs.every-blueprints-test-file-that-reads-files: clause 1: every blueprints test file that reads files carries an input header naming the cells it reads [C7,U149]', () => {
  const files = blueprintTests();
  assert.ok(files.includes(SELF) && files.length >= 2, 'the blueprints cell has test files to check');
  const readers = files.filter(file => READ.test(code(read(file))));
  assert.ok(readers.includes('packages/blueprints/tests/io/main.test.js'), 'the bundled-blueprint test reads its data files');
  const undeclared = readers.filter(file => declaredCells(read(file)) === null);
  assert.deepEqual(undeclared, [], 'file readers without a header');
});

test('blueprints.inputs.a-declared-header-names-only-the-blueprints: clause 1: a declared header names only the blueprints cell, never the whole source tree [C7,U149]', () => {
  for (const file of blueprintTests()) {
    const source = read(file);
    assert.ok(!/^\/\*\* @pullboard-test-input source-tree/mu.test(source), `${file} must not declare source-tree`);
    const cells = declaredCells(source);
    if (cells) assert.ok(cells.every(cell => ALLOWED.has(cell)), `${file} names only cells it reads: ${cells.join(' ')}`);
  }
  assert.deepEqual(declaredCells(read('packages/blueprints/tests/io/main.test.js')), ['packages/blueprints']);
});

test('blueprints.inputs.with-the-outside-src-rule-on-no: clause 1: with the outside-src rule on, no blueprints test reads data or fixtures undeclared [C7,U149]', () => {
  const problems = blueprintTests().filter(file => {
    const source = read(file);
    return READ.test(code(source)) && /(?:^|\/)(?:tests\/fixtures|data|docs|src)\//u.test(source) && declaredCells(source) === null;
  });
  assert.deepEqual(problems, []);
});
