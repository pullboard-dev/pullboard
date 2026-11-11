/** Count selected native cases independently of the caller's public reporter [C7,S13]. */
import { isDefaultTestFile } from '../../../../codemap/light.js';
import { Refused } from '../../../../kernel/index.js';
import {
  gitExecFileSync,
  gitSpawnSync,
} from '../../../../git/index.js';
import {
  globSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

/** Read name-pattern options, skipping values with the runner's own Node option-arity parser. */
export function testSelectionPatterns(args, takesValue) {
  const patterns = [];
  for (let index = 0; index < args.length && args[index] !== '--'; index++) {
    if (!/^--test[-_]name[-_]pattern(?:=|$)/u.test(args[index])) {
      if (args[index].startsWith('-') && !args[index].includes('=') && takesValue(args[index])) index += 1;
      continue;
    }
    const value = args[index].includes('=') ? args[index].slice(args[index].indexOf('=') + 1) : args[++index];
    if (value !== undefined) patterns.push(value);
  }
  return patterns;
}

/** Whether a name, skip, only or shard option narrows the run, so its collection can never claim the full suite (#3158). */
export function narrowsSelection(args, takesValue) {
  return testSelectionPatterns(args, takesValue).length > 0 || args.some(arg => /^--test[-_](?:shard|skip[-_]pattern|only)(?:=|$)/u.test(arg));
}

/**
 * The caller's options for every landing shard: each option and its value exactly as written, in order, with only the
 * file selectors removed (positionals, and everything from `--` on), so timeouts, patterns, reporters and every other
 * option reach each shard unchanged and a shard runs what the unsharded gate would (#3158). Shard flags never get here:
 * landingFanOutFiles refuses them first. Values are skipped by the runner's own option arity, so a value that looks
 * like a path stays an option value.
 */
export function landingShardOptions(args, takesValue) {
  const options = [];
  for (let index = 0; index < args.length && args[index] !== '--'; index++) {
    if (!args[index].startsWith('-')) continue;
    options.push(args[index]);
    if (!args[index].includes('=') && takesValue(args[index]) && index + 1 < args.length) options.push(args[++index]);
  }
  return options;
}

/**
 * The landing fan-out's one file list: every selector expanded to real files the way the unsharded gate expands them
 * (test-file-dispatch: a glob matches sorted, a plain path stands for itself), each file once by resolved path, under
 * the caller's first spelling (an absolute one made repository-relative for remote runners), and each shard passes its
 * files after `--`, so a file named like an option stays a file (#3158). A caller shard flag (`--shard`, `--test-shard`, with or without a value) is refused, never
 * parsed: the lander never passes one, and the fan-out cannot honor it, so a run carrying one would run files the caller
 * excluded (#3158). Option values are skipped by the runner's own arity, so a pattern that looks like a flag is a pattern.
 */
export function landingFanOutFiles(files, args, root, takesValue) {
  if (typeof takesValue !== 'function') throw new TypeError('landingFanOutFiles needs the runner option-arity reader');
  for (let index = 0; index < args.length && args[index] !== '--'; index++) {
    if (/^--(?:test[-_])?shard(?:=|$)/u.test(args[index])) {
      throw new Refused('USAGE', `a sharded landing gate cannot also take ${args[index]}: the landing splits the files itself; drop the shard option, or set landingShards to 1`);
    }
    if (args[index].startsWith('-') && !args[index].includes('=') && takesValue(args[index])) index += 1;
  }
  const distinct = new Map();
  for (const selector of files) {
    const matches = /[?*[{]/u.test(selector) ? globSync(selector, { cwd: root }).sort() : [selector];
    if (!matches.length) throw new Error(`test file pattern matched no files: ${selector}`);
    for (const file of matches) if (!distinct.has(resolve(root, file))) distinct.set(resolve(root, file), isAbsolute(file) ? relative(root, file).split(sep).join('/') : file);
  }
  return [...distinct.values()];
}

/** The line a name-filtered landing shard prints with its matched case count; its controller sums them. */
export const SHARD_SELECTED_LINE = '# landing selected cases ';

/**
 * Whether a name-filtered sharded landing matched any case across all its shards; with no filter, always true. A
 * shard may match none of its own files, so only the sum can say NO_TESTS_MATCHED, and the controller writes it.
 */
export function shardSelectionMatched(args, outputs, write) {
  if (!args.some(arg => /^--test[-_]name[-_]pattern/u.test(arg))) return true;
  const cases = outputs.reduce((sum, output) => sum + [...String(output).matchAll(/^# landing selected cases (\d+)$/gmu)]
    .reduce((total, match) => total + Number(match[1]), 0), 0);
  if (!cases) write(`run-tests: NO_TESTS_MATCHED: the name filter ${JSON.stringify(args)} selected no proven test case in any landing shard\n`);
  return cases > 0;
}

/** A successful Node process cannot turn missing native selection evidence into a green check. */
export function selectedTestResult(result, record, patterns, files) {
  if (result.status !== 0 || !patterns.length) return result;
  let cases = 0;
  try { cases = JSON.parse(readFileSync(record, 'utf8')).cases; }
  catch { /* A missing or malformed internal reporter result fails closed. */ }
  // A name-filtered landing shard reports its count instead: its controller decides on the sum of every shard (#3158).
  if (process.env.PULLBOARD_LANDING_SHARD) { process.stdout.write(`${SHARD_SELECTED_LINE}${Number.isSafeInteger(cases) ? cases : 0}\n`); return result; }
  if (Number.isSafeInteger(cases) && cases > 0) return result;
  process.stderr.write(`run-tests: NO_TESTS_MATCHED: patterns ${JSON.stringify(patterns)} selected no proven test case in ${JSON.stringify(files)}\n`);
  return { ...result, status: 1 };
}

/** Only child-file summaries contain native case counts; the parent aggregate includes file wrappers. */
export default async function* recordSelectedTests(events) {
  let cases = 0;
  for await (const event of events) {
    if (event.type !== 'test:summary' || !event.data.file) continue;
    const count = event.data.counts?.tests;
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(cases + count)) throw new Error('native selected-test counts are unavailable');
    cases += count;
  }
  writeFileSync(process.env.PULLBOARD_TEST_SELECTION, JSON.stringify({ cases }), { mode: 0o600 });
}

export { isDefaultTestFile };

/** Preserve native discovery outside Git, but never hide a repository access failure. */
export function isGitWorkTree(cwd, env) {
  const result = gitSpawnSync(['rev-parse', '--is-inside-work-tree'], {
    cwd, env: { ...env, LC_ALL: 'C' }, encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status === 0) return result.stdout.trim() === 'true';
  if (result.status === 128 && /^fatal: not a git repository \(or any /u.test(result.stderr)) return false;
  throw new Error(result.stderr.trim() || `git rev-parse failed (status ${result.status})`);
}

/**
 * List repository test entry files, excluding helpers and worktree-only copies: tracked ones in a Git work tree, else the folder's own.
 * Why: Node's native discovery also runs every file under any `test/` folder, which now holds gate's own source.
 */
export function trackedDefaultTestFiles(cwd, env) {
  const output = isGitWorkTree(cwd, env) ? gitExecFileSync(['ls-files', '-z'], { cwd, env, encoding: 'utf8' })
    : readdirSync(cwd, { recursive: true }).join('\0');
  return output.split('\0').filter(path => path && isDefaultTestFile(path)).sort()
    .map(path => `./${path}`);
}

/** Translate the runner's shard option to Node's native test-shard option and refuse malformed ranges or an empty selection; option values skip by the runner's arity. */
export function shardArguments(args, takesValue, env = process.env) {
  if (typeof takesValue !== 'function') throw new TypeError('shardArguments needs the runner option-arity reader');
  const forwarded = [];
  let shard, all = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--all') { all = true; continue; }
    if (argument === '--') {
      forwarded.push(...args.slice(index));
      break;
    }
    if (argument === '--shard' || argument.startsWith('--shard=')) {
      if (shard !== undefined) return { error: `duplicate --shard; expected one <i>/<n> value` };
      shard = argument === '--shard' ? args[++index] : argument.slice('--shard='.length);
      if (shard === undefined) return { error: '--shard requires a value; expected <i>/<n> with 1 <= i <= n' };
      continue;
    }
    forwarded.push(argument);
    // An option's value is never read as an option, so a pattern like '--shard=2/2' stays a pattern (#3158).
    if (argument.startsWith('-') && !argument.includes('=') && takesValue(argument) && index + 1 < args.length) forwarded.push(args[++index]);
  }
  // A call that names no file would run the whole suite and hold runner slots for a quarter of an hour; the suite is
  // the gate's, the landing's and the audit's job (S10), and those runs carry a stage marker. Why: on 6 Nov a seat's
  // bare `node packages/gate/src/io/run/tests.js` starved every other seat's test run behind the gate queue. `--all` says it on purpose.
  if (!all && !hasTestFiles(forwarded, takesValue) && !env.PULLBOARD_TEST_STAGE && env.PULLBOARD_LANDING_RUN !== '1') {
    return { error: '[TEST_SELECTION_EMPTY] name the test files to run: node packages/gate/src/io/run/tests.js <file>...; the full suite runs at the gate, the landing and the audit, or by hand with --all' };
  }
  if (shard === undefined) return { args: forwarded };
  const match = shard.match(/^([1-9][0-9]*)\/([1-9][0-9]*)$/u);
  const index = match ? Number(match[1]) : NaN;
  const total = match ? Number(match[2]) : NaN;
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) {
    return { error: `invalid --shard value "${shard}"; expected <i>/<n> with 1 <= i <= n` };
  }
  return { args: [`--test-shard=${shard}`, ...forwarded] };
}

/** Distinguish file selection from option values so filtered discovery still takes a full-suite slot. */
export function hasTestFiles(args, optionTakesValue) {
  let takesValue = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (takesValue) { takesValue = false; continue; }
    if (argument === '--') return index < args.length - 1;
    if (argument.startsWith('-')) {
      if (!argument.includes('=')) takesValue = optionTakesValue(argument);
      continue;
    }
    return true;
  }
  return false;
}

/** Extract explicit test paths while skipping option values, returning an empty list for discovery. */
export function explicitTestFiles(args, optionTakesValue) {
  const files = [];
  let takesValue = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (takesValue) { takesValue = false; continue; }
    if (argument === '--') { files.push(...args.slice(index + 1)); break; }
    if (argument.startsWith('-')) {
      if (!argument.includes('=')) takesValue = optionTakesValue(argument);
      continue;
    }
    files.push(argument);
  }
  return files;
}
