/**
 * Per cell, how many test files read files and how many of those declare their inputs [C7,#9800].
 *
 * Pure over the file texts it is given: it reads no disk and spawns nothing, so a caller feeds it
 * `{ path, text }` rows from any source. It measures only; it refuses nothing. A reader is a test
 * file whose code (outside strings and comments) has a node:fs read or copy call; it is declared
 * when its leading header lines name its inputs, as the rigor reader judges.
 */
import { lex } from '../../../kernel/index.js';
import { declaresSource } from '../io/test/inputs.js';
import { READ } from '../io/test/inputs.js';

const TEST_NAME = /\.(?:test|spec)\.[cm]?js$/u;
const CELL = /^((?:packages|apps)\/[^/]+)\//u;

/** The cell a test path belongs to, `packages/<name>` or `apps/<name>`, else `other`. */
function cellOf(path) {
  return CELL.exec(path)?.[1] ?? 'other';
}

/**
 * Count, per cell, the test files, those that read files (readers), and how many readers declare their inputs or not.
 *
 * @param {{ path: string, text: string }[]} files
 * @returns {Record<string, { tests: number, readers: number, declared: number, undeclared: number }>}
 */
export function inputCoverage(files) {
  const cells = {};
  for (const { path, text } of files) {
    if (!TEST_NAME.test(path)) continue;
    const row = (cells[cellOf(path)] ??= { tests: 0, readers: 0, declared: 0, undeclared: 0 });
    row.tests += 1;
    if (!READ.test(lex(text).code)) continue;
    row.readers += 1;
    if (declaresSource(text)) row.declared += 1; else row.undeclared += 1;
  }
  return Object.fromEntries(Object.entries(cells).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
