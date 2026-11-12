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
const NODE_OR_CLI_TEXT = /['"`]node['"`]|\bnode\s|pullboard\.js\b/u;
/** Node or the CLI named by an identifier, read with strings masked so '/bin/sh' and 'bin/*.js' are not the `bin` entry. */
const NODE_OR_CLI_NAME = /\bexecPath\b|pullboard(?:Bin|Cli|Entry)|\b(?:BIN|CLI|CLI_ENTRY|ENTRY|cli|bin)\b/u;
/** The pullboard CLI named in a launch's text or by identifier; any other node child (run-tests, node --test, script mains, -e) is not a CLI launch. */
const CLI_TEXT = /pullboard\.js/u;
const CLI_NAME = /pullboard(?:Bin|Cli|Entry)|\b(?:BIN|CLI|CLI_ENTRY|ENTRY|cli|bin)\b/u;
/** Any call on a box (`box` is the kit's own name); the member counts only when its helper starts a process. */
const BOX_CALL = /(?<![\w$.])box\s*\.\s*([\w$]+)\s*\(/gu;
/** The kit box members that run the CLI as a child process (apps/cli/tests/fixtures/e2e.js), for a box the test file does not build itself. */
const KIT_LAUNCH = new Set(['run', 'runAs', 'cli', 'cliAt', 'runGate', 'launch']);
/** A bare call of a name, not a member call; the name is the helper a local closure may define. */
const BARE_CALL = /(?<![\w$.])([\w$]+)\s*\(/gu;

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
  const add = (at, target) => found.push({ path, line: lineAt(source, at), kind: 'launch', target, text: MESSAGE });
  for (const at of spawnSites(source, code, 0, code.length)) {
    const open = code.indexOf('(', at);
    const close = closingAt(code, open);
    add(at, CLI_TEXT.test(source.slice(open, close)) || CLI_NAME.test(code.slice(open, close)) ? 'cli' : 'other');
  }
  const launches = launchReach(source, code);
  for (const match of code.matchAll(BOX_CALL)) if (launches(match[1], true, match.index, match.index + match[0].length - 1)) add(match.index, 'cli');
  return found.sort((left, right) => left.line - right.line);
}

/** Offsets of direct child-process calls of node or the CLI within [from, to) of masked code. */
function spawnSites(source, code, from, to) {
  const sites = [];
  for (const match of code.slice(from, to).matchAll(SPAWN)) {
    const open = from + match.index + match[0].length - 1;
    if (namesNodeOrCli(source, code, open)) sites.push(from + match.index);
  }
  return sites;
}

/** Whether the call whose argument list opens at `open` names node or the CLI entry. */
function namesNodeOrCli(source, code, open) {
  const close = closingAt(code, open);
  return NODE_OR_CLI_TEXT.test(source.slice(open, close)) || NODE_OR_CLI_NAME.test(code.slice(open, close));
}

/** The end of the expression starting at `start`: the first `,` `;` or unopened closer at depth 0, or a line end not after `=>`. */
function expressionEnd(code, start) {
  let depth = 0;
  for (let at = start; at < code.length; at++) {
    const char = code[at];
    if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) { if (depth === 0) return at; depth--; }
    else if (depth === 0 && (char === ',' || char === ';')) return at;
    else if (depth === 0 && char === '\n' && !code.slice(start, at).trimEnd().endsWith('=>')) return at;
  }
  return code.length;
}

/** The span from `start` to the end of a function body whose parameter list opens at `start - 1`. */
function bodySpan(code, start) {
  const body = code.indexOf('{', closingAt(code, start - 1));
  return [start, body < 0 ? code.length : closingAt(code, body) + 1];
}

/**
 * The span of masked code that defines local closure `name` (`function name(` or `const name =`) as seen from `at`:
 * the nearest definition before it, else the first after; none when the file never defines it.
 */
function closureSpans(code, word, at) {
  const spans = [];
  for (const match of code.matchAll(new RegExp(`(?<![\\w$.])(?:function\\s*\\*?\\s*${word}\\s*\\(|(?:const|let|var)\\s+${word}\\s*=(?!=))`, 'gu'))) {
    const start = match.index + match[0].length;
    spans.push({ at: match.index, span: match[0].endsWith('(') ? bodySpan(code, start) : [start, expressionEnd(code, start)] });
  }
  const nearest = spans.findLast(row => row.at < at) ?? spans.find(row => row.at > at);
  return nearest ? [nearest.span] : [];
}

/** The parameter names of the helper whose span starts at `from`: after `function name(`, or an arrow or function value. */
function paramNames(code, from) {
  let params = '';
  if (code[from - 1] === '(') params = code.slice(from, closingAt(code, from - 1));
  else {
    const head = code.slice(from).match(/^\s*(?:async\s*)?(?:function\s*\*?\s*[\w$]*\s*)?(\(|[\w$]+\s*=>)/u);
    if (head?.[1] === '(') { const open = from + head[0].length - 1; params = code.slice(open, closingAt(code, open)); }
    else if (head) params = head[1];
  }
  return new Set(params.match(/[\w$]+/gu) ?? []);
}

/**
 * The spans of masked code that define helper `name`: as an object member (`name:`, `name() {` or shorthand `name`
 * standing for its closure) when `member`, else as a local closure.
 *
 * Why: a box member is judged by what its helper does, so a renamed helper keeps the count its body earns; a closure
 * that is never put on an object does not shadow the kit's member of the same name.
 */
function helperSpans(code, name, member, scopes, at) {
  const word = name.replaceAll('$', '\\$');
  if (!member) return closureSpans(code, word, at);
  /** Whether a member definition sits inside the box's builder. */
  const inside = at => scopes.some(([from, to]) => at >= from && at < to);
  const spans = [];
  for (const match of code.matchAll(new RegExp(`(?<=[{,]\\s*)${word}\\s*:(?!:)`, 'gu'))) {
    const start = match.index + match[0].length;
    if (inside(match.index)) spans.push([start, expressionEnd(code, start)]);
  }
  for (const match of code.matchAll(new RegExp(`(?<=[{,]\\s*)(?:async\\s+)?${word}\\s*\\(`, 'gu'))) {
    const close = closingAt(code, match.index + match[0].length - 1);
    if (inside(match.index) && /^\s*\{/u.test(code.slice(close + 1))) spans.push(bodySpan(code, match.index + match[0].length));
  }
  for (const match of code.matchAll(new RegExp(`(?<=[{,]\\s*)${word}(?=\\s*[,}])`, 'gu'))) {
    if (inside(match.index)) spans.push(...closureSpans(code, word, match.index));
  }
  return spans;
}

/** A `box =` binding and the callee that builds it, e.g. `const box = fixture(t)` or `box = helpers.project('true')`. */
const BOX_BINDING = /(?<![\w$.])box\s*=(?![=>])\s*(?:await\s+)?([\w$.]+)\s*\(/gu;

/**
 * Judge calls by what the called helper does: `launches(name, member, at, open)` says whether the call at `at`, with its
 * argument list opening at `open`, starts node or the CLI as a child process, whatever the helper is called.
 *
 * Why: the ratchet must key on behaviour, so renaming box.cli to box.inProcess while it still spawns keeps its count,
 * and a helper that truly runs the CLI in this process (runCliInProcess, main) never counts. A helper that starts
 * whatever command it is handed launches the CLI when the call names node or the CLI. A box member the file never
 * builds falls back to the kit's spawning members.
 */
function launchReach(source, code) {
  const memo = new Map();
  const bindings = [...code.matchAll(BOX_BINDING)].map(match => ({ at: match.index, callee: match[1] }));
  /**
   * The builder spans of the box a call at `at` uses: the nearest `box =` before it (else after), built by a local
   * fixture; null for a kit box built by an imported helper; the whole file when the file never binds `box`.
   */
  const boxScopes = at => {
    const binding = bindings.findLast(row => row.at < at) ?? bindings.find(row => row.at > at);
    if (!binding) return [[0, code.length]];
    const spans = /^[\w$]+$/u.test(binding.callee) ? closureSpans(code, binding.callee.replaceAll('$', '\\$'), binding.at) : [];
    return spans.length ? spans : null;
  };
  /**
   * What calling helper `name` does: 'cli' when it launches node or the CLI itself, 'process' when it starts a
   * command it is handed, 'kit' for an unbuilt kit member, or null; a helper being resolved counts as null.
   */
  const effect = (name, member, at) => {
    const scopes = member ? boxScopes(at) : null;
    const spans = member && !scopes ? [] : helperSpans(code, name, member, scopes, at);
    const key = `${member}:${name}:${JSON.stringify(spans)}`;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, null);
    const effects = spans.map(([from, to]) => spanEffect(from, to));
    const result = !spans.length ? (member && KIT_LAUNCH.has(name) ? 'cli' : null)
      : effects.includes('cli') ? 'cli' : effects.includes('process') ? 'process' : null;
    memo.set(key, result);
    return result;
  };
  /** Whether the call at `at` whose argument list opens at `open` launches node or the CLI. */
  const launches = (name, member, at, open) => {
    const done = effect(name, member, at);
    return done === 'cli' || (done === 'process' && namesNodeOrCli(source, code, open));
  };
  /** What a helper body does: a direct launch or a launching call is 'cli'; any other child-process start is 'process'. */
  const spanEffect = (from, to) => {
    const body = code.slice(from, to);
    if (spawnSites(source, code, from, to).length) return 'cli';
    const alias = body.match(/^\s*(?:(box)\s*\.\s*)?([\w$]+)\s*$/u);
    if (alias) return effect(alias[2], Boolean(alias[1]), from);
    const params = paramNames(code, from);
    for (const [pattern, member] of [[BOX_CALL, true], [BARE_CALL, false]]) {
      for (const match of body.matchAll(pattern)) {
        if (!member && params.has(match[1])) continue;
        if (launches(match[1], member, from + match.index, from + match.index + match[0].length - 1)) return 'cli';
      }
    }
    return [...body.matchAll(SPAWN)].length ? 'process' : null;
  };
  return launches;
}

/** Inspect every test file as text; `cache` keeps a file's sites by blob. */
export function cliLaunchReport(root, { cache = null } = {}) {
  return walk(root, JOURNEY).flatMap(path => {
    const text = readText(root, path);
    return cache ? cache.get(path, blobOid(text), () => cliLaunchSites(text, path)) : cliLaunchSites(text, path);
  });
}

/**
 * Split launches into pullboard CLI launches and other child processes, per file and in total.
 *
 * Why: the 0.9.4 goal counts only real CLI launches; the ceilings in cli-launches.json still cover both (#5946).
 *
 * @param {{ path: string, target: string }[]} problems - Sites from cliLaunchReport.
 * @returns {{ files: Record<string, { cli: number, other: number }>, totals: { cli: number, other: number } }}
 */
export function cliLaunchSplit(problems) {
  const files = {};
  const totals = { cli: 0, other: 0 };
  for (const { path, target } of problems) {
    files[path] ??= { cli: 0, other: 0 };
    files[path][target]++;
    totals[target]++;
  }
  return { files, totals };
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
  if (process.argv.includes('--split')) {
    const { files, totals } = cliLaunchSplit(problems);
    for (const [path, row] of Object.entries(files)) console.log(`${path}: pullboard CLI launches ${row.cli}, other child processes ${row.other}`);
    console.log(`total: pullboard CLI launches ${totals.cli}, other child processes ${totals.other}`);
  } else if (process.argv.includes('--report')) console.log(JSON.stringify(cliLaunchCounts(problems), null, 2));
  else if (process.argv.includes('--write')) writeFileSync(BASELINE_URL, JSON.stringify(cliLaunchCounts(problems), null, 2) + '\n'); // first record only
  else {
    const baseline = JSON.parse(readFileSync(BASELINE_URL, 'utf8'));
    if (process.argv.includes('--ratchet')) writeFileSync(BASELINE_URL, JSON.stringify(tightenCliLaunchBaseline(problems, baseline), null, 2) + '\n');
    else report(cliLaunchGrowth(problems, baseline));
  }
}
