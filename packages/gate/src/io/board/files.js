#!/usr/bin/env node
/** Name file-backed board opens in tests and refuse growth of the unclassified debt [C7]. */
import { fileSystemAdapter } from '../../../../fs/index.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { BOARD_FILE_BASELINE } from './baseline.js';
import {
  lex,
  lineAt,
  readText,
  report,
  TEST_FILE,
  walk,
} from '../scan.js';

/** The file system this file reads through, so a test can hand a fake one [C7]. */
const disk = fileSystemAdapter();

/**
 * Find production board opens whose first argument is not the literal :memory:.
 * Existing unclassified sites are debt, not an assertion that they test persistence.
 * An adjacent comment names a deliberate persistence, locking, migration or journey boundary.
 */
export function boardFileOpens(source, path) {
  const { code, strings, comments } = lex(source);
  const names = new Set(['openBoard']);
  for (const match of code.matchAll(/\bimport\s*\{([^}]+)\}/gu)) {
    for (const alias of match[1].matchAll(/\bopenBoard\s+as\s+(\w+)/gu)) names.add(alias[1]);
  }
  const calls = new RegExp(`\\b(?:${[...names].join('|')})\\s*\\(`, 'gu');
  const found = [];
  for (const match of code.matchAll(calls)) {
    const argument = match.index + match[0].length;
    const first = argument + code.slice(argument).search(/\S/u);
    const literal = strings.find(value => value.start === first);
    if (literal?.text === ':memory:' && /^\s*[,)]/u.test(code.slice(literal.end))) continue;
    const line = lineAt(source, match.index);
    const declared = comments.some(comment => {
      const endLine = lineAt(source, comment.end);
      return (endLine === line || endLine === line - 1)
        && /@pullboard-board-file (?:persistence|locking|migration|journey): \S/u.test(source.slice(comment.start, comment.end));
    });
    if (!declared) found.push({ path, line, text: 'unclassified file board open; use fixtureBoard in memory or name its database boundary' });
  }
  return found;
}

/** Read test sources only; no board, Git process or test is opened by the lint. */
export function boardFileReport(root) {
  return walk(root, TEST_FILE).flatMap(path => boardFileOpens(readText(root, path), path));
}

/** Refuse a new file or growing debt in an existing file while conversions remove old debt. */
export function boardFileGrowth(problems, baseline) {
  const counts = new Map();
  return problems.filter(problem => {
    const count = (counts.get(problem.path) ?? 0) + 1;
    counts.set(problem.path, count);
    return count > (baseline[problem.path] ?? 0);
  });
}

/** Apply the debt ceiling to the real source scan without opening any board. */
export function boardFileProblems(root, baseline) {
  return boardFileGrowth(boardFileReport(root), baseline);
}

if (process.argv[1] && disk.exists(process.argv[1]) && disk.realpath(process.argv[1]) === disk.realpath(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const root = resolve(args.find(value => !value.startsWith('--')) ?? process.cwd());
  if (args.includes('--report')) report(boardFileReport(root));
  else report(boardFileProblems(root, BOARD_FILE_BASELINE));
}
