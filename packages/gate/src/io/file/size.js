#!/usr/bin/env node
/**
 * Rigor check: no source or test file over 1500 lines [D1,C7].
 *
 * A source or test file is any file ending .js, .mjs, .cjs or .css under the root (see scan.js for
 * the walk and what it skips). Its length is its count of lines as an editor numbers them: one per
 * newline, plus one for a last line without a newline.
 *
 * A file over the cap prints one problem per started 100 lines over it: a file of 1501 to 1600
 * lines prints one, 1601 to 1700 two, and so on. Each problem names its block of lines, as
 * `src/cli.js:1601: lines 1601-1700 are over the 1500-line cap`. Why per block: a doctrine count
 * only falls, and one line per file would let an over-cap file grow forever without the count
 * moving. With one per block, adding 100 lines to an over-cap file raises the count by one.
 *
 * @file-local Reads only the files walk() returns, so submit may narrow it to the changed files.
 */
import {
  readText,
  runCheck,
  walk,
} from '../scan.js';

const CAP = 1500;
const BLOCK = 100;

/**
 * The number of lines in a text, as an editor numbers them.
 *
 * @param {string} text
 * @returns {number}
 */
export function lineCount(text) {
  if (!text) return 0;
  const newlines = text.split('\n').length - 1;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

/**
 * One problem per started block of lines over the cap, for every source or test file.
 *
 * @param {string} root
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function fileSizeProblems(root, files = walk(root, /\.(?:[cm]?js|css)$/u), read = path => readText(root, path)) {
  const problems = [];
  for (const path of files.filter(path => /\.(?:[cm]?js|css)$/u.test(path))) {
    const lines = lineCount(read(path));
    for (let first = CAP + 1; first <= lines; first += BLOCK) {
      problems.push({ path, line: first, text: `lines ${first}-${first + BLOCK - 1} are over the ${CAP}-line cap` });
    }
  }
  return problems;
}

runCheck(import.meta, fileSizeProblems);
