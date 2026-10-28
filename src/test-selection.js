/** Count selected native cases independently of the caller's public reporter [C7,S13]. */
import {
  gitExecFileSync,
  gitSpawnSync,
} from './git-adapter.js';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';

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

/** A successful Node process cannot turn missing native selection evidence into a green check. */
export function selectedTestResult(result, record, patterns, files) {
  if (result.status !== 0 || !patterns.length) return result;
  let cases = 0;
  try { cases = JSON.parse(readFileSync(record, 'utf8')).cases; }
  catch { /* A missing or malformed internal reporter result fails closed. */ }
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

/** Select repository test entry files while keeping imported helpers out of direct discovery. */
export function isDefaultTestFile(path) {
  const normalized = path.replaceAll('\\', '/');
  if (normalized.split('/').some(part => part === 'node_modules' || part.startsWith('.'))) return false;
  return /(?:^|\/)[^/]+\.test\.(?:js|mjs)$/u.test(normalized);
}

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

/** List tracked repository test entry files, excluding helpers and worktree-only copies. */
export function trackedDefaultTestFiles(cwd, env) {
  const output = gitExecFileSync(['ls-files', '-z'], { cwd, env, encoding: 'utf8' });
  return output.split('\0').filter(path => path && isDefaultTestFile(path)).sort()
    .map(path => `./${path}`);
}

/** Translate the runner's shard option to Node's native test-shard option, refusing malformed ranges. */
export function shardArguments(args) {
  const forwarded = [];
  let shard;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
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
