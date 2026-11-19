/** @pullboard-test-input source-cell packages/transport */
/** The transport cell's tests declare the inputs they read, so affected-test selection can see them [C7,U149,#9996]. */
/** @pullboard-world-pin: the clauses read the transport cell's own test files, which are the subject of the declared-inputs rule. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';

const DIR = import.meta.dirname;
const ROOT = join(DIR, '..', '..', '..');
const SELF = 'packages/transport/tests/inputs.test.js';
/** A file read by path: the same calls the gate's reader rule looks for, kept here so this cell imports no other cell. */
const READS = /(?<![\w$])(?:readFileSync|readFile|readdirSync|readdir|opendirSync|opendir|createReadStream|cpSync|cp|copyFileSync|copyFile)\s*\(/u;
const HEADER = /^\/\*\* @pullboard-test-input (.+) \*\/$/u;

/** Every test file under the transport cell's tests folder, as repo-relative paths. */
function transportTests(dir = DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return transportTests(path);
    return /\.test\.js$/u.test(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const read = path => readFileSync(join(ROOT, path), 'utf8');
/** The input header lines that open a file, as the text after the tag; the first other line ends them, as the gate reads them. */
function headers(source) {
  const found = [];
  for (const line of source.split(/\r?\n/u)) {
    const text = line.match(HEADER)?.[1];
    if (!text) break;
    found.push(text);
  }
  return found;
}

test('transport.inputs.readers-declare-headers: clause 1: every transport test file that reads files carries an input header naming what it reads [C7,U149]', () => {
  const files = transportTests();
  assert.ok(files.includes(SELF) && files.length >= 2, 'the transport cell has test files to check');
  const undeclared = files.filter(file => READS.test(read(file)) && headers(read(file)).length === 0);
  assert.deepEqual(undeclared, [], 'file readers without a header');
  assert.deepEqual(headers(read(SELF)), ['source-cell packages/transport'], 'this file names only the transport cell');
  assert.deepEqual(headers(read('packages/transport/tests/io/ssh.test.js')), ['source-cell packages/transport packages/runners'], 'the ssh test reads both cells it scans');
});

test('transport.inputs.no-whole-tree-header: clause 1: no transport test declares the whole source tree, and a cell header names cells by path [C7,U149]', () => {
  for (const file of transportTests()) {
    for (const header of headers(read(file))) {
      assert.notEqual(header.trim(), 'source-tree', `${file} declares source-tree`);
      if (header.startsWith('source-cell')) assert.match(header, /^source-cell packages\/[a-z]+(?: packages\/[a-z]+)*$/u, `${file} names cells by path`);
    }
  }
});
