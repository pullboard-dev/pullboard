#!/usr/bin/env node
/** CLI launches in tests (journeys most) are a ceiling that only falls: convert to runCliInProcess, never add a process [C7]. */
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { blobOid } from '../static/cache.js';
import { lex } from '../scan.js';
import { lineAt } from '../scan.js';
import { readText } from '../scan.js';
import { report } from '../scan.js';
import { walk } from '../scan.js';

const BASELINE_URL = new URL('../../../data/baselines/cli-launches.json', import.meta.url);
const JOURNEY = /^(?:apps|packages)\/.*\.test\.[cm]?js$/u; // every test file, journeys included; the fixture kit that holds the one spawn seam is not a test file
const MESSAGE = 'launches the CLI or a node child process; call runCliInProcess or captureCommandInProcess from apps/cli/tests/fixtures/process.js';
/** Direct child-process calls; a launch only when the call names node or the CLI entry (git, sh and tar calls are not). */
const SPAWN = /(?<![\w$])(?:(?:[\w$]+\s*\.\s*)?(?:spawnSync|execFileSync|execFile|execSync|spawn|fork)|runFixtureChild|runFixtureChildAsync|startFixtureChild|runFixtureExecFile|runFixtureExec)\s*\(/gu;
/** Node or the CLI named in the call's text: a `node` string or the CLI entry file. */
const NODE_OR_CLI_TEXT = /['"`]node['"`]|\bnode\s|pullboard\.js/u;
/** Node or the CLI named by an identifier, read with strings masked so '/bin/sh' and 'bin/*.js' are not the `bin` entry. */
const NODE_OR_CLI_NAME = /\bexecPath\b|pullboard(?:Bin|Cli|Entry)|\b(?:BIN|CLI|CLI_ENTRY|ENTRY|cli|bin)\b/u;
/** The kit box methods that run the CLI as a child process (apps/cli/tests/fixtures/e2e.js); `box` is the kit's own name. */
const BOX_LAUNCH = /(?<![\w$.])box\s*\.\s*(?:run|runAs|cli|cliAt|runGate|launch)\s*\(/gu;

/** The offset of the bracket closing the one opened at `open` in masked code. */
function closingAt(code, open) {
  let depth = 0;
  for (let at = open; at < code.length; at++) {
    if ('([{'.includes(code[at])) depth++;
    else if (')]}'.includes(code[at]) && --depth === 0) return at;
  }
  return code.length;
}

/**
 * Find call sites in one test file (journeys first) that start the CLI or a node child process, without running it.
 *
 * Why: each launch costs ~1.1 s of startup and loads the runner; the in-process runner (item 1417) answers the same call.
 *
 * @param {string} source - Journey file text.
 * @param {string} path - Repo-relative path; only test files under apps/ and packages/ have sites.
 * @returns {{ path: string, line: number, kind: string, text: string }[]} Sites in line order.
 */
export function cliLaunchSites(source, path) {
  if (!JOURNEY.test(path)) return [];
  const { code } = lex(source);
  const found = [];
  /** Record one site at an offset of the source. */
  const add = at => found.push({ path, line: lineAt(source, at), kind: 'launch', text: MESSAGE });
  for (const match of code.matchAll(SPAWN)) {
    const open = match.index + match[0].length - 1;
    const close = closingAt(code, open);
    if (NODE_OR_CLI_TEXT.test(source.slice(open, close)) || NODE_OR_CLI_NAME.test(code.slice(open, close))) add(match.index);
  }
  for (const match of code.matchAll(BOX_LAUNCH)) add(match.index);
  return found.sort((left, right) => left.line - right.line);
}

/** Inspect every test file as text; `cache` keeps a file's sites by blob. */
export function cliLaunchReport(root, { cache = null } = {}) {
  return walk(root, JOURNEY).flatMap(path => {
    const text = readText(root, path);
    return cache ? cache.get(path, blobOid(text), () => cliLaunchSites(text, path)) : cliLaunchSites(text, path);
  });
}

/** Count launches per file, as `{ path: { launch: n } }` like the other ceiling baselines. */
export function cliLaunchCounts(problems) {
  const counts = {};
  for (const { path, kind } of problems) {
    counts[path] ??= {};
    counts[path][kind] = (counts[path][kind] ?? 0) + 1;
  }
  return counts;
}

/** Sites past a file ceiling; a file with no ceiling, a new test file included, allows none. */
export function cliLaunchGrowth(problems, baseline) {
  const seen = {};
  return problems.filter(problem => {
    seen[problem.path] = (seen[problem.path] ?? 0) + 1;
    return seen[problem.path] > (baseline[problem.path]?.launch ?? 0);
  });
}

/** The updater only lowers ceilings: it refuses before writing when any file has grown. */
export function tightenCliLaunchBaseline(problems, baseline) {
  const growth = cliLaunchGrowth(problems, baseline);
  if (growth.length) throw new Error(growth.map(row => `${row.path}:${row.line}: ${row.text}`).join('\n'));
  return cliLaunchCounts(problems);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv.slice(2).find(value => !value.startsWith('--')) ?? process.cwd());
  const problems = cliLaunchReport(root);
  if (process.argv.includes('--report')) console.log(JSON.stringify(cliLaunchCounts(problems), null, 2));
  else if (process.argv.includes('--write')) writeFileSync(BASELINE_URL, JSON.stringify(cliLaunchCounts(problems), null, 2) + '\n'); // first record only
  else {
    const baseline = JSON.parse(readFileSync(BASELINE_URL, 'utf8'));
    if (process.argv.includes('--ratchet')) writeFileSync(BASELINE_URL, JSON.stringify(tightenCliLaunchBaseline(problems, baseline), null, 2) + '\n');
    else report(cliLaunchGrowth(problems, baseline));
  }
}
