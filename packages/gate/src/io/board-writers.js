#!/usr/bin/env node
/**
 * The board-writer check: only the sequencer folder of the store package writes the board. Shipped source outside it
 * that holds BEGIN IMMEDIATE, an INSERT, UPDATE or DELETE on a board table, or a writable `new DatabaseSync` of
 * board.sqlite, is a site; today's sites are a per-file ceiling that only falls (#12614, part of #12611) [CD2,C7].
 */
import { fileSystemAdapter } from '../../../fs/index.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { STORE_REGISTRY } from './stores.js';
import { STORE_REGISTRY_URL } from './stores.js';
import { isStoreSource } from './stores.js';
import { lex } from './scan.js';
import { lineAt } from './scan.js';
import { readText } from './scan.js';
import { report } from './scan.js';
import { walk } from './scan.js';

/** Every file read and write goes through the file-system adapter [C7]. */
const fs = fileSystemAdapter();

export const BOARD_WRITER_RULE = 'board-write-outside-sequencer';
export const BOARD_WRITER_BASELINE = 'packages/gate/data/baselines/board-writers.json';
const BASELINE_URL = new URL('../../data/baselines/board-writers.json', import.meta.url);
/** The one folder allowed to write the board (the store package's sequencer, #12612). */
export const SEQUENCER_FOLDER = 'packages/store/src/io/board/write/';
/** SQL that writes a table, BEGIN IMMEDIATE, and the opening of a database, inside shipped source. */
const SQL_WRITE = /\b(?:INSERT(?:\s+OR\s+[A-Z]+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)\b/gu;
const BEGIN = /\bBEGIN\s+IMMEDIATE\b/gu;
const OPEN = /new\s+DatabaseSync\(/gu;

/** Whether a repo-relative path is shipped source outside the sequencer folder. */
export function isBoardWriterSource(path) {
  return isStoreSource(path) && !path.startsWith(SEQUENCER_FOLDER);
}

/** The text of the call whose open parenthesis ends `from`, up to its matching close (or the end of the source). */
function callText(source, from) {
  let depth = 1, index = from;
  while (index < source.length && depth > 0) { const char = source[index++]; if (char === '(') depth++; else if (char === ')') depth--; }
  return source.slice(from, index);
}

/**
 * The write sites of one source file, in line order: BEGIN IMMEDIATE, a SQL write on a board table, and a writable
 * open (no `readOnly: true`, not `:memory:`) in a file that names board.sqlite.
 *
 * @param {string} source
 * @param {string} path - Repo-relative.
 * @param {string[]} tables - Board table names.
 * @returns {{ path: string, line: number, what: string }[]}
 */
export function boardWriterSites(source, path, tables) {
  if (!isBoardWriterSource(path)) return [];
  const found = [];
  for (const string of lex(source).strings) {
    for (const match of string.text.matchAll(BEGIN)) found.push({ path, line: lineAt(source, string.start + 1 + match.index), what: 'BEGIN IMMEDIATE' });
    for (const match of string.text.matchAll(SQL_WRITE)) {
      if (tables.includes(match[1])) found.push({ path, line: lineAt(source, string.start + 1 + match.index), what: `SQL write on ${match[1]}` });
    }
  }
  if (/board\.sqlite/u.test(source)) {
    for (const match of source.matchAll(OPEN)) {
      const call = callText(source, match.index + match[0].length);
      if (!/readOnly\s*:\s*true/u.test(call) && !/^\s*['"`]:memory:/u.test(call)) found.push({ path, line: lineAt(source, match.index), what: 'writable open of board.sqlite' });
    }
  }
  return found.sort((left, right) => left.line - right.line);
}

/** The board table names of a parsed store registry. */
export function boardTables(registry) {
  return Object.keys(registry.stores ?? {}).filter(store => store.startsWith('table:')).map(store => store.slice(6));
}

/** Every site in the shipped source of a checkout. */
export function boardWriterReport(root, tables) {
  return walk(root, /^(?:apps|packages)\/[^/]+\/(?:src\/.+|[^/]+)\.[cm]?js$/u).filter(isBoardWriterSource).flatMap(path => boardWriterSites(readText(root, path), path, tables));
}

/** Sites per file, as `{ path: n }`. */
export function boardWriterCounts(sites) {
  const counts = {};
  for (const site of sites) counts[site.path] = (counts[site.path] ?? 0) + 1;
  return counts;
}

/** The sites past each file's ceiling: a file with no row has a ceiling of 0. */
export function boardWriterGrowth(sites, baseline) {
  const seen = {};
  const problems = [];
  for (const site of sites) {
    seen[site.path] = (seen[site.path] ?? 0) + 1;
    if (seen[site.path] > (baseline[site.path] ?? 0)) problems.push({ path: site.path, line: site.line, text: `${BOARD_WRITER_RULE}: ${site.what} outside ${SEQUENCER_FOLDER}; send the write through the sequencer` });
  }
  return problems;
}

/** Ceilings that rose against accepted main's baseline: it only falls. */
export function boardWriterBaselineGrowth(current, accepted) {
  return Object.entries(current).flatMap(([path, count]) => count > (accepted[path] ?? 0)
    ? [{ path: BOARD_WRITER_BASELINE, line: 1, text: `${BOARD_WRITER_RULE}: ${path} ${accepted[path] ?? 0} -> ${count}; the board-writer baseline may only fall` }] : []);
}

/**
 * The static check over changed files, read through the gate's candidate and main readers. A checkout without the
 * baseline (a project that is not this repository) has nothing to judge.
 *
 * @param {{ files: string[], sources: { file: string, source: string }[], text: (file: string) => string, previous: (file: string) => string }} context
 * @returns {string[]}
 */
export function boardWriterCheck({ files, sources, text, previous }) {
  let baseline;
  let tables;
  try { baseline = JSON.parse(text(BOARD_WRITER_BASELINE)); tables = boardTables(JSON.parse(text(STORE_REGISTRY))); } catch { return []; }
  const sites = sources.flatMap(row => boardWriterSites(row.source, row.file, tables));
  const problems = boardWriterGrowth(sites, baseline);
  if (files.includes(BOARD_WRITER_BASELINE) && previous(BOARD_WRITER_BASELINE)) problems.push(...boardWriterBaselineGrowth(baseline, JSON.parse(previous(BOARD_WRITER_BASELINE))));
  return problems.map(row => `${row.path}:${row.line}: ${row.text}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv.slice(2).find(value => !value.startsWith('--')) ?? process.cwd());
  const sites = boardWriterReport(root, boardTables(JSON.parse(fs.readFile(STORE_REGISTRY_URL, 'utf8'))));
  if (process.argv.includes('--write')) fs.writeFile(BASELINE_URL, JSON.stringify(boardWriterCounts(sites), null, 2) + '\n');
  else report(boardWriterGrowth(sites, JSON.parse(fs.readFile(BASELINE_URL, 'utf8'))));
}
