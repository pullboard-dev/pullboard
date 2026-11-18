/** @pullboard-test-input source-cell packages/mcp */
/** The mcp cell's tests declare the inputs they read, so affected-test selection can see them [C7,U149,#9905]. */
/** @pullboard-world-pin: the clauses read the mcp cell's own test files, which are the subject of the declared-inputs rule. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';

const DIR = import.meta.dirname;
const ROOT = join(DIR, '..', '..', '..');
const SELF = 'packages/mcp/tests/inputs.test.js';
// A node:fs read or copy call, as the reader rule counts one.
const READ = /(?<![\w$])(?:readFileSync|readFile|readdirSync|readdir|opendirSync|opendir|createReadStream|cpSync|cp|copyFileSync|copyFile)\s*\(/u;
const CELL_HEADER = /^\/\*\* @pullboard-test-input source-cell((?:\s+[\w.-]+(?:\/[\w.-]+)?)+)\s*\*\/$/u;
// The cells a header may name: the mcp cell alone, as `mcp` or `packages/mcp`.
const ALLOWED = new Set(['mcp', 'packages/mcp']);

/** Every test file under the mcp cell's tests folder, as repo-relative paths. */
function mcpTests(dir = DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return mcpTests(path);
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

test('clause 1: every mcp test file that reads files carries an input header naming the cells it reads [C7,U149]', () => {
  const files = mcpTests();
  assert.ok(files.includes(SELF) && files.length >= 2, 'the mcp cell has test files to check');
  const readers = files.filter(file => READ.test(code(read(file))));
  const undeclared = readers.filter(file => declaredCells(read(file)) === null);
  assert.deepEqual(undeclared, [], 'file readers without a header');
});

test('clause 1: a declared header names only the mcp cell, never the whole source tree [C7,U149]', () => {
  for (const file of mcpTests()) {
    const source = read(file);
    assert.ok(!/^\/\*\* @pullboard-test-input source-tree/mu.test(source), `${file} must not declare source-tree`);
    const cells = declaredCells(source);
    if (cells) assert.ok(cells.every(cell => ALLOWED.has(cell)), `${file} names only cells it reads: ${cells.join(' ')}`);
  }
});

test('clause 1: with the outside-src rule on, no mcp test reads data or fixtures undeclared [C7,U149]', () => {
  const problems = mcpTests().filter(file => {
    const source = read(file);
    return READ.test(code(source)) && /(?:^|\/)(?:tests\/fixtures|data|docs|src)\//u.test(source) && declaredCells(source) === null;
  });
  assert.deepEqual(problems, []);
});
