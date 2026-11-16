#!/usr/bin/env node
/** Test fixtures come from the kit: raw setup in tests is a ceiling that only falls [C7]. */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { lex } from '../scan.js';
import { lineAt } from '../scan.js';
import { readText } from '../scan.js';
import { report } from '../scan.js';
import { walk } from '../scan.js';

const CEILINGS_URL = new URL('../../../data/tests/test-fixtures.json', import.meta.url);
const TEST_SOURCE = /(?:^(?:test\/|packages\/[^/]+\/tests\/|apps\/[^/]+\/tests\/).*\.[cm]?js$|\.(?:test|spec)\.[cm]?js$)/u;
const KIT = /^(?:apps\/cli\/tests\/fixtures\/kit\/|packages\/gate\/tests\/fixtures\/testkit\.js$|packages\/board\/tests\/fixtures\/board\.js$)|^packages\/store\/tests\/fixtures\/cell\.js$/u; // the kit itself holds the one raw seam [V32]
const GIT_CALLEE = /(?<![\w$.])(?:git|tryGit|runFixtureGit|execFileSync|spawnSync)\s*\(\s*(?:[^,()]*,\s*)?\[?\s*(['"`])init\1/gu;
const RAW_CALL = /(?:((?:[\w$]+\s*\.\s*)*[\w$]*run[\w$]*)\s*\(\s*([^,()]+),\s*|\[\s*(?:BIN|bin|CLI)\s*,\s*)(['"`])(add|join)\3/gu;
const MODEL = /(['"`])--model\1\s*,\s*['"`]|\bPULLBOARD_MODEL\s*(?:\?\?=|\|\|=|=|:)\s*['"`]|\bmodel\s*:\s*['"`][^'"`]/gu;
const READ = /(?<![\w$])(?:readFileSync|readFile|readdirSync|readdir|existsSync|createReadStream|cpSync|copyFileSync)\s*\(/gu;
const ANCHOR = /import\s*\.\s*meta\s*\.\s*(?:url|dirname|filename)\b|(?<![\w$.])ROOT\b/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const SPREAD_ENV = /\.\.\.\s*process\s*\.\s*env\b/gu;
const SPAWNS_CLI = /pullboard\.js/u; // a file that names the CLI entry spawns it
const POLICY_FILE = /pullboard\.json|SPEC\.md|cells-plan\.json|packages\/codemap\/data\/plan\/cells\.json|settings\.json/u;
const WRITE_FILE = /(?<![\w$])writeFileSync\s*\(/gu;
const RAW_BOARD = /(?<![\w$])openBoard\s*\(|(?<![\w$])(?:store|board)\s*\.\s*(?:addItem|register|submit)\s*\(/gu;
const FIXTURE_SUBJECT = /\/\/\s*fixture-subject:\s*addItem\b/u; // a store unit test of addItem itself
const SUBCOMMAND = /^\s*(['"`])[\w-]+\1\s*$/u; // run('lane', 'add', …): a quoted command word, not a checkout

/** The shared fixture helpers the messages point at; a test asserts each path exists. */
export const FIXTURE_HELPERS = {
  tempdir: 'packages/gate/tests/fixtures/child.js',
  'raw-cli': 'packages/gate/tests/fixtures/testkit.js',
  model: 'packages/gate/tests/fixtures/testkit.js',
  'hand-policy': 'packages/gate/tests/fixtures/testkit.js',
};

const MESSAGES = {
  tempdir: `creates a temporary directory or repository outside the shared helpers; use privateFixtureFiles in ${FIXTURE_HELPERS.tempdir}`,
  'raw-cli': `adds an item or joins a seat with a raw CLI call; use fileFixtureItem or joinFixtureSeat in ${FIXTURE_HELPERS['raw-cli']}`,
  model: `passes a literal model string; use a model constant or joinFixtureSeat from ${FIXTURE_HELPERS.model}`,
  'repo-read': 'reads a repository file from the test own directory outside a world-pin comment; declare @pullboard-world-pin or use a fixture',
  hex64: 'holds a 64-character hex literal; keep it in a shared fixture helper or list it as a world pin',
  'env-spread': 'spreads process.env next to a PULLBOARD_ key in a file that spawns apps/cli/pullboard.js; build the child environment with kit.env()',
  'hand-policy': `writes pullboard.json, SPEC.md, packages/codemap/data/plan/cells.json or settings.json by hand; declare the policy with fixtureProjectPolicy in ${FIXTURE_HELPERS['hand-policy']}`,
  'raw-board': 'opens a board or adds an item in process outside the kit; use kit.board(), or mark a store unit test of addItem with // fixture-subject: addItem',
};

/** The offset of the unmatched opening bracket before an offset in masked code, or -1 when it sits in no bracket. */
function enclosingOpen(code, at) {
  let depth = 0;
  for (let index = at - 1; index >= 0; index--) {
    if ('}])'.includes(code[index])) depth++;
    else if ('{(['.includes(code[index])) {
      if (depth === 0) return index;
      depth--;
    }
  }
  return -1;
}

/** The text of a call's first argument, from the opening parenthesis of masked code. */
function firstArgument(code, source, open) {
  let depth = 0;
  for (let at = open; at < code.length; at++) {
    if ('([{'.includes(code[at])) depth++;
    else if (')]}'.includes(code[at])) { if (--depth === 0) return source.slice(open + 1, at); }
    else if (code[at] === ',' && depth === 1) return source.slice(open + 1, at);
  }
  return source.slice(open + 1);
}

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
  for (const match of source.matchAll(RAW_CALL)) {
    if (live(match) && !/git/iu.test(match[1] ?? '') && !SUBCOMMAND.test(match[2] ?? '')) add(match.index, 'raw-cli');
  }
  for (const match of source.matchAll(MODEL)) {
    if (!live(match)) continue;
    const line = source.slice(source.lastIndexOf('\n', match.index) + 1, match.index);
    if (/\bassert\b[\w.]*\s*\(/u.test(line)) continue; // an expected value in an assertion is not a fixture
    add(match.index, 'model');
  }
  /** True when an assertion call opens before the offset on its line: an expected value is not a fixture. */
  const asserted = at => /\bassert\b[\w.]*\s*\(/u.test(source.slice(source.lastIndexOf('\n', at) + 1, at));
  if (SPAWNS_CLI.test(source)) {
    for (const match of code.matchAll(SPREAD_ENV)) {
      const open = enclosingOpen(code, match.index);
      if (open >= 0 && code[open] === '{' && /PULLBOARD_[A-Z0-9_]+/u.test(source.slice(open, closingAt(code, open))) && !asserted(match.index)) add(match.index, 'env-spread');
    }
  }
  for (const match of code.matchAll(WRITE_FILE)) {
    if (POLICY_FILE.test(firstArgument(code, source, match.index + match[0].length - 1)) && !asserted(match.index)) add(match.index, 'hand-policy');
  }
  if (!FIXTURE_SUBJECT.test(source)) for (const match of code.matchAll(RAW_BOARD)) if (!asserted(match.index)) add(match.index, 'raw-board');
  if (!/@pullboard-world-pin\b/u.test(source)) {
    for (const match of code.matchAll(READ)) {
      const open = match.index + match[0].length - 1;
      if (ANCHOR.test(source.slice(open, closingAt(code, open)))) add(match.index, 'repo-read');
    }
  }
  for (const literal of strings) if (HEX64.test(literal.text) && !/^(.)\1+$/u.test(literal.text)) add(literal.start, 'hex64');
  return found.sort((left, right) => left.line - right.line || left.kind.localeCompare(right.kind));
}

/**
 * Scan every test file under the root as text; nothing is imported or run.
 *
 * @param {string} root
 * @param {{ sitesOf?: (path: string, text: string) => ReturnType<typeof fixtureSites> }} [options] - `sitesOf` lets a caller answer a file's sites from a cache keyed by its text.
 */
export function fixtureReport(root, { sitesOf = (path, text) => fixtureSites(text, path), only = null } = {}) {
  return (only ? only.filter(path => TEST_SOURCE.test(path) && existsSync(join(root, path))).sort() : walk(root, TEST_SOURCE)).flatMap(path => sitesOf(path, readText(root, path)));
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
 * source), or the first parent of a land merge (subject `Merge #N onto main`: HEAD^1 is the trunk, HEAD^2 the item tip), else the point where this tree last met main (a branch that merged main and then committed has no merge HEAD),
 * else null. Why: a ratchet written at one trunk must not blame an item for rows its trunk already carries [C7,#8368].
 */
export function compositionBase(root) {
  const commit = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    return result.status === 0 && /^[0-9a-f]{40,64}$/u.test(result.stdout.trim()) ? result.stdout.trim() : null;
  };
  const second = commit(['rev-parse', '--verify', '--quiet', 'HEAD^2^{commit}']);
  if (second) {
    const subject = spawnSync('git', ['log', '-1', '--format=%s', 'HEAD'], { cwd: root, encoding: 'utf8' });
    const landMerge = subject.status === 0 && /^Merge #\d+ onto main\b/u.test(subject.stdout.trim());
    return landMerge ? commit(['rev-parse', '--verify', '--quiet', 'HEAD^1^{commit}']) : second;
  }
  const met = commit(['merge-base', 'HEAD', 'refs/heads/main']);
  return met && met !== commit(['rev-parse', 'HEAD']) ? met : null;
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
 * @param {{ base?: string | null, read?: (root: string, base: string, path: string) => string | null, sitesOf?: (path: string, text: string) => ReturnType<typeof fixtureSites> }} [options]
 */
export function fixtureProblems(root, ceilingsPath = CEILINGS_URL, { base = compositionBase(root), read = baseText, sitesOf, only = null } = {}) {
  const committed = JSON.parse(readFileSync(ceilingsPath, 'utf8'));
  const problems = fixtureReport(root, { ...(sitesOf ? { sitesOf } : {}), only });
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

/**
 * The same growth as fixtureProblems, judged on just the named files and read through `text`, so the commit hook can
 * judge staged bytes in milliseconds. A file's allowance is the greater of its ceiling and the count its own text has at
 * `previous` (accepted main, '' when main lacks it), as the gate's composition base allows. Paths the gate's tree walk
 * would skip are skipped here too [C7].
 *
 * @param {string[]} files - Repo-relative changed or staged paths.
 * @param {{ text: (path: string) => string, previous: (path: string) => string, ceilings: () => Record<string, Record<string, number>> }} options
 *   `ceilings` is read only when a named file is a test source, so a commit with no test files reads and scans nothing.
 * @returns {{ path: string, line: number, text: string }[]} The rows the gate static stage prints, as `kind: message`.
 */
export function fixtureGrowthIn(files, { text, previous, ceilings }) {
  const tests = files.filter(path => TEST_SOURCE.test(path) && !path.split('/').some(part => part === 'node_modules' || part === 'work' || part.startsWith('.')));
  if (!tests.length) return [];
  const committed = ceilings();
  const problems = tests.flatMap(path => fixtureSites(text(path), path));
  const allowed = { ...committed };
  for (const path of new Set(fixtureGrowth(problems, committed).map(row => row.path))) {
    const inherited = fixtureCounts(fixtureSites(previous(path), path))[path] ?? {};
    const merged = { ...(committed[path] ?? {}) };
    for (const [kind, count] of Object.entries(inherited)) merged[kind] = Math.max(merged[kind] ?? 0, count);
    allowed[path] = merged;
  }
  return fixtureGrowth(problems, allowed).map(({ path, line, kind, text: message }) => ({ path, line, text: `${kind}: ${message}` }));
}

/**
 * Write today's counts as the ceilings, or lower them; growth over an existing file is returned and nothing is written.
 * A kind the ceilings file has never recorded is new to the scanner, so its first counts are written as they stand.
 */
export function writeFixtureCeilings(root, ceilingsPath = CEILINGS_URL) {
  const problems = fixtureReport(root);
  let growth = [];
  if (existsSync(ceilingsPath)) {
    const committed = JSON.parse(readFileSync(ceilingsPath, 'utf8'));
    const known = new Set(Object.values(committed).flatMap(row => Object.keys(row)));
    growth = fixtureGrowth(problems.filter(problem => known.has(problem.kind)), committed);
  }
  if (!growth.length) writeFileSync(ceilingsPath, JSON.stringify(fixtureCounts(problems), null, 2) + '\n');
  return growth.map(({ path, line, kind, text }) => ({ path, line, text: `${kind}: ${text}` }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv.slice(2).find(value => !value.startsWith('--')) ?? process.cwd());
  if (process.argv.includes('--report')) console.log(JSON.stringify(fixtureCounts(fixtureReport(root)), null, 2));
  else if (process.argv.includes('--write')) report(writeFixtureCeilings(root));
  else report(fixtureProblems(root));
}
