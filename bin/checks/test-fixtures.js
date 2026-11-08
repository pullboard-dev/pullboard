#!/usr/bin/env node
/** Test fixtures come from the kit: raw setup in tests is a ceiling that only falls [C7]. */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { lex } from './scan.js';
import { lineAt } from './scan.js';
import { readText } from './scan.js';
import { report } from './scan.js';
import { walk } from './scan.js';

const CEILINGS_URL = new URL('./test-fixtures.json', import.meta.url);
const TEST_SOURCE = /(?:^(?:test\/|packages\/[^/]+\/tests\/|apps\/[^/]+\/tests\/).*\.[cm]?js$|\.(?:test|spec)\.[cm]?js$)/u;
const KIT = /^test\/kit\//u;
const GIT_CALLEE = /(?<![\w$.])(?:git|tryGit|runFixtureGit|execFileSync|spawnSync)\s*\(\s*(?:[^,()]*,\s*)?\[?\s*(['"`])init\1/gu;
const RAW_CALL = /(?:((?:[\w$]+\s*\.\s*)*[\w$]*run[\w$]*)\s*\(\s*[^,()]+,\s*|\[\s*(?:BIN|bin|CLI)\s*,\s*)(['"`])(add|join)\2/gu;
const MODEL = /(['"`])--model\1\s*,\s*['"`]|\bPULLBOARD_MODEL\s*(?:\?\?=|\|\|=|=|:)\s*['"`]|\bmodel\s*:\s*['"`][^'"`]/gu;
const READ = /(?<![\w$])(?:readFileSync|readFile|readdirSync|readdir|existsSync|createReadStream|cpSync|copyFileSync)\s*\(/gu;
const ANCHOR = /import\s*\.\s*meta\s*\.\s*(?:url|dirname|filename)\b|(?<![\w$.])ROOT\b/u;
const HEX64 = /^[0-9a-f]{64}$/u;

/** The shared fixture helpers the messages point at; a test asserts each path exists. */
export const FIXTURE_HELPERS = {
  tempdir: 'test/fixture-child.js',
  'raw-cli': 'test/testkit-fixture.js',
  model: 'test/testkit-fixture.js',
};

const MESSAGES = {
  tempdir: `creates a temporary directory or repository outside the shared helpers; use privateFixtureFiles in ${FIXTURE_HELPERS.tempdir}`,
  'raw-cli': `adds an item or joins a seat with a raw CLI call; use fileFixtureItem or joinFixtureSeat in ${FIXTURE_HELPERS['raw-cli']}`,
  model: `passes a literal model string; use a model constant or joinFixtureSeat from ${FIXTURE_HELPERS.model}`,
  'repo-read': 'reads a repository file from the test own directory outside a world-pin comment; declare @pullboard-world-pin or use a fixture',
  hex64: 'holds a 64-character hex literal; keep it in a shared fixture helper or list it as a world pin',
};

/** Return the matching closing bracket offset in masked code, or the end of the code. */
function closingAt(code, open) {
  let depth = 0;
  for (let at = open; at < code.length; at++) {
    if ('([{'.includes(code[at])) depth++;
    else if (')]}'.includes(code[at]) && --depth === 0) return at;
  }
  return code.length;
}

/**
 * Find fixture-building sites in one test file, without running it.
 *
 * Why: one shared kit keeps fixtures passing the product's own rules; every raw site is a copy that drifts.
 *
 * @param {string} source - Test file text.
 * @param {string} path - Repo-relative path, used for the row and for the test/kit exemption.
 * @returns {{ path: string, line: number, kind: string, text: string }[]} Sites in line order.
 */
export function fixtureSites(source, path) {
  if (KIT.test(path)) return [];
  const { code, strings } = lex(source);
  const found = [];
  /** Record one site at an offset of the source. */
  const add = (at, kind) => found.push({ path, line: lineAt(source, at), kind, text: MESSAGES[kind] });
  /** True when the match starts on real code, not inside a string or comment. */
  const live = (match) => code.slice(match.index, match.index + 1) === source.slice(match.index, match.index + 1)
    && code[match.index] !== ' ';
  for (const match of code.matchAll(/\bmkdtemp(?:Sync)?\s*\(/gu)) add(match.index, 'tempdir');
  for (const match of source.matchAll(GIT_CALLEE)) if (live(match)) add(match.index, 'tempdir');
  for (const match of source.matchAll(RAW_CALL)) if (live(match) && !/git/iu.test(match[1] ?? '')) add(match.index, 'raw-cli');
  for (const match of source.matchAll(MODEL)) {
    if (!live(match)) continue;
    const line = source.slice(source.lastIndexOf('\n', match.index) + 1, match.index);
    if (/\bassert\b[\w.]*\s*\(/u.test(line)) continue; // an expected value in an assertion is not a fixture
    add(match.index, 'model');
  }
  if (!/@pullboard-world-pin\b/u.test(source)) {
    for (const match of code.matchAll(READ)) {
      const open = match.index + match[0].length - 1;
      if (ANCHOR.test(source.slice(open, closingAt(code, open)))) add(match.index, 'repo-read');
    }
  }
  for (const literal of strings) if (HEX64.test(literal.text) && !/^(.)\1+$/u.test(literal.text)) add(literal.start, 'hex64');
  return found.sort((left, right) => left.line - right.line || left.kind.localeCompare(right.kind));
}

/** Scan every test file under the root as text; nothing is imported or run. */
export function fixtureReport(root) {
  return walk(root, TEST_SOURCE).flatMap(path => fixtureSites(readText(root, path), path));
}

/** Count sites per file and kind, so removing one kind cannot pay for another. */
export function fixtureCounts(problems) {
  const counts = {};
  for (const { path, kind } of problems) {
    counts[path] ??= {};
    counts[path][kind] = (counts[path][kind] ?? 0) + 1;
  }
  return counts;
}

/** Sites past a file ceiling; a file or kind with no ceiling allows none. */
export function fixtureGrowth(problems, ceilings) {
  const seen = {};
  return problems.filter(problem => {
    const key = problem.path + ':' + problem.kind;
    seen[key] = (seen[key] ?? 0) + 1;
    return seen[key] > (ceilings[problem.path]?.[problem.kind] ?? 0);
  });
}

/**
 * The trunk commit this tree was composed on: the second parent of a merge HEAD (the gate merges main into the builder's
 * source), else null. Why: a ratchet written at one trunk must not blame an item for rows its trunk already carries [C7].
 */
export function compositionBase(root) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD^2^{commit}'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 && /^[0-9a-f]{40,64}$/u.test(result.stdout.trim()) ? result.stdout.trim() : null;
}

/** One file's text at the base commit, or null when the base does not have it. */
function baseText(root, base, path) {
  const result = spawnSync('git', ['show', `${base}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/**
 * The check: growth past the ceilings file as `path:line: text` rows. With a base commit, a file's allowance is the
 * greater of its committed ceiling and the count its own text has at the base, per kind, so only rows the submission
 * adds count; a file the base lacks has only its committed ceiling. The ceilings file is read, never changed.
 *
 * @param {string} root
 * @param {string | URL} [ceilingsPath]
 * @param {{ base?: string | null, read?: (root: string, base: string, path: string) => string | null }} [options]
 */
export function fixtureProblems(root, ceilingsPath = CEILINGS_URL, { base = compositionBase(root), read = baseText } = {}) {
  const committed = JSON.parse(readFileSync(ceilingsPath, 'utf8'));
  const problems = fixtureReport(root);
  let ceilings = committed;
  if (base && fixtureGrowth(problems, committed).length) {
    ceilings = { ...committed };
    for (const path of new Set(fixtureGrowth(problems, committed).map(row => row.path))) {
      const text = read(root, base, path);
      if (text === null) continue;
      const inherited = fixtureCounts(fixtureSites(text, path))[path] ?? {};
      const merged = { ...(committed[path] ?? {}) };
      for (const [kind, count] of Object.entries(inherited)) merged[kind] = Math.max(merged[kind] ?? 0, count);
      ceilings[path] = merged;
    }
  }
  return fixtureGrowth(problems, ceilings).map(({ path, line, kind, text }) => ({ path, line, text: `${kind}: ${text}` }));
}

/** Write today's counts as the ceilings, or lower them; growth over an existing file is returned and nothing is written. */
export function writeFixtureCeilings(root, ceilingsPath = CEILINGS_URL) {
  const problems = fixtureReport(root);
  const growth = existsSync(ceilingsPath) ? fixtureGrowth(problems, JSON.parse(readFileSync(ceilingsPath, 'utf8'))) : [];
  if (!growth.length) writeFileSync(ceilingsPath, JSON.stringify(fixtureCounts(problems), null, 2) + '\n');
  return growth.map(({ path, line, kind, text }) => ({ path, line, text: `${kind}: ${text}` }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv.slice(2).find(value => !value.startsWith('--')) ?? process.cwd());
  if (process.argv.includes('--report')) console.log(JSON.stringify(fixtureCounts(fixtureReport(root)), null, 2));
  else if (process.argv.includes('--write')) report(writeFixtureCeilings(root));
  else report(fixtureProblems(root));
}
