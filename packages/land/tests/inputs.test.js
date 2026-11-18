/** @pullboard-test-input source-cell packages/land */
/** The land cell's tests declare the inputs they read, so affected-test selection can see them [C7,U149,#9969]. */
/** @pullboard-world-pin: the clauses read the land cell's own test files, which are the subject of the declared-inputs rule. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';

const DIR = import.meta.dirname;
const ROOT = join(DIR, '..', '..', '..');
const SELF = 'packages/land/tests/inputs.test.js';
/** A file read by path: the same calls the gate's reader rule looks for, kept here so the cell imports no other cell. */
const READS = /(?<![\w$])(?:readFileSync|readFile|readdirSync|readdir|opendirSync|opendir|createReadStream|cpSync|cp|copyFileSync|copyFile)\s*\(/u;
const HEADER = /^\/\*\* @pullboard-test-input (.+) \*\/$/u;

/** Every test file under the land cell's tests folder, as repo-relative paths. */
function landTests(dir = DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return landTests(path);
    return /\.test\.js$/u.test(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const read = path => readFileSync(join(ROOT, path), 'utf8');
/** The input header lines in a file's leading comment lines, as the text after the tag. */
const headers = source => source.split(/\r?\n/u).slice(0, 5).map(line => line.match(HEADER)?.[1]).filter(Boolean);

test('land.inputs.declared: clause 1: every land test file that reads files carries an input header naming the cells it reads [C7,U149]', () => {
  const files = landTests();
  assert.ok(files.includes(SELF) && files.length >= 2, 'the land cell has test files to check');
  const undeclared = files.filter(file => READS.test(read(file)) && headers(read(file)).length === 0);
  assert.deepEqual(undeclared, [], 'file readers without a header');
  assert.deepEqual(headers(read(SELF)), ['source-cell packages/land'], 'this file names only the land cell');
});

/** The header shapes the gate's reader rule accepts without the whole tree: `source-cell` with cells, or exact repo paths. */
const NAMES_CELLS_OR_PATHS = /^(?:source-cell (?:packages|apps)\/[a-z]+(?: (?:packages|apps)\/[a-z]+)*|(?:packages|apps)\/\S+(?: (?:packages|apps)\/\S+)*)$/u;

test('land.inputs.rule-clean: clause 2: every land test header names cells or files by path and none declares the whole source tree [C7,U149]', () => {
  const files = landTests();
  assert.ok(files.some(file => headers(read(file)).length > 0), 'the scan sees headers');
  for (const file of files) {
    for (const header of headers(read(file))) {
      assert.notEqual(header.trim(), 'source-tree', `${file} declares the whole tree`);
      assert.match(header, NAMES_CELLS_OR_PATHS, `${file} names cells or files by path`);
    }
  }
  for (const bad of ['source-tree', 'x', 'source-cell', 'source-cell land', 'source-cell packages/land, apps/cli', '   ']) {
    assert.doesNotMatch(bad, NAMES_CELLS_OR_PATHS, `the rule rejects "${bad}"`);
  }
  assert.match('source-cell packages/land apps/cli', NAMES_CELLS_OR_PATHS);
  assert.equal(headers('/** @pullboard-test-input source-tree */\n')[0], 'source-tree', 'the scan reads a tree declaration so the rule can refuse it');
});
